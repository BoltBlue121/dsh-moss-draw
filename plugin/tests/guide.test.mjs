import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRegionService } from '../src/regions.mjs';
import { encodePng } from '../src/region-pixels.mjs';
import { catalog } from '../src/catalog.mjs';
import {createWorkbenchStore} from '../src/workbench-store.mjs';
import {createWorkbenchBridge} from '../src/workbench-host.mjs';
import {NATIVE_EDIT_ADAPTER} from '../src/native-edit.mjs';
const moduleUrl = new URL('../src/guide.mjs', import.meta.url);
const root = new URL('../', import.meta.url);

test('bundled prompt guide entry exists', async () => {
  assert.equal(await fs.stat(moduleUrl).then(s=>s.isFile()).catch(()=>false), true, 'Moss prompt guide is missing');
});
test('quick reference is short, standalone and exposes the actual drawing tools', async () => {
  const {readGuide}=await import(moduleUrl);
  const guide=await readGuide({topic:'quick'});
  assert.equal(guide.topic,'quick');
  assert.ok(guide.text.length<5000);
  assert.equal(guide.next_offset,null);
  for(const tool of ['art_context','art_generate','art_run','art_view','art_review','art_deliver']) assert.ok(guide.text.includes(tool));
  assert.ok(guide.text.includes('request_id'));
  assert.ok(!guide.text.includes('pwsh'));
});
test('studio guide provides a no-reference page whose official compilation is deterministic',async()=>{
 const {readGuide}=await import(moduleUrl),{compileStudioDoc}=await import('../src/studio-domain.mjs');
 const guide=await readGuide({topic:'studio',limit:9000});const examples=[...guide.text.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(m=>JSON.parse(m[1]));
 const create=examples.find(x=>x.workbench?.action==='studioCreatePage');assert.ok(create);const doc=JSON.parse(create.workbench.doc_json),result=compileStudioDoc(doc);assert.equal(result.compiled,true);assert.equal(JSON.parse(result.prompt).bbox_format,'yxyx');assert.deepEqual(JSON.parse(result.prompt).items[0].bbox,[-256,-384,256,128]);
});

test('task guide names the executable autonomous path and never requires human prompt copying',async()=>{const{readGuide}=await import(moduleUrl),guide=await readGuide({topic:'studio',limit:9000}),quick=await readGuide({topic:'quick'});for(const action of ['studioStart','studioAgentUpdate','studioPrepare','studioExecute','studio_tasks','manual','queued','opened'])assert.ok(guide.text.includes(action),action);assert.ok(quick.text.includes('studioStart'));assert.ok(guide.text.includes('max_runs'));assert.ok(guide.text.includes('region_bindings'));});
test('studio guide explains same-page renewal after delivery instead of forcing a new page',async()=>{const{readGuide}=await import(moduleUrl),g=await readGuide({topic:'studio',limit:9000});for(const text of ['同一页','新的用户消息','binding_active','旧任务'])assert.ok(g.text.includes(text),text);});
test('backend guide topics are independent, concise and free of private style assets',async()=>{
 const {readGuide}=await import(moduleUrl);
 for(const topic of ['moss-modes','k2','qwen']){
  const value=await readGuide({topic});assert.equal(value.topic,topic);assert.ok(value.text.length>0&&value.text.length<5000);assert.equal(value.next_offset,null);
  assert.equal(typeof value.source,'string');assert.ok(value.source.length>0);
  assert.doesNotMatch(value.text,/Civitai|safetensors|LoRA触发词|api[_ -]?key|bearer\s/i,`${topic} must not leak private model assets or credentials`);
  assert.match(value.text,/none/i,`${topic} documents the none-only style contract`);
 }
 const k=await readGuide({topic:'k2'});assert.ok(k.text.includes('CFG1'));assert.match(k.text,/style\s*=\s*none/i);
 const q=await readGuide({topic:'qwen'});assert.ok(q.text.includes('后处理'));assert.ok(q.text.includes('不能保证'));
});
test('regions topic pages compose into a usable immutable draft/execute example without inference',async t=>{
  const {readGuide}=await import(moduleUrl);
  let offset=0, complete='';
  do {
    const page=await readGuide({topic:'regions',offset,limit:700});
    assert.ok(page.text.length<=700); complete+=page.text; offset=page.next_offset;
  } while(offset!==null);
  assert.ok(complete.length<6000);
  const examples=[...complete.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(match=>JSON.parse(match[1]));
  const draft=examples.find(input=>input.mode==='regions'&&input.action==='draft');
  const execute=examples.find(input=>input.mode==='regions'&&input.action==='execute');
  assert.ok(draft, 'topic must supply one valid callable draft example');
  assert.deepEqual(Object.keys(execute).sort(),['action','mode','plan_id']);
  assert.equal(draft.references.length,3);
  const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'regions-guide-'));t.after(()=>fs.rm(dataRoot,{recursive:true,force:true}));
  let calls=0;
  const service=createRegionService({dataRoot,childService:{generate:async()=>{calls++;throw Error('inference forbidden');},run:async()=>{calls++;throw Error('inference forbidden');}}});
  const image=(width,height)=>({data:encodePng({width,height,pixels:Buffer.alloc(width*height*4,255)}),mediaType:'image/png',width,height});
  const {references,...params}=draft;
  const saved=await service.generate(params,[image(1024,768),image(256,256),image(256,256)]);
  assert.equal(saved.status,'draft'); assert.equal(calls,0);
  assert.equal((await service.run({run_id:saved.run_id})).status,'draft'); assert.equal(calls,0);
  const full=await service.context({run_id:saved.run_id});
  assert.deepEqual(full.runs[0].params.regions.map(region=>region.reference_index),[1,2]);
  assert.ok(full.runs[0].params.regions.every(region=>region.style==='none'&&region.lora_strength===0),'portable regions are none-only');
  const started=await service.generate({...execute,plan_id:saved.run_id});
  assert.equal(started.status,'running'); assert.equal(calls,0,'execute authorizes; art_run advances children');
});

