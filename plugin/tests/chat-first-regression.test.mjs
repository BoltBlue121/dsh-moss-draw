import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createStudioStore} from '../src/studio-store.mjs';
import {emptyStudioDoc} from '../src/studio-domain.mjs';
import {registerTools} from '../src/tools.mjs';

const sdkPath = process.env.MOSS_SDK_PACKAGE;

// Real installed native projection + real tools/store. Only the GPU/network boundary is a spy.
async function fixture(t) {
  const require = createRequire(sdkPath);
  const {Context} = require('@deepseek-ai/cordis');
  const {SessionProjectionRegistry} = require('@deepseek-ai/dsh-session-projection');
  const {Session} = require('@deepseek-ai/dsh-session');
  const host = new Context();
  new SessionProjectionRegistry(host);
  t.after(() => host.fiber.dispose());
  const root = await mkdtemp(path.join(tmpdir(), 'consent-conversation-regression-'));
  t.after(async () => {
    assert.equal(path.dirname(root), tmpdir());
    assert.ok(path.basename(root).startsWith('consent-conversation-regression-'));
    await rm(root, {recursive: true, force: true});
  });
  const store = createStudioStore({dataRoot: root});
  const session = Session.create(`consent-conversation-${randomUUID()}`);
  const definitions = new Map();
  const counters = {human: 0, requests: 0, submissions: 0};
  registerTools({sessionProjections: host.sessionProjections, tools: {register: d => definitions.set(d.name, d)}}, {
    sdk: {tools: require('@deepseek-ai/dsh-tools')},
    getService: () => ({dataRoot: root, studio: store, service: {
      context: async () => ({runs: []}),
      generate: async request => {
        counters.submissions++;
        assert.equal(request.backend, 'moss');
        assert.equal(request.mode, 't2i');
        return {run_id: randomUUID(), status: 'running'};
      },
    }}),
    config: {workspaceRoot: root, dataRoot: root, editEngine: 'native'},
    attachments: {}, readGuide: async () => ({}),
  });
  const exec = {agent: {id: session.id, session}, signal: new AbortController().signal};
  const human = text => {
    counters.human++;
    session.append('user/message', {id: randomUUID(), role: 'user', source: {kind: 'user'},
      content: [{type: 'text', text}]}, {surfaceOp: 'append'});
  };
  const say = text => session.append('assistant/message', {message: {
    id: randomUUID(), role: 'assistant', source: {kind: 'model', provider: 'fixture', model: 'fixture'},
    content: [{type: 'text', text}],
  }}, {surfaceOp: 'append'});
  const call = async input => {
    const callId = randomUUID();
    if (input.workbench?.action === 'studioRequestConsent') counters.requests++;
    session.append('tool/call', {callId, name: 'art_generate', arguments: JSON.stringify(input)});
    try {
      const value = await definitions.get('art_generate').execute(input, exec);
      session.append('tool/result', {message: {id: randomUUID(), role: 'tool', source: {kind: 'tool', callId},
        toolCallId: callId, isError: false, content: [{type: 'text', text: JSON.stringify(value)}]}}, {surfaceOp: 'append'});
      return value;
    } catch (error) {
      session.append('tool/result', {message: {id: randomUUID(), role: 'tool', source: {kind: 'tool', callId},
        toolCallId: callId, isError: true, content: [{type: 'text', text: error.message}]}}, {surfaceOp: 'append'});
      throw error;
    }
  };
  const series = await store.createSeries({title: 'Isolated conversation fixture'});
  const doc = emptyStudioDoc();
  doc.layout.summary.caption = 'Original study';
  doc.layout.items = [{id: 'hero', label: 'character', caption: 'Unchanged costume', bbox: [100, 100, 700, 900]}];
  let page = await store.createPage({series_id: series.series_id, title: '服设校准', doc});
  const start = async () => {
    await call({mode: 'workbench', workbench: {action: 'studioStart', page_id: page.page_id,
      expected_revision: page.revision, intent: 'Original drawing request', max_runs: 1}});
    page = await store.getPage({page_id: page.page_id});
  };
  const ask = async generation => {
    const next = structuredClone(page.doc);
    next.layout.summary.caption = 'A quieter study';
    page = await store.propose({page_id: page.page_id, expected_revision: page.revision,
      doc: next, summary: 'Only the background description changes'});
    return call({mode: 'workbench', workbench: {
      action: 'studioRequestConsent', page_id: page.page_id, expected_revision: page.revision, request_key: 'single-question',
      operations: {
        proposal: {proposal_id: page.proposals.at(-1).proposal_id, accept: ['layout.summary'], reject: false},
        resume: false, exit_text_only: false,
        generation: generation ? {mode: 'use_remaining', runs: 0, backend: 'moss', intent: ''}
          : {mode: 'none', runs: 0, backend: null, intent: ''},
        continue_generation: generation,
      },
    }});
  };
  const prepare = async () => {
    const current = await store.getPage({page_id: page.page_id});
    return call({mode: 'workbench', workbench: {action: 'studioPrepare', page_id: current.page_id,
      expected_revision: current.revision, request_key: 'one-plan', settings: {backend: 'moss', seed: 42}, references: []}});
  };
  return {store, call, human, say, start, ask, prepare, counters, series, doc, page: () => page, select: value => {page=value;}};
}

