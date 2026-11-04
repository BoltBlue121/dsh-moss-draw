import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
const subject = () => import('../src/tools.mjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWPgEpFrAAABJQC9zBEyigAAAABJRU5ErkJggg==', 'base64');
const hash = createHash('sha256').update(png).digest('hex');
const runId = '8ed3944e-9d08-4df0-8e19-697c88cae6fd';
async function fixture(t, { native = false } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'moss-tools-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspaceRoot = path.join(base, 'workspace'), dataRoot = path.join(workspaceRoot, 'private/workspace/moss-draw');
  await mkdir(path.join(dataRoot, 'runs', runId), { recursive: true });
  const file = path.join(dataRoot, 'runs', runId, 'image.png'); await writeFile(file, png);
  const definitions = new Map(), saved = [];
  const attachments = {
    async saveImage(input) { saved.push({ type: 'image', ...input }); return { id: 'normalized-image', mediaType: 'image/png', width: 1, height: 1 }; },
    async saveFile(input) { saved.push({ type: 'file', ...input }); return { id: 'original-file', name: input.name }; },
    imageHostPath: ref => ref.hostPath,
    fileHostPath: ref => ref.hostPath,
  };
  const service = {
    catalog: () => ({ styles: ['none'] }),
    context: async args => ({ catalog: { styles: ['none'] }, runs: args.run_id ? [await service.run()] : [], ...args }),
    generate: async args => ({ run_id: runId, status: 'pending', params: args }),
    run: async () => ({ run_id: runId, status: 'succeeded', artifact: { path: file, sha256: hash, width: 1, height: 1 } }),
    review: async args => ({ run_id: args.run_id, review: args }),
  };
  const commands = new Map();
  const ctx = { tools: { register: value => definitions.set(value.name, value) }, commands:{register:value=>commands.set(value.name,value)} };
  const exec = { agent: { session: { deriveMessages: () => [{id:'fixture-native-human',role:'user',source:{kind:'user'},content:[{type:'text',text:'画一张图'}]}] } }, signal: new AbortController().signal };
  const human = (text = '画一张测试图', id = randomUUID()) => {
    exec.agent.session.append('user/message', { id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, { surfaceOp: 'append' });
  };
  if (native) {
    const require = createRequire(process.env.MOSS_SDK_PACKAGE);
    const { Context } = require('@deepseek-ai/cordis');
    const { SessionProjectionRegistry } = require('@deepseek-ai/dsh-session-projection');
    const { Session } = require('@deepseek-ai/dsh-session');
    const host = new Context();
    new SessionProjectionRegistry(host);
    t.after(() => host.fiber.dispose());
    ctx.sessionProjections = host.sessionProjections;
    const session = Session.create(`tools-fixture-${randomUUID()}`);
    exec.agent = { id: session.id, session };
    human('画一张测试图', 'human-1');
  }
  const { registerTools } = await subject();
  registerTools(ctx, { sdk: { tools: { defineTool: x => x } }, service, readGuide: async x => ({ topic: x.topic ?? 'quick', text: 'private guide' }), config: { workspaceRoot, dataRoot }, attachments });
  return { base, workspaceRoot, dataRoot, definitions, commands, saved, service, exec, file, human };
}

test('seven compact tools call service and guide with strict schemas, never accept command or URL', async t => {
  const f = await fixture(t);
  assert.deepEqual([...f.definitions.keys()], ['art_guide','art_context','art_generate','art_run','art_review','art_view','art_deliver']);
  assert.ok([...f.definitions.values()].reduce((n, d) => n + d.description.length, 0) < 1600);
  // Sampler/scheduler are two new optional t2i fields; the cap grew by the
  // measured 120 bytes they cost so the rest of the schema keeps its own limit.
  // A per-region (and per-request) LoRA list added a measured 454 bytes more.
  assert.ok((() => { const p = JSON.stringify([...f.definitions.values()].map(d => d.parameters)).length; const s = [...f.definitions.values()].reduce((n, d) => n + d.description.length, 0); return (p < 8800 && s < 1600) || (() => { throw new Error(`SCHEMA_BYTES=${p} DESC_BYTES=${s}`); })(); })());
  const call = (name, args) => f.definitions.get(name).execute(args, f.exec);
  assert.deepEqual(await call('art_guide', { topic: 'quick' }), { topic: 'quick', text: 'private guide' });
  assert.equal((await call('art_context', { limit: 2 })).limit, 2);
  const generated = await call('art_generate', { request_id: 'test-1', prompt: 'An adult traveler.', seed: 0 });
  assert.equal(generated.status, 'pending'); assert.equal(generated.params.seed, 0);
  assert.equal((await call('art_run', { run_id: runId })).artifact.sha256, hash);
  assert.equal(f.definitions.get('art_run').timeoutMs,1860000);
  assert.match((await call('art_run',{run_id:runId})).next_action,/art_view.*art_review.*art_deliver/);
  const review = await call('art_review', { run_id: runId, observations: ['eyes visible'], issues: [], next_change: '' });
  assert.deepEqual(review.review.observations, ['eyes visible']);
  for (const [name, args] of [['art_generate', { request_id: 'x', prompt: 'p', command: 'whoami' }], ['art_run', { run_id: runId, url: 'http://evil' }], ['art_review', { run_id: runId, score: 5 }]]) await assert.rejects(call(name, args), /MOSS_INPUT/);
});

test('workbench creation and proposal share native command state with seven art tools',async t=>{
  const f=await fixture(t);const generate=f.definitions.get('art_generate'),context=f.definitions.get('art_context');
  f.exec.agent.session.deriveMessages=()=>[{source:{kind:'user'},content:[{type:'text',text:`Use @\"${f.file}\"`}]}];
  const wb={action:'create',title:'Drawing',canvas:{width:1,height:1,reference:f.file},references:[f.file,f.file],prompt:'Scene',regions:[{id:'r',box:[0,0,1,1],reference_index:1,prompt:'Blue',style:'none',lora_strength:0}]};
  const doc=await generate.execute({mode:'workbench',workbench:wb},f.exec);
  assert.equal(doc.revision,1);assert.equal(f.definitions.size,7);
  const data=await context.execute({document_id:doc.document_id},f.exec);assert.equal(data.document.document_id,doc.document_id);
  const command=f.commands.get('art-workbench');assert.ok(command);
  const result=await command.handler({...f.exec,rawInput:JSON.stringify({action:'update',document_id:doc.document_id,expected_revision:1,patch:{prompt:'Changed'}})});
  assert.equal(result.kind,'success');assert.equal(JSON.parse(result.text).revision,2);
  const p=await generate.execute({mode:'workbench',workbench:{action:'propose',document_id:doc.document_id,expected_revision:2,patch:{prompt:'Agent proposal'},summary:'short'}},f.exec);
  assert.equal(p.proposals[0].base.prompt,'Changed');
  await assert.rejects(generate.execute({mode:'workbench',workbench:{action:'resolve',document_id:doc.document_id}},f.exec),/MOSS_INPUT/);
  await assert.rejects(generate.execute({mode:'workbench',workbench:wb,prompt:'extra'},f.exec),/MOSS_INPUT/);
});

test('studio series/pages share command state with tools without references or GPU execution',{skip:!process.env.MOSS_SDK_PACKAGE},async t=>{
 const f=await fixture(t, { native: true });let gpu=0;f.service.generate=async()=>{gpu++;throw Error('GPU forbidden');};
 const generate=args=>f.definitions.get('art_generate').execute({mode:'workbench',workbench:args},f.exec);
 const series=await generate({action:'studioCreateSeries',title:'Native prompt pages'});
 const doc={kind:'layout',layout:{width:512,height:512,bbox_coord_space:'abs',bbox_format:'xyxy',summary:{caption:'A blue square.'},items:[{id:'square',label:'object',caption:'A blue square.',bbox:[32,64,256,384]}]},caption:{caption:'Saved alternate caption'}};
 const page=await generate({action:'studioCreatePage',series_id:series.series_id,title:'Page one',doc_json:JSON.stringify(doc)});
 const context=f.definitions.get('art_context');assert.equal((await context.execute({studio_pages:true},f.exec)).pages[0].page_id,page.page_id);
 const seen=await context.execute({studio_page_id:page.page_id},f.exec);assert.deepEqual(seen.page.doc,doc);
 const runCommand=async request=>{const r=await f.commands.get('art-workbench').handler({...f.exec,rawInput:JSON.stringify(request)});assert.equal(r.kind,'success',r.text);return JSON.parse(r.text);};
 const compiled=await runCommand({action:'studioCompile',doc});assert.equal(JSON.parse(compiled.prompt).bbox_format,'yxyx');
 const proposed=await generate({action:'studioPropose',page_id:page.page_id,expected_revision:1,doc_json:JSON.stringify({...doc,caption:{caption:'Proposed'}}),summary:'Caption only'});
 assert.equal(proposed.proposals[0].base_doc,undefined);assert.equal(proposed.proposals[0].proposed_doc,undefined);
 const toolPage=await context.execute({studio_page_id:page.page_id},f.exec);assert.equal(toolPage.page.proposals[0].proposed_doc,undefined);
 const uiPage=await runCommand({action:'studioGetPage',page_id:page.page_id});assert.ok(uiPage.proposals[0].proposed_doc,'UI retains full review snapshots');
 const adopted=await runCommand({action:'studioResolve',page_id:page.page_id,expected_revision:proposed.revision,proposal_id:proposed.proposals.at(-1).proposal_id,accept:['caption']});assert.equal(adopted.doc.caption.caption,'Proposed');
 await assert.rejects(generate({action:'studioResolve',page_id:page.page_id}),/STUDIO_INVALID_INPUT/);
 await assert.rejects(generate({action:'studioCreatePage',series_id:series.series_id,title:'bad',doc_json:'{bad'}),/MOSS_INPUT|STUDIO/);
 await assert.rejects(context.execute({studio_pages:true,document_id:page.page_id},f.exec),/MOSS_INPUT/);
 assert.equal(gpu,0);assert.equal(f.definitions.size,7);
});

test('Agent task flow stays in seven tools and cannot invoke human control actions',{skip:!process.env.MOSS_SDK_PACKAGE},async t=>{
 const f=await fixture(t, { native: true });let calls=0;f.service.generate=async args=>{calls++;return{run_id:runId,status:'running',params:args};};
 const gen=args=>f.definitions.get('art_generate').execute({mode:'workbench',workbench:args},f.exec),context=args=>f.definitions.get('art_context').execute(args,f.exec);
 const series=await gen({action:'studioCreateSeries',title:'Automatic'}),doc={kind:'caption',layout:{width:512,height:512,bbox_coord_space:'abs',bbox_format:'xyxy',summary:{caption:''},items:[]},caption:{caption:'A cup'}};
 const page=await gen({action:'studioCreatePage',series_id:series.series_id,title:'Cup',doc_json:JSON.stringify(doc)});
 const started=await gen({action:'studioStart',page_id:page.page_id,expected_revision:page.revision,intent:'Draw cup',mode:'auto'});
 const inspected=await context({studio_page_id:page.page_id,studio_inspect:true});assert.equal(inspected.compilation.prompt,'A cup');
 const preview=await f.definitions.get('art_view').execute({studio_page_id:page.page_id,expected_revision:started.revision},f.exec);assert.equal(preview.page_id,page.page_id);assert.equal(calls,0);
 const plan=await gen({action:'studioPrepare',page_id:page.page_id,expected_revision:started.revision,request_key:'one',settings:{backend:'moss',mode:'t2i',seed:1},references:[]});assert.equal(calls,0);
 const run=await gen({action:'studioExecute',plan_id:plan.plan_id});assert.equal(run.run_id,runId);assert.equal(calls,1);await gen({action:'studioExecute',plan_id:plan.plan_id});assert.equal(calls,1);
 const task=await context({studio_tasks:true});assert.equal(task.tasks[0].page_id,page.page_id);assert.equal(f.definitions.size,7);
 await assert.rejects(f.definitions.get('art_generate').execute({request_id:'bypass',prompt:'ignore workbench'},f.exec),/STUDIO_TASK_BINDING_REQUIRED/);assert.equal(calls,1);
 for(const action of ['studioTakeover','studioResume','studioAckOpen'])await assert.rejects(gen({action,page_id:page.page_id}),/MOSS_INPUT|STUDIO_AGENT_FORBIDDEN/);
});
test('long Studio captions survive the tool path and wrong action fields report the actual cause',{skip:!process.env.MOSS_SDK_PACKAGE},async t=>{
 const f=await fixture(t, { native: true });let submitted=0;f.service.generate=async()=>{submitted++;throw Error('GPU forbidden');};
 const gen=workbench=>f.definitions.get('art_generate').execute({mode:'workbench',workbench},f.exec),series=await gen({action:'studioCreateSeries',title:'Long caption regression'});
 const doc={kind:'caption',layout:{width:1088,height:1920,bbox_coord_space:'abs',bbox_format:'xyxy',summary:{caption:'',canvas:'single'},items:[]},caption:{caption:'银色长发，金色花纹与衣料细节。'.repeat(100)}};
 await assert.rejects(gen({action:'studioCreatePage',series_id:series.series_id,title:'Long',doc_json:JSON.stringify(doc),canvas:{width:1088,height:1920}}),/STUDIO_INVALID_INPUT.*canvas/);
 let page=await gen({action:'studioCreatePage',series_id:series.series_id,title:'Long',doc_json:JSON.stringify(doc)});page=await gen({action:'studioStart',page_id:page.page_id,expected_revision:page.revision,intent:'Prepare only',max_runs:0});
 await assert.rejects(gen({action:'studioAgentUpdate',page_id:page.page_id,expected_revision:page.revision,doc_json:JSON.stringify(doc),summary:'Long prompt probe'}),/STUDIO_INVALID_INPUT.*summary/);
 for(const n of [113,160,250,430,700,1342,12000]){doc.caption.caption='细'.repeat(n);page=await gen({action:'studioAgentUpdate',page_id:page.page_id,expected_revision:page.revision,doc_json:JSON.stringify(doc)});assert.equal(page.doc.caption.caption.length,n);}
 const plan=await gen({action:'studioPrepare',page_id:page.page_id,expected_revision:page.revision,request_key:'long-caption',settings:{backend:'moss',mode:'t2i',seed:42},references:[]});assert.equal(plan.request.prompt.length,12000);
 await assert.rejects(f.definitions.get('art_generate').execute({request_id:'raw-bypass',prompt:'a cup'},f.exec),/STUDIO_TASK_BINDING_REQUIRED.*studioPrepare.*studioExecute/);assert.equal(submitted,0);
});
test('regions preparation identifies incompatible settings.model instead of losing binding diagnostics',{skip:!process.env.MOSS_SDK_PACKAGE},async t=>{
 const f=await fixture(t, { native: true }),{encodePng}=await import('../src/region-pixels.mjs'),data=encodePng({width:256,height:256,pixels:Buffer.alloc(256*256*4,255)});await writeFile(f.file,data);const sha=createHash('sha256').update(data).digest('hex');let submissions=0;f.service.generate=async()=>{submissions++;throw Error('No GPU');};f.service.run=async()=>({run_id:runId,status:'succeeded',artifact:{path:f.file,sha256:sha,width:256,height:256}});
 const gen=workbench=>f.definitions.get('art_generate').execute({mode:'workbench',workbench},f.exec);const series=await gen({action:'studioCreateSeries',title:'Region diagnostic'}),doc={kind:'layout',layout:{width:256,height:256,bbox_coord_space:'abs',bbox_format:'xyxy',summary:{caption:'Preserved base scene'},items:[{id:'tone-region',label:'object',caption:'Slightly darken the fabric only.',bbox:[32,64,224,256]}]},caption:{caption:''}};let page=await gen({action:'studioCreatePage',series_id:series.series_id,title:'Local tone',doc_json:JSON.stringify(doc)});page=await gen({action:'studioStart',page_id:page.page_id,expected_revision:page.revision,intent:'One local tone adjustment',max_runs:1});const base={action:'studioPrepare',page_id:page.page_id,expected_revision:page.revision,request_key:'tone-once',references:[`run:${runId}`,`run:${runId}`]},settings={backend:'moss',mode:'regions',model:'sft',style:'none',lora_strength:0,steps:30,cfg:4,seed:42,region_bindings:[{item_id:'tone-region',reference_index:1}]};
 await assert.rejects(gen({...base,settings}),/STUDIO_REGION_BINDING:.*settings\.model.*omit/i);
 const {model:ignored,...corrected}=settings,plan=await gen({...base,settings:corrected});assert.equal(plan.cost,1);assert.deepEqual(plan.request.regions[0].box,[32,64,224,256]);assert.equal(plan.request.qwen_full_prompt,'');assert.equal(plan.status,'prepared');assert.equal(plan.run_id,null);assert.equal(submissions,0);const after=await f.definitions.get('art_context').execute({studio_page_id:page.page_id},f.exec);assert.equal(after.page.task.claimed_runs,0);assert.equal(after.page.revision,page.revision);assert.deepEqual(after.page.doc,doc);
});
test('delivered Studio history releases raw binding and a fresh native user request renews the same page',{skip:!process.env.MOSS_SDK_PACKAGE},async t=>{
 const f=await fixture(t, { native: true });// Native human-1 remains the current instruction throughout this turn.
 const call=(name,args)=>f.definitions.get(name).execute(args,f.exec),gen=workbench=>call('art_generate',{mode:'workbench',workbench});const series=await gen({action:'studioCreateSeries',title:'Renewal'}),doc={kind:'caption',layout:{width:512,height:512,bbox_coord_space:'abs',bbox_format:'xyxy',summary:{caption:''},items:[]},caption:{caption:'A cup'}};let p=await gen({action:'studioCreatePage',series_id:series.series_id,title:'One page',doc_json:JSON.stringify(doc)});p=await gen({action:'studioStart',page_id:p.page_id,expected_revision:p.revision,intent:'Draw',max_runs:1});const plan=await gen({action:'studioPrepare',page_id:p.page_id,expected_revision:p.revision,request_key:'first',settings:{seed:1},references:[]});await gen({action:'studioExecute',plan_id:plan.plan_id});await call('art_run',{run_id:runId});await call('art_deliver',{run_id:runId});
 assert.equal((await call('art_context',{studio_tasks:true})).tasks[0].binding_active,false);
 await assert.rejects(gen({action:'studioStart',page_id:p.page_id,expected_revision:p.revision,intent:'Repeat without user',max_runs:1}),/STUDIO_NEW_REQUEST_REQUIRED/);
 await call('art_generate',{request_id:'independent-next',prompt:'Allowed legacy generation after delivery'});
 f.human('把测试图改成蓝色', 'human-2');const next=await gen({action:'studioStart',page_id:p.page_id,expected_revision:p.revision,intent:'Change color',max_runs:1});assert.equal(next.page_id,p.page_id);assert.equal(next.task.claimed_runs,0);assert.notEqual(next.task.task_id,p.task.task_id);assert.equal((await call('art_context',{studio_tasks:true})).tasks[0].binding_active,true);
 await assert.rejects(call('art_generate',{request_id:'bypass-new',prompt:'Do not bypass active page'}),/STUDIO_TASK_BINDING_REQUIRED/);
});
test('region draft and execute retain seven tools, preview and result viewing never advance jobs',async t=>{
  const f=await fixture(t);let generates=0,runs=0,contexts=0;
  f.service.generate=async args=>{generates++;return {run_id:runId,status:args.action==='execute'?'running':'draft'};};
  f.service.run=async()=>{runs++;throw Error('view must not advance a pipeline');};
  f.service.context=async()=>{contexts++;return {runs:[{run_id:runId,status:'draft',preview_artifact:{path:f.file,sha256:hash,width:1,height:1}}]};};
  const gen=f.definitions.get('art_generate');
  const d=await gen.execute({mode:'regions',action:'draft',request_id:'regions1',prompt:'replace people',regions:[{id:'a',box:[0,0,1,1],reference_index:1,prompt:'person',style:'none',lora_strength:0}]},f.exec);
  assert.equal(d.status,'draft');assert.match(d.next_action,/preview/);assert.doesNotMatch(d.next_action,/Call art_run once/);
  const view=await f.definitions.get('art_view').execute({run_id:runId,variant:'preview'},f.exec);assert.equal(view.sha256,hash);assert.equal(runs,0);assert.equal(contexts,1);
  await assert.rejects(f.definitions.get('art_deliver').execute({run_id:runId},f.exec),/NOT_READY/);
  assert.equal((await gen.execute({mode:'regions',action:'execute',plan_id:runId},f.exec)).status,'running');assert.equal(generates,2);
  await assert.rejects(gen.execute({mode:'regions',action:'execute',plan_id:runId,prompt:'mutate'},f.exec),/MOSS_INPUT/);
});

test('view projects actual image attachment, deliver preserves exact original bytes and preview', async t => {
  const f = await fixture(t), view = f.definitions.get('art_view');
  const viewed = await view.execute({ run_id: runId }, f.exec);
  assert.equal(viewed.sha256, hash);
  const projected = view.projectContent(f.exec, { isError: false });
  assert.equal(projected[1].type, 'image'); assert.equal(projected[1].attachment.id, 'normalized-image');
  assert.deepEqual(f.saved[0].data, png);
  assert.equal(view.projectContent(f.exec, { isError: true }), undefined);
  const deliver = f.definitions.get('art_deliver'), deliveryExec = { ...f.exec };
  const delivered=await deliver.execute({ run_id: runId }, deliveryExec);
  assert.equal(delivered.path, f.file.replaceAll('\\','/'));
  assert.equal(delivered.markdown_link,`[在侧边栏查看原图](<${f.file.replaceAll('\\','/')}>)`);
  assert.match(delivered.next_action,/markdown_link/);
  assert.deepEqual(deliver.projectContent(deliveryExec, { isError: false }).map(x => x.type), ['text', 'file', 'image']);
  assert.deepEqual(f.saved.find(x => x.type === 'file').data, await readFile(f.file));
});

test('delivery encodes spaces Chinese and fragment characters in a local Markdown file target',async t=>{
 const f=await fixture(t),dir=path.join(f.dataRoot,'中文 图#%');await mkdir(dir);const file=path.join(dir,'图像 %.png');await writeFile(file,png);
 f.service.run=async()=>({status:'succeeded',artifact:{path:file,sha256:hash,width:1,height:1}});
 const out=await f.definitions.get('art_deliver').execute({run_id:runId},f.exec);
 const target=out.markdown_link.match(/<(.+)>/)[1];assert.equal(decodeURIComponent(target),file.replaceAll('\\','/'));assert.ok(target.includes('%20'));assert.ok(target.includes('%23'));assert.ok(!target.startsWith('dsh-resource:'));
});
test('view admits user supplied workspace reference and session attachment path, not guessed private files', async t => {
  const f = await fixture(t), view = f.definitions.get('art_view');
  const image = path.join(f.workspaceRoot, 'reference.png'); await writeFile(image, png);
  await assert.rejects(view.execute({ path: image }, f.exec), /MOSS_IMAGE_NOT_VISIBLE/);
  f.exec.agent.session.deriveMessages = () => [{ source: { kind: 'user' }, content: [{ type: 'text', text: `参考图 ${image}` }] }];
  assert.equal((await view.execute({ path: image }, f.exec)).sha256, hash);
  const attached = path.join(f.base, 'attachments', 'blob'); await mkdir(path.dirname(attached)); await writeFile(attached, png);
  f.exec.agent.session.deriveMessages = () => [{ source: { kind: 'user' }, content: [{ type: 'image', attachment: { hostPath: attached } }] }];
  assert.equal((await view.execute({ path: attached }, f.exec)).sha256, hash);
  await assert.rejects(view.execute({ path: image }, f.exec), /MOSS_IMAGE_NOT_VISIBLE/);
});

test('reference authorization uses complete path tokens, never a substring of a different path', async t => {
  const f = await fixture(t), view = f.definitions.get('art_view');
  const image = path.join(f.workspaceRoot, 'ref.png'); await writeFile(image, png);
  for (const text of ['not-ref.png', 'folder/ref.png', `${image}.backup`, `prefix${image}`, 'https://example.invalid/ref.png', '@"other ref.png"', '`directory with spaces/not ref.png`']) {
    f.exec.agent.session.deriveMessages = () => [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }];
    await assert.rejects(view.execute({ path: 'ref.png' }, f.exec), /MOSS_IMAGE_NOT_VISIBLE/, text);
  }
  for (const text of ['参考图 @ref.png', `参考图 "${image}"`, `![ref](<${image}>)`, `参考图 ${image}`]) {
    f.exec.agent.session.deriveMessages = () => [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }];
    assert.equal((await view.execute({ path: 'ref.png' }, f.exec)).sha256, hash, text);
  }
});