test('native Edit guide example compiles its exact sampler without a style LoRA or hidden output resize',async()=>{
  const {readGuide}=await import(moduleUrl),guide=await readGuide({topic:'moss-modes'});
  const examples=[...guide.text.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(m=>JSON.parse(m[1]));const example=examples.find(x=>x.backend==='moss'&&x.mode==='edit');assert(example,'native Edit needs a callable example');
  const {references,...input}=example;assert.equal(references.length,1);
  if(Object.hasOwn(input,'style'))assert.equal(input.style,'none','the callable example must stay none-only');
  if(Object.hasOwn(input,'lora_strength'))assert.equal(input.lora_strength,0);
  const params=NATIVE_EDIT_ADAPTER.normalize(input,[{width:768,height:512}]);
  assert.equal(params.model_variant,'native-sft-edit');assert.equal(params.style,'none');assert.equal(params.steps,30);assert.equal(params.cfg,4);assert.equal(params.shift,5);assert.equal(params.sampler,'euler');assert.equal(params.scheduler,'sgm_uniform');assert.equal(params.slg,null);assert.equal(params.width,768);assert.equal(params.height,512);assert.equal(params.reference_max_edge,512);
  const id='00000000-0000-4000-8000-000000000001';const {graph}=NATIVE_EDIT_ADAPTER.compile(params,id,[{name:`moss-${id}-ref1.png`,subfolder:'',type:'input'}]);assert.equal(graph['4'].class_type,'LoraLoaderModelOnly');assert.equal(graph['4'].inputs.lora_name,'MOSS-Image-Edit-rank64.safetensors');assert(!graph['5'],'portable package compiles no style stack');
});

test('native regions guide keeps single-subject crop instructions self-contained rather than repeating whole-scene headcount',async t=>{
  const {readGuide}=await import(moduleUrl),guide=await readGuide({topic:'regions'});const examples=[...guide.text.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(m=>JSON.parse(m[1]));const draft=examples.find(x=>x.mode==='regions'&&x.action==='draft');assert(draft);
  for(const region of draft.regions){assert.match(region.prompt,/one|single/i);assert.match(region.prompt,/light|daylight/i);assert.match(region.prompt,/illustration|paint|ink/i);}
  const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'native-region-guide-'));t.after(()=>fs.rm(dataRoot,{recursive:true,force:true}));let child;
  const service=createRegionService({dataRoot,editEngine:'native',childService:{generate:async input=>{child=input;return{run_id:'00000000-0000-4000-8000-000000000002',status:'unknown'};},run:async()=>{throw Error('unexpected polling');}}});
  const image=(w,h)=>({data:encodePng({width:w,height:h,pixels:Buffer.alloc(w*h*4,255)}),mediaType:'image/png',width:w,height:h});const {references,...input}=draft;
  const saved=await service.generate({...input,prompt:'GLOBAL_ONLY exactly two people in the entire scene'},[image(1024,768),image(256,256),image(256,256)]);await service.generate({mode:'regions',action:'execute',plan_id:saved.run_id});await service.run({run_id:saved.run_id});
  assert(child.prompt.includes(draft.regions[0].prompt));assert(!child.prompt.includes('GLOBAL_ONLY'));assert(!child.prompt.includes('exactly two people'));assert(child.prompt.includes('first image'));
});