const sdk = {skip: !sdkPath};
const wb = (f, action, args={}) => f.call({mode:'workbench',workbench:{action,...args}});
test('a Doc can be sent as a structure instead of hand-written JSON',sdk,async t=>{
 const f=await fixture(t); f.human('继续画一版'); await f.start();
 // Hand-written JSON is how a long Doc dies: one missing bracket loses the page.
 // The tool accepts the structure itself, so the model never has to stringify.
 const objectPage=await wb(f,'studioCreatePage',{series_id:f.series.series_id,title:'Object doc',doc:structuredClone(f.doc)});
 assert.equal(objectPage.doc.kind,f.doc.kind);
 const current=await f.store.getPage({page_id:objectPage.page_id});
 const next=structuredClone(current.doc); next.layout.summary.caption='Object form updated';
 const updated=await wb(f,'studioAgentUpdate',{page_id:objectPage.page_id,expected_revision:current.revision,doc:next});
 assert.equal(updated.doc.layout.summary.caption,'Object form updated');
 // The string form still works for older clients and cached examples.
 const stringPage=await wb(f,'studioCreatePage',{series_id:f.series.series_id,title:'String doc',doc_json:JSON.stringify(f.doc)});
 assert.equal(stringPage.doc.kind,f.doc.kind);
});
test('P1 proposal-only pending does not lock new P2 native drawing request',sdk,async t=>{
 const f=await fixture(t); f.human('先审背景'); await f.start(); await f.ask(false);
 f.human('继续画，画一个工口蹲姿，这个角色的');
 const p=await wb(f,'studioCreatePage',{series_id:f.series.series_id,title:'P2',doc_json:JSON.stringify(f.doc)}); f.select(p);
 await f.start(); const current=await f.store.getPage({page_id:p.page_id}); const doc=structuredClone(current.doc); doc.layout.summary.caption='New scene';
 await wb(f,'studioAgentUpdate',{page_id:p.page_id,expected_revision:current.revision,doc_json:JSON.stringify(doc)});
 const plan=await f.prepare(); await wb(f,'studioExecute',{plan_id:plan.plan_id});
 assert.equal(f.counters.requests,1); assert.equal(f.counters.submissions,1);
 assert.equal((await f.store.consentState({})).consent.status,'stale');
});
test('doit stales pending same-page consent and starts without questions',sdk,async t=>{
 const f=await fixture(t); f.human('先审背景'); await f.ask(false); f.human('doit'); await f.start();
 assert.equal((await f.store.consentState({})).consent.status,'stale');
});
test('Agent resolves its own proposal in chat then starts',sdk,async t=>{
 const f=await fixture(t); f.human('采纳背景并画');
 const next=structuredClone(f.page().doc); next.layout.summary.caption='Accepted background';
 const p=await f.store.propose({page_id:f.page().page_id,expected_revision:f.page().revision,doc:next,summary:'background'});
 const resolved=await wb(f,'studioResolve',{page_id:p.page_id,expected_revision:p.revision,proposal_id:p.proposals.at(-1).proposal_id,accept:['layout.summary'],reject:false});
 f.select(resolved); await f.start(); assert.equal(f.page().doc.layout.summary.caption,'Accepted background');
});
test('manual native continue uses automatic clean client ACK without a question',sdk,async t=>{
 const f=await fixture(t); f.human('画背景'); await f.start();
 const owned=await f.store.takeover({page_id:f.page().page_id,expected_revision:f.page().revision,client_id:'window'}); f.select(owned.page);
 f.human('继续画');
 const pending=await wb(f,'studioStart',{page_id:owned.page.page_id,expected_revision:owned.page.revision,intent:'继续画',max_runs:1});
 assert.equal(pending.consent.status,'awaiting_handoff'); assert.equal(f.counters.requests,0);
 await f.store.ackConsentHandoff({consent_id:pending.consent.consent_id,page_id:owned.page.page_id,expected_revision:owned.page.revision,nonce:pending.consent.handoff.nonce,client_id:'window',lease_token:owned.lease_token});
 await wb(f,'studioStart',{page_id:owned.page.page_id,expected_revision:owned.page.revision,intent:'继续画',max_runs:1});
 await f.prepare();
});
test('plain assistant question followed by native 同意 is fresh authority without consent',sdk,async t=>{
 const f=await fixture(t); f.say('要我画吗？'); f.human('同意'); await f.start(); await f.prepare();
 assert.equal(f.counters.requests,0);
});
test('no native human cannot start; budget and unknown submission remain bounded',sdk,async t=>{
 const f=await fixture(t); await assert.rejects(f.start(),/STUDIO_NEW_REQUEST_REQUIRED|STUDIO_CONSENT_GENERATION/);
 f.human('画'); await f.start(); const p=await f.prepare();
 await f.store.claimPlan({plan_id:p.plan_id}); await f.store.finishPlan({plan_id:p.plan_id,status:'unknown'});
 const result=await wb(f,'studioExecute',{plan_id:p.plan_id}); assert.equal(result.status,'unknown'); assert.equal(f.counters.submissions,0);
 const current=await f.store.getPage({page_id:f.page().page_id});
 const next=await wb(f,'studioPrepare',{page_id:current.page_id,expected_revision:current.revision,request_key:'next',settings:{backend:'moss'},references:[]});
 await assert.rejects(wb(f,'studioExecute',{plan_id:next.plan_id}),/STUDIO_BUDGET_EXHAUSTED/);
});
test('UI text-only native message blocks prepare/execute/start, next drawing request exits it',sdk,async t=>{
 const f=await fixture(t); f.human('画背景'); await f.start(); const plan=await f.prepare();
 const p=await f.store.getPage({page_id:f.page().page_id});
 const owned=await f.store.takeover({page_id:p.page_id,expected_revision:p.revision,client_id:'text-window'});
 const returned=await f.store.resumeTask({page_id:p.page_id,expected_revision:owned.page.revision,lease_token:owned.lease_token,editing_only:true});
 f.select(returned); f.human('保留当前构图，只按当前视角修改描述。禁止 prepare、execute、生成图片、扩大预算或修改构图/相机/共享设定。');
 await assert.rejects(f.prepare(),/STUDIO_TEXT_ONLY/);
 await assert.rejects(wb(f,'studioExecute',{plan_id:plan.plan_id}),/STUDIO_TEXT_ONLY/);
 await assert.rejects(f.start(),/STUDIO_TEXT_ONLY/);
 f.human('继续画'); await f.start(); const current=await f.store.getPage({page_id:p.page_id}); await wb(f,'studioPrepare',{page_id:p.page_id,expected_revision:current.revision,request_key:'after-text',settings:{backend:'moss'},references:[]});
});
test('manual lease cannot be resolved or bypassed before the original client ACK',sdk,async t=>{
 const f=await fixture(t); f.human('先审稿'); await f.start(); const next=structuredClone(f.page().doc); next.layout.summary.caption='proposal';
 const p=await f.store.propose({page_id:f.page().page_id,expected_revision:f.page().revision,doc:next,summary:'draft'});
 const owned=await f.store.takeover({page_id:p.page_id,expected_revision:p.revision,client_id:'owner'}); f.select(owned.page); f.human('继续画');
 await assert.rejects(wb(f,'studioResolve',{page_id:p.page_id,expected_revision:owned.page.revision,proposal_id:p.proposals.at(-1).proposal_id,accept:[],reject:true}),/STUDIO_HUMAN_CONTROL/);
 const pending=await wb(f,'studioStart',{page_id:p.page_id,expected_revision:owned.page.revision,intent:'继续',max_runs:1});
 assert.equal(pending.consent.status,'awaiting_handoff'); await assert.rejects(f.prepare(),/STUDIO_CONSENT_GENERATION|STUDIO_HUMAN_CONTROL/);
 assert.equal((await f.store.getPage({page_id:p.page_id})).task.control,'manual');
 await assert.rejects(f.store.ackConsentHandoff({consent_id:pending.consent.consent_id,page_id:p.page_id,expected_revision:owned.page.revision,nonce:pending.consent.handoff.nonce,client_id:'other',lease_token:owned.lease_token}),{code:'STUDIO_CONSENT_HANDOFF'});
});