test('view rejects outside paths, disguised credentials, unsafe artifact hash and conflicting selectors', async t => {
  const f = await fixture(t), view = f.definitions.get('art_view');
  const outside = path.join(f.base, 'secret.png'); await writeFile(outside, png);
  const credential = path.join(f.workspaceRoot, 'credential.png'); await writeFile(credential, 'SECRET_KEY=not-an-image');
  f.exec.agent.session.deriveMessages = () => [{ source: { kind: 'user' }, content: [{ type: 'text', text: `${outside} ${credential}` }] }];
  await assert.rejects(view.execute({ path: outside }, f.exec), /MOSS_IMAGE_NOT_VISIBLE/);
  await assert.rejects(view.execute({ path: credential }, f.exec), /MOSS_IMAGE_FORMAT/);
  await assert.rejects(view.execute({ path: credential, run_id: runId }, f.exec), /MOSS_INPUT/);
  f.service.run = async () => ({ status: 'succeeded', artifact: { path: f.file, sha256: '0'.repeat(64), width: 1, height: 1 } });
  await assert.rejects(view.execute({ run_id: runId }, f.exec), /MOSS_ARTIFACT_INTEGRITY/);
  f.service.run = async () => ({ status: 'succeeded', artifact: { path: outside, sha256: hash, width: 1, height: 1 } });
  await assert.rejects(view.execute({ run_id: runId }, f.exec), /MOSS_IMAGE_NOT_VISIBLE/);
});