test('workbench topic gives callable create propose materialize examples that never submit inference',async t=>{
  const {readGuide}=await import(moduleUrl);let offset=0,complete='';
  do{const page=await readGuide({topic:'workbench',offset,limit:500});assert(page.text.length<=500);complete+=page.text;offset=page.next_offset;}while(offset!==null);
  assert(complete.length<6000);const examples=[...complete.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(match=>JSON.parse(match[1]));
  const wrapped=action=>examples.find(x=>x.mode==='workbench'&&x.workbench?.action===action);
  const create=wrapped('create'),propose=wrapped('propose'),materialize=wrapped('materialize'),importPlan=wrapped('importPlan');
  assert(create&&propose&&materialize&&importPlan,'reference must expose the four supported Agent actions');
  assert(examples.some(x=>x.documents===true));assert(examples.some(x=>typeof x.document_id==='string'&&!x.mode));
  assert(!examples.some(x=>x.workbench?.action==='resolve'));
  const dataRoot=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-guide-'));t.after(()=>fs.rm(dataRoot,{recursive:true,force:true}));let calls=0;
  const workbench=createWorkbenchStore({dataRoot});const service=createRegionService({dataRoot,childService:{generate:async()=>{calls++;throw Error('inference forbidden');},run:async()=>{calls++;throw Error('inference forbidden');}}});
  const image=(w,h)=>({data:encodePng({width:w,height:h,pixels:Buffer.alloc(w*h*4,255)}),mediaType:'image/png',width:w,height:h});
  const bridge=createWorkbenchBridge({getEntry:()=>({dataRoot,workbench,service}),resolveReference:async ref=>ref===create.workbench.references[0]?image(create.workbench.canvas.width,create.workbench.canvas.height):image(256,256)});
  const exec={signal:new AbortController().signal},doc=await bridge(create.workbench,exec);
  const proposal=await bridge({...propose.workbench,document_id:doc.document_id,expected_revision:doc.revision},exec);
  assert.equal(proposal.prompt,doc.prompt,'propose alone cannot apply AI changes');assert.equal(proposal.proposals.at(-1).status,'pending');
  const draft=await bridge({...materialize.workbench,document_id:proposal.document_id,expected_revision:proposal.revision},exec);
  assert.equal(draft.status,'draft');assert.equal(calls,0);assert.equal((await service.run({run_id:draft.run_id})).status,'draft');assert.equal(calls,0);
});

test('quick and index route workbench details without preloading every document contract',async()=>{
  const {readGuide}=await import(moduleUrl),quick=await readGuide({topic:'quick'}),index=await readGuide({topic:'index'});
  assert(quick.text.length<3500);assert(quick.text.includes('workbench'));assert(index.text.includes('workbench'));assert.equal(quick.next_offset,null);
});

test('historical GPU smoke budget never freezes into a current-session budget',async()=>{
  const {readGuide}=await import(moduleUrl);
  for(const topic of ['regions','moss-modes']){const r=await readGuide({topic,limit:9000});assert.ok(r.text.length>0,topic);assert.doesNotMatch(r.text,/2026-10-24/,`${topic} must not pin an old smoke-test date`);assert.doesNotMatch(r.text,/本轮6|本轮.*预算已耗尽/);assert.match(r.text,/授权/,`${topic} keeps authorization-scoped budgeting`);}
});

test('catalog distinguishes none-only styles, native t2i defaults and region pipeline behavior',()=>{
  const c=catalog();assert.equal(c.defaults.style,'none');
  assert.deepEqual(c.styles.map(style=>style.id),['none']);
  assert.equal(c.styles[0].trigger,'');
  const edit=c.modes.find(mode=>mode.id==='edit');
  assert.deepEqual(edit.styles,['none']);
  assert.equal(edit.style_loader,null);assert.equal(edit.style_gpu_validated,false);
  const region=c.modes.find(mode=>mode.id==='regions');assert.ok(region);
  assert.deepEqual(region.actions,['draft','execute']);assert.deepEqual(region.references,[2,4]);
  assert.deepEqual(region.region_count,[1,4]);assert.equal(region.canvas_reference_index,0);assert.equal(region.character_reference_index_min,1);
  assert.equal(region.default_style,'none');assert.deepEqual(region.styles,['none']);assert.equal(region.draft_inference_calls,0);
  assert.equal(region.run_advances_authorized_stages,true);assert.equal(region.view_advances,false);
  assert.equal(region.box_coordinates,'half-open original pixels');assert.equal(region.full_qwen_preserves_outside,false);
  assert.deepEqual(c.styles.find(style=>style.id==='none').models,['base','sft'],'tested t2i support is explicit');
  assert.deepEqual(c.styles.find(style=>style.id==='none').characters_models,['base','sft']);
  assert.equal(c.modes.find(mode=>mode.id==='characters').style_gpu_validated,false,'selectable does not claim visual validation');
});

test('guide rejects paths, excessive output and malformed paging',async()=>{
  const {readGuide}=await import(moduleUrl);
  for(const args of [{topic:'../../secrets'},{topic:'quick',limit:9001},{topic:'quick',offset:-1},{topic:'quick',limit:0},{topic:'quick',offset:0.5},{topic:'quick',file_path:'x'}]) await assert.rejects(()=>readGuide(args));
  const index=await readGuide({topic:'index'});assert.ok(index.text.length<4000);assert.ok(!index.text.includes('teenage_girl_aura'));assert.ok(!index.text.includes('moss_guide'));assert.ok(index.text.includes('art_guide'));
});
