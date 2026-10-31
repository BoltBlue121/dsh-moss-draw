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
  return {store, call, human, say, start, ask, prepare, counters, page: () => page};
}

// Restoring exact-text matching or dropping native provenance wiring must break this test.
test('one natural confirmation and one human 同意 apply and submit exactly once', {skip: !sdkPath}, async t => {
  const f = await fixture(t);
  f.human('先给我背景修改提案，采纳后用剩余的一次额度出图。');
  await f.start();
  const {consent} = await f.ask(true);
  f.say('我会采纳当前背景提案，人物和机位保持不变，用现有 Moss 额度生成一张，不增加次数。你同意吗？');
  f.human('同意');
  const apply = {mode: 'workbench', workbench: {action: 'studioApplyConsent', consent_id: consent.consent_id}};
  const applied = await f.call(apply);
  assert.equal(applied.consent.status, 'applied');
  assert.deepEqual(await f.call(apply), applied);
  const plan = await f.prepare();
  const execute = {mode: 'workbench', workbench: {action: 'studioExecute', plan_id: plan.plan_id}};
  await f.call(execute);
  await f.call(execute);
  const page = await f.store.getPage({page_id: f.page().page_id});
  assert.equal(page.doc.layout.summary.caption, 'A quieter study');
  assert.equal(page.doc.layout.items[0].caption, 'Unchanged costume');
  assert.equal(page.task.claimed_runs, 1);
  assert.equal(page.task.max_runs, 1);
  assert.deepEqual(f.counters, {human: 2, requests: 1, submissions: 1});
});

test('natural proposal-only approval never falls through to old image allowance', {skip: !sdkPath}, async t => {
  const f = await fixture(t);
  f.human('给我背景修改提案，先不出图。');
  await f.start();
  const {consent} = await f.ask(false);
  f.say('我会只采纳当前背景提案，人物和机位不变，本次不生成图片。可以吗？');
  f.human('好');
  const applied = await f.call({mode: 'workbench', workbench: {action: 'studioApplyConsent', consent_id: consent.consent_id}});
  assert.equal(applied.consent.status, 'applied');
  await assert.rejects(f.prepare(), /STUDIO_CONSENT_GENERATION/);
  const page = await f.store.getPage({page_id: f.page().page_id});
  assert.equal(page.doc.layout.summary.caption, 'A quieter study');
  assert.equal(page.task.max_runs, 1);
  assert.equal(page.task.claimed_runs, 0);
  assert.deepEqual(f.counters, {human: 2, requests: 1, submissions: 0});
});

test('a same-message unrelated second question cannot turn yes into generation consent', {skip: !sdkPath}, async t => {
  const f = await fixture(t);
  f.human('先给背景提案让我看。');
  await f.start();
  const {consent} = await f.ask(true);
  f.say(consent.question + '\n顺便问一下，你需要喝茶吗？');
  f.human('可以');
  // The contaminated display never becomes a valid receipt, so '可以' is ordinary chat, never consent.
  try {
    const result = await f.call({mode: 'workbench', workbench: {action: 'studioApplyConsent', consent_id: consent.consent_id}});
    assert.notEqual(result.consent.status, 'applied');
  } catch (error) {
    assert.match(error.message, /STUDIO_CONSENT_EVIDENCE/);
  }
  // Chat-first policy: the fresh chat message may prepare inside the existing task budget,
  // but the receipt is never applied, the proposal is not accepted and nothing is submitted.
  await f.prepare();
  assert.notEqual((await f.store.consentState({})).consent.status, 'applied');
  const page = await f.store.getPage({page_id: f.page().page_id});
  assert.equal(page.doc.layout.summary.caption, 'Original study');
  assert.equal(page.task.claimed_runs, 0);
  assert.equal(f.counters.submissions, 0);
});

test('direct image request needs no consent request before its single bounded execution', {skip: !sdkPath}, async t => {
  const f = await fixture(t);
  f.human('请直接画一张室内场景，不用先给提案。');
  await f.start();
  const plan = await f.prepare();
  await f.call({mode: 'workbench', workbench: {action: 'studioExecute', plan_id: plan.plan_id}});
  assert.deepEqual(f.counters, {human: 1, requests: 0, submissions: 1});
});

test('direct taskless text update requires no consent or generation task', {skip: !sdkPath}, async t => {
  const f = await fixture(t);
  f.human('只把背景描述改成安静的室内场景，不画图。');
  const page = f.page(), doc = structuredClone(page.doc);
  doc.layout.summary.caption = 'A quiet study, text update only';
  await f.call({mode: 'workbench', workbench: {action: 'studioAgentUpdate', page_id: page.page_id,
    expected_revision: page.revision, doc_json: JSON.stringify(doc)}});
  const updated = await f.store.getPage({page_id: page.page_id});
  assert.equal(updated.doc.layout.summary.caption, 'A quiet study, text update only');
  assert.equal(updated.task, undefined);
  assert.deepEqual(f.counters, {human: 1, requests: 0, submissions: 0});
});