test('cancelled artifact and wait calls preserve abort and do not access the service',async t=>{
 const f=await fixture(t),abort=new AbortController();abort.abort();let calls=0;f.service.run=async()=>{calls++;throw Error('should not run')};
 for(const name of ['art_view','art_deliver','art_run']) await assert.rejects(f.definitions.get(name).execute({run_id:runId},{...f.exec,signal:abort.signal}),{name:'AbortError'});
 assert.equal(calls,0);
});
test('cancellation during reference decoding never submits a new generation',async t=>{
 const f=await fixture(t),cancel=new AbortController();let submitted=0;
 const ctx={tools:{register:d=>f.definitions.set(d.name,d)}};
 const attachments={imageHostPath:ref=>ref.hostPath,saveImage:async()=>{cancel.abort();return {width:1,height:1};}};
 const {registerTools}=await subject();f.service.generate=async()=>{submitted++;return {status:'queued'};};
 registerTools(ctx,{sdk:{tools:{defineTool:x=>x}},service:f.service,readGuide:async()=>({}),config:{workspaceRoot:f.workspaceRoot,dataRoot:f.dataRoot},attachments});
 const exec={...f.exec,signal:cancel.signal,agent:{session:{deriveMessages:()=>[{source:{kind:'user'},content:[{type:'image',attachment:{hostPath:f.file}}]}]}}};
 await assert.rejects(f.definitions.get('art_generate').execute({mode:'edit',request_id:'cancel-decoding',prompt:'p',references:[f.file]},exec),{name:'AbortError'});
 assert.equal(submitted,0);
});
test('known core validation errors stay actionable without exposing unknown errors', async t => {
  const f = await fixture(t), generate = f.definitions.get('art_generate');
  f.service.generate = async () => { throw Object.assign(new Error('Dimensions must be multiples of 16 and at most 2.1 MP.'), { code: 'INVALID_INPUT' }); };
  await assert.rejects(generate.execute({ request_id: 'x', prompt: 'p' }, f.exec), /INVALID_INPUT: Dimensions must be multiples of 16/);
  f.service.generate = async () => { throw new Error('secret-token-in-network-error'); };
  await assert.rejects(generate.execute({ request_id: 'x', prompt: 'p' }, f.exec), error => /MOSS_OPERATION_FAILED/.test(error.message) && !error.message.includes('secret-token'));
});

test('session services isolate attempts and context roots without accepting path-like session IDs', async () => {
  const { sessionServices } = await subject();
  const roots = [];
  const get = sessionServices({ workspaceRoot:os.tmpdir(),dataRoot: path.join(os.tmpdir(), 'moss-data'), comfyUrl: 'http://localhost:8188' }, options => { roots.push(options.dataRoot); return { root: options.dataRoot }; });
  const a = get({ agent: { id: 'session-a' } }), b = get({ agent: { id: 'session-b' } });
  assert.notEqual(a.dataRoot, b.dataRoot);
  assert.equal(get({ agent: { id: 'session-a' } }), a);
  assert.equal(roots.length, 2);
  assert.throws(() => get({ agent: { id: '../elsewhere' } }), /MOSS_SESSION_REQUIRED/);
});

test('a new conversation reopens the same workbench while generation ledgers stay per session', async () => {
  const { sessionServices } = await subject();
  const dataRoot = path.join(os.tmpdir(), 'moss-shared-workbench');
  const get = sessionServices({ workspaceRoot:os.tmpdir(),dataRoot, comfyUrl: 'http://localhost:8188' }, options => ({ root: options.dataRoot }));
  const first = get({ agent: { id: 'session-first' } }), second = get({ agent: { id: 'session-second' } });
  // Pages, series and workbench documents are workspace artifacts: opening a new
  // conversation must land in the same studio instead of an empty one.
  assert.notEqual(first.dataRoot, second.dataRoot, 'generation ledgers stay isolated per session');
  assert.equal(first.studioRoot, dataRoot);
  assert.equal(second.studioRoot, dataRoot);
  assert.equal(first.studioRoot, second.studioRoot, 'the workbench survives the end of a conversation');
});

test('tool adapter uses real core catalog, durable run and review with injected transport only', async t => {
  const f = await fixture(t);
  const { createService } = await import('../src/core.mjs');
  const { registerTools } = await subject();
  let posts = 0;
  const service = createService({ dataRoot: path.join(f.dataRoot, 'real-core'), comfyUrl: 'http://fixture.invalid', fetchImpl: async (_url, options) => {
    assert.equal(options.method, 'POST'); posts++;
    return new Response(JSON.stringify({ prompt_id: 'fixture-prompt' }), { status: 200, headers: { 'content-type': 'application/json' } });
  } });
  const defs = new Map();
  registerTools({ tools: { register: value => defs.set(value.name, value) } }, { sdk: { tools: { defineTool: x => x } }, service, readGuide: async () => ({}), config: f, attachments: {} });
  const call = (name, args) => defs.get(name).execute(args, f.exec);
  const context = await call('art_context', {});
  assert.equal(context.catalog.schemaVersion, 1);
  const generated = await call('art_generate', { request_id: 'real-core-fixture', prompt: 'An adult traveler wearing a long blue coat.', seed: 42 });
  assert.equal(generated.status, 'queued'); assert.equal(generated.params.seed, 42); assert.equal(posts, 1);
  await call('art_generate', { request_id: 'real-core-fixture', prompt: 'An adult traveler wearing a long blue coat.', seed: 42 });
  assert.equal(posts, 1);
  await call('art_review', { run_id: generated.run_id, observations: ['Not yet viewed'], issues: [], next_change: '' });
  const resumed = await call('art_context', { run_id: generated.run_id });
  assert.equal(resumed.runs[0].context.prompt, 'An adult traveler wearing a long blue coat.');
  assert.deepEqual(resumed.runs[0].context.review.observations, ['Not yet viewed']);
});

test('edit references are exact visible files decoded before service call and stripped from model input', async t => {
  const f = await fixture(t), generate = f.definitions.get('art_generate');
  const first = path.join(f.workspaceRoot, 'first.png'), second = path.join(f.workspaceRoot, 'second.png');
  await writeFile(first, png); await writeFile(second, png);
  f.exec.agent.session.deriveMessages = () => [{ source: { kind: 'user' }, content: [{ type: 'text', text: `@"${first}" @"${second}"` }] }];
  let seen;
  f.service.generate = async (input, assets) => { seen = { input, assets }; return { status: 'queued' }; };
  await generate.execute({ backend: 'moss', mode: 'edit', request_id: 'edit-1', prompt: 'Change the coat to blue.', references: [first, second] }, f.exec);
  assert.equal(seen.input.mode, 'edit'); assert.equal(seen.input.backend, 'moss'); assert.ok(!Object.hasOwn(seen.input, 'references'));
  assert.equal(seen.assets.length, 2); assert.deepEqual(seen.assets[0], { data: png, mediaType: 'image/png', width: 1, height: 1 });
  assert.equal(f.saved.filter(x => x.type === 'image').length, 2);
  seen = undefined;
  await assert.rejects(generate.execute({ request_id: 'bad', prompt: 'p', mode: 'edit', references: ['other.png'] }, f.exec));
  assert.equal(seen, undefined);
  await assert.rejects(generate.execute({ request_id: 'bad', prompt: 'p', mode: 'edit', references: Array(5).fill(first) }, f.exec), /MOSS_INPUT/);
  await assert.rejects(generate.execute({ request_id: 'bad', prompt: 'p', references: [first] }, f.exec), /MOSS_INPUT/);
});

test('edit can reuse this session verified run artifact without widening arbitrary path access', async t => {
  const f = await fixture(t), generate = f.definitions.get('art_generate');
  let captured;
  f.service.generate = async (_input, assets) => { captured = assets; return { status: 'queued' }; };
  await generate.execute({ mode: 'edit', request_id: 'reuse', prompt: 'Change color.', references: [`run:${runId}`] }, f.exec);
  assert.deepEqual(captured[0].data, png);
  await assert.rejects(generate.execute({ mode: 'edit', request_id: 'bad', prompt: 'p', references: ['run:../../credentials'] }, f.exec), /MOSS_INPUT/);
  f.service.run = async () => ({ status: 'unknown' });
  await assert.rejects(generate.execute({ mode: 'edit', request_id: 'not-ready', prompt: 'p', references: [`run:${runId}`] }, f.exec), /MOSS_ARTIFACT_NOT_READY/);
});

test('backend routing and bounded character schema do not expose workflow or file parameters', async t => {
  const f = await fixture(t), generate = f.definitions.get('art_generate');
  const characters = [{ prompt: 'Adult traveler left.', style: 'none', x: .25, y: .5, lora_strength: 0 }, { prompt: 'Adult traveler right.' }];
  assert.equal((await generate.execute({ backend: 'moss', mode: 'characters', characters, request_id: 'chars', prompt: 'Two adults meet.' }, f.exec)).status, 'pending');
  for (const key of ['width', 'height']) await assert.rejects(generate.execute({ mode: 'characters', characters: [{ prompt: 'p', [key]: .4 }], request_id: 'bad-box', prompt: 'p' }, f.exec), /MOSS_INPUT/);
  await assert.rejects(generate.execute({ backend: 'shell', request_id: 'bad', prompt: 'p' }, f.exec), /MOSS_INPUT/);
  await assert.rejects(generate.execute({ mode: 'characters', characters: [{ prompt: 'p', workflow: {} }], request_id: 'bad', prompt: 'p' }, f.exec), /MOSS_INPUT/);
  await assert.rejects(generate.execute({ mode: 'characters', characters: Array(3).fill({ prompt: 'p' }), request_id: 'bad', prompt: 'p' }, f.exec), /MOSS_INPUT/);
});

test('optional exact SDK decoder accepts the shipped fixture and tool pixel projection', { skip: !process.env.MOSS_SDK_PACKAGE }, async t => {
  const r = createRequire(process.env.MOSS_SDK_PACKAGE), f = await fixture(t);
  const { Context } = r('@deepseek-ai/cordis');
  const ctx = new Context();
  await ctx.plugin(r('@deepseek-ai/dsh-attachment-local').default, { dshHome: path.join(f.base, 'sdk-home') }).await();
  const validated = await ctx.attachments.saveImage({ data: png, mediaType: 'image/png' });
  assert.equal(validated.width, 1); assert.equal(validated.height, 1);
  const { registerTools } = await subject(), definitions = new Map();
  registerTools({ tools: { register: tool => definitions.set(tool.name, tool) } }, { sdk: { tools: r('@deepseek-ai/dsh-tools') }, service: f.service, readGuide: async () => ({}), config: f, attachments: ctx.attachments });
  const view = definitions.get('art_view');
  const output = await view.execute({ run_id: runId }, f.exec);
  assert.equal(output.sha256, hash);
  assert.equal(view.projectContent(f.exec, { isError: false })[1].attachment.width, 1);
  await assert.rejects(ctx.attachments.saveImage({ data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jv5sAAAAASUVORK5CYII=', 'base64'), mediaType: 'image/png' }));
});

test('workspace reference junction cannot escape workspace boundary', async t => {
  const f = await fixture(t), external = path.join(f.base, 'external'), linked = path.join(f.workspaceRoot, 'linked');
  await mkdir(external); await writeFile(path.join(external, 'reference.png'), png); await symlink(external, linked, 'junction');
  const candidate = path.join(linked, 'reference.png');
  f.exec.agent.session.deriveMessages = () => [{ source: { kind: 'user' }, content: [{ type: 'text', text: candidate }] }];
  await assert.rejects(f.definitions.get('art_view').execute({ path: candidate }, f.exec), /MOSS_IMAGE_NOT_VISIBLE/);
});
