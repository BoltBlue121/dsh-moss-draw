import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const load = () => import('../client/studio-model.mjs');
const copy = value => structuredClone(value);
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const S = '33333333-3333-4333-8333-333333333333';
const doc = () => ({kind:'layout',layout:{width:1024,height:1024,bbox_coord_space:'abs',bbox_format:'xyxy',summary:{caption:'A quiet room'},items:[{id:'cup',label:'object',caption:'A blue cup',bbox:[100,200,300,400]},{id:'note',label:'text',caption:'A sign',text:'Hello',bbox:[400,200,600,400]}]},caption:{caption:'Preserved caption'}});
const page = (id=A) => ({page_id:id,series_id:S,title:id===A?'First':'Second',revision:3,doc:doc(),proposals:[],created_at:'2026-10-24T00:00:00Z',updated_at:'2026-10-24T00:00:00Z'});
function bridgeFixture() {
 const calls=[], pages=new Map([[A,page()],[B,page(B)]]);
 return {calls,pages,async request(action,fields,signal) {
  calls.push({action,fields:copy(fields),signal});
  if(action==='studioState')return {series:[{series_id:S,title:'Series'}],pages:[...pages.values()].map(p=>({page_id:p.page_id,series_id:S,title:p.title,revision:p.revision,kind:p.doc.kind,updated_at:p.updated_at}))};
  if(action==='studioGetPage')return copy(pages.get(fields.page_id));
  if(action==='studioCreateSeries')return {series_id:S,title:fields.title};
  if(action==='studioCreatePage'){const p={...page(B),...copy(fields),revision:1};pages.set(B,p);return copy(p);}
  if(action==='studioCompile')return {prompt:'compiled',checks:[],prefix:'',negative:'',kind:fields.doc.kind,compiled:true};
  if(action==='studioHistory')return {revisions:[{revision:1,operation:'create',created_at:'2026-10-24'}]};
  const p=pages.get(fields.page_id);
  if(fields.expected_revision!==p.revision)throw Error('STUDIO_CONFLICT');
  const updated={...copy(p),revision:p.revision+1};
  if(action==='studioUpdatePage'){updated.doc=copy(fields.doc);if(fields.title!==undefined)updated.title=fields.title;}
  if(action==='studioRestore')updated.doc.layout.summary.caption='Restored';
  pages.set(updated.page_id,updated);return copy(updated);
 },async prompt(...args){calls.push({prompt:args});return {ok:true};}};
}

test('read-only refresh and blank page creation need no references or GPU action',async()=>{
 const {createStudioModel}=await load(),bridge=bridgeFixture(),m=createStudioModel(bridge),controller=new AbortController();
 await m.refresh(controller.signal);assert.deepEqual(bridge.calls.map(c=>c.action),['studioState']);assert.equal(m.getSnapshot().page,null);
 assert.equal(bridge.calls[0].signal,controller.signal);
 await m.createSeries('New series');await m.createPage({series_id:S,title:'Blank',kind:'caption'});
 assert.equal(m.getSnapshot().draft.doc.kind,'caption');assert.equal(m.getSnapshot().draft.doc.caption.caption,'');assert.deepEqual(m.getSnapshot().draft.doc.layout.items,[]);
 assert.deepEqual(Object.keys(bridge.calls[2].fields).sort(),['doc','series_id','title']);
});

test('document edits, mode switching, undo and redo are purely local and preserve both modes',async()=>{
 const {createStudioModel}=await load(),bridge=bridgeFixture(),m=createStudioModel(bridge);await m.open(A);
 m.patchSummary({caption:'Changed'});m.setKind('caption');m.setCaption('New caption');m.setKind('layout');
 assert.equal(m.getSnapshot().draft.doc.layout.summary.caption,'Changed');assert.equal(m.getSnapshot().draft.doc.caption.caption,'New caption');
 m.undo();assert.equal(m.getSnapshot().draft.doc.kind,'caption');m.redo();assert.equal(m.getSnapshot().draft.doc.kind,'layout');
 assert.equal(m.getSnapshot().page.doc.layout.summary.caption,'A quiet room');assert.equal(m.getSnapshot().dirty,true);assert.equal(bridge.calls.length,1);
 while(m.getSnapshot().undo.length)m.undo();assert.equal(m.getSnapshot().dirty,false);
});

test('dirty page switch requires confirmation and preserves a separate cached draft with its undo stack',async()=>{
 const {createStudioModel}=await load(),m=createStudioModel(bridgeFixture());await m.open(A);m.patchTitle('Unsaved first');m.select('cup');
 await assert.rejects(m.open(B),/STUDIO_DIRTY/);assert.equal(m.getSnapshot().page.page_id,A);
 await m.open(B,{keepDraft:true});assert.equal(m.getSnapshot().dirty,false);assert.deepEqual(m.getSnapshot().selected,[]);
 await m.open(A);assert.equal(m.getSnapshot().draft.title,'Unsaved first');assert.equal(m.getSnapshot().dirty,true);m.undo();assert.equal(m.getSnapshot().draft.title,'First');
});

test('save sends exact CAS fields and retains edits made while the response is pending',async()=>{
 const {createStudioModel}=await load(),bridge=bridgeFixture();let release,submitted;
 const request=bridge.request.bind(bridge);bridge.request=async(action,fields,signal)=>{if(action!=='studioUpdatePage')return request(action,fields,signal);submitted=copy(fields);return new Promise(resolve=>{release=()=>resolve({...page(),title:fields.title,doc:copy(fields.doc),revision:4});});};
 const m=createStudioModel(bridge);await m.open(A);m.patchTitle('Saved title');m.patchSummary({caption:'Submitted'});const pending=m.save();m.patchSummary({caption:'Typed later'});release();await pending;
 assert.deepEqual(Object.keys(submitted).sort(),['doc','expected_revision','page_id','title']);assert.equal(submitted.expected_revision,3);
 assert.equal(m.getSnapshot().page.doc.layout.summary.caption,'Submitted');assert.equal(m.getSnapshot().draft.doc.layout.summary.caption,'Typed later');assert.equal(m.getSnapshot().page.revision,4);assert.equal(m.getSnapshot().dirty,true);
});

test('CAS conflict preserves draft and identifies the error without a forced overwrite',async()=>{
 const {createStudioModel}=await load(),b=bridgeFixture(),m=createStudioModel(b);await m.open(A);m.patchTitle('Keep me');b.pages.get(A).revision=4;
 await assert.rejects(m.save(),/STUDIO_CONFLICT/);assert.equal(m.getSnapshot().conflict,true);assert.equal(m.getSnapshot().draft.title,'Keep me');assert.equal(m.getSnapshot().page.revision,3);
});

test('copy, delete, hide, lock, group and order are local; locked properties cannot be edited',async()=>{
 const {createStudioModel}=await load(),b=bridgeFixture(),m=createStudioModel(b);await m.open(A);m.select('cup');m.select('note',true);m.groupSelection();
 const group=m.getSnapshot().draft.doc.layout.items[0].group;assert.ok(group);assert.equal(m.getSnapshot().draft.doc.layout.items[1].group,group);
 m.clearSelection();m.select('cup');assert.equal(m.getSnapshot().selected.length,2);m.select('cup',false,true);m.setItemFlag('cup','locked',true);
 assert.throws(()=>m.patchItem('cup',{caption:'Forbidden'}),/STUDIO_LOCKED/);m.deleteSelection();assert.equal(m.getSnapshot().draft.doc.layout.items.length,2);
 m.setItemFlag('cup','locked',false);m.setItemFlag('cup','hidden',true);m.copySelection();
 assert.equal(m.getSnapshot().draft.doc.layout.items.length,3);const duplicate=m.getSnapshot().selected[0];assert.notEqual(duplicate,'cup');
 m.orderSelection('back');assert.equal(m.getSnapshot().draft.doc.layout.items[0].id,duplicate);m.deleteSelection();assert.equal(m.getSnapshot().draft.doc.layout.items.length,2);assert.equal(b.calls.length,1);
});

test('rectangle creation, move/resize transaction, zoom and fit keep gestures to one undo entry',async()=>{
 const {createStudioModel,studioPoint,resizeStudioBox}=await load(),m=createStudioModel(bridgeFixture());await m.open(A);
 assert.deepEqual(studioPoint({clientX:60,clientY:70},{left:10,top:20,width:512,height:512},{width:1024,height:1024}),[100,100]);
 assert.deepEqual(resizeStudioBox([100,200,300,400],'nw',20,30),[120,230,300,400]);
 for(const handle of ['n','ne','e','se','s','sw','w','nw']){const box=resizeStudioBox([100,200,300,400],handle,20,30);assert.ok(box[2]>box[0]&&box[3]>box[1]);}
 const id=m.addItem('character',[20,30,120,230]);m.beginGesture();m.moveSelection(10,10);m.moveSelection(10,10);m.endGesture();
 assert.deepEqual(m.getSnapshot().draft.doc.layout.items.find(i=>i.id===id).bbox,[40,50,140,250]);m.undo();assert.deepEqual(m.getSnapshot().draft.doc.layout.items.find(i=>i.id===id).bbox,[20,30,120,230]);
 m.setZoom(100);assert.equal(m.getSnapshot().zoom,4);m.fit(512,512);assert.ok(m.getSnapshot().zoom<0.5);
});

test('compile is local-document only, exposes checks and marks result stale after later edits',async()=>{
 const {createStudioModel}=await load(),b=bridgeFixture(),m=createStudioModel(b);await m.open(A);await m.compile();
 assert.equal(m.getSnapshot().compiled.prompt,'compiled');assert.equal(m.getSnapshot().compileStale,false);m.setCaption('new');assert.equal(m.getSnapshot().compileStale,true);
 assert.deepEqual(b.calls.map(c=>c.action),['studioGetPage','studioCompile']);assert.deepEqual(Object.keys(b.calls[1].fields),['doc']);
});

test('late compile does not present a result for the wrong local draft as current',async()=>{
 const {createStudioModel}=await load();let release;const b=bridgeFixture(),request=b.request.bind(b);b.request=async(a,f)=>a==='studioCompile'?new Promise(r=>{release=()=>r({compiled:false,prompt:'',checks:[{code:'STUDIO_CAMERA_ADAPTER_REQUIRED',message:'Adapter pending'}],prefix:'',negative:'',kind:'layout'});}):request(a,f);
 const m=createStudioModel(b);await m.open(A);const pending=m.compile();m.patchSummary({caption:'Later'});release();await pending;assert.equal(m.getSnapshot().compileStale,true);assert.equal(m.getSnapshot().compiled.checks[0].code,'STUDIO_CAMERA_ADAPTER_REQUIRED');
});

test('proposal diff names changed fields/items only, and reorder uses the exclusive whole-items selector',async()=>{
 const {studioProposalChanges}=await load(),base=doc(),next=doc();next.layout.summary.caption='New';next.layout.items[0].caption='Red cup';
 assert.deepEqual(studioProposalChanges({base_doc:base,proposed_doc:next}).map(c=>c.key),['layout.summary','item:cup']);
 next.layout.items.reverse();assert.deepEqual(studioProposalChanges({base_doc:base,proposed_doc:next}).map(c=>c.key),['layout.summary','layout.items']);
});

test('proposal/history/restore use page CAS and reject dirty state; agent sends only page binding and request',async()=>{
 const {createStudioModel}=await load(),b=bridgeFixture(),m=createStudioModel(b);await m.open(A);
 await m.propose(doc(),'Suggested edit');await m.resolve('proposal-id',['item:cup'],false);await m.history();await m.restore(1);
 assert.equal(m.getSnapshot().draft.doc.layout.summary.caption,'Restored');assert.equal(m.getSnapshot().page.revision,6);
 const resolve=b.calls.find(c=>c.action==='studioResolve');assert.deepEqual(resolve.fields,{page_id:A,expected_revision:4,proposal_id:'proposal-id',accept:['item:cup'],reject:false});
 const signal=new AbortController().signal;await m.sendToAgent('Make the cup green','steer',signal);const prompt=b.calls.find(c=>c.prompt).prompt;
 assert.match(prompt[0],new RegExp(A));assert.match(prompt[0],/revision=6/);assert.match(prompt[0],/Make the cup green/);assert.doesNotMatch(prompt[0],/A blue cup|Preserved caption|created_at/);assert.equal(prompt[1],'steer');assert.equal(prompt[2],signal);
 m.patchTitle('Local');await assert.rejects(m.resolve('x',[],true),/STUDIO_SAVE_FIRST/);await assert.rejects(m.sendToAgent('Change it'),/STUDIO_SAVE_FIRST/);
});

for(const mutation of ['propose','resolve','restore'])test(`${mutation} preserves edits made after its request begins`,async()=>{
 const {createStudioModel}=await load(),b=bridgeFixture(),request=b.request.bind(b);let release;
 b.request=async(a,f)=>a==='studioGetPage'?request(a,f):new Promise(r=>{release=()=>r({...page(),revision:4,doc:{...doc(),caption:{caption:'Server caption'}}});});
 const m=createStudioModel(b);await m.open(A);const pending=mutation==='propose'?m.propose(doc(),'test'):mutation==='resolve'?m.resolve('proposal',[],true):m.restore(1);m.patchSummary({caption:'Typed later'});release();await pending;
 assert.equal(m.getSnapshot().page.revision,4);assert.equal(m.getSnapshot().draft.doc.layout.summary.caption,'Typed later');assert.equal(m.getSnapshot().draft.doc.caption.caption,'Server caption');assert.equal(m.getSnapshot().dirty,true);
});

test('semantic comparison ignores JSON object property insertion order',async()=>{
 const {studioProposalChanges,createStudioModel}=await load(),before=doc(),after=doc();after.layout.summary={caption:'A quiet room'};after.layout.items[0]={bbox:[100,200,300,400],caption:'A blue cup',label:'object',id:'cup'};
 assert.deepEqual(studioProposalChanges({base_doc:before,proposed_doc:after}),[]);
 const m=createStudioModel(bridgeFixture());await m.open(A);m.patchSummary({caption:'A quiet room'});assert.equal(m.getSnapshot().dirty,false);
});

test('structured Host error code is preserved in model error and conflict state',async()=>{
 const {createStudioModel}=await load(),b=bridgeFixture(),m=createStudioModel(b);await m.open(A);m.patchTitle('Not lost');b.request=async()=>{throw Object.assign(Error('Page revision changed'),{code:'STUDIO_CONFLICT'});};
 await assert.rejects(m.save(),/Page revision changed/);assert.equal(m.getSnapshot().conflict,true);assert.match(m.getSnapshot().error,/STUDIO_CONFLICT/);assert.equal(m.getSnapshot().draft.title,'Not lost');
});

test('late item edits merge by id without undo or later save reverting accepted server changes',async()=>{
 const {createStudioModel}=await load(),b=bridgeFixture(),request=b.request.bind(b);let release;
 b.request=async(a,f)=>a==='studioResolve'?new Promise(r=>{release=()=>{const p=page();p.revision=4;p.doc.layout.items[0].caption='Accepted green cup';b.pages.set(A,p);r(copy(p));};}):request(a,f);
 const m=createStudioModel(b);await m.open(A);m.patchTitle('Already saved');await m.save();
 const pending=m.resolve('proposal',['item:cup']);m.patchItem('note',{text:'Typed later'});release();await pending;
 assert.equal(m.getSnapshot().draft.doc.layout.items[0].caption,'Accepted green cup');assert.equal(m.getSnapshot().draft.doc.layout.items[1].text,'Typed later');
 m.undo();assert.equal(m.getSnapshot().draft.doc.layout.items[0].caption,'Accepted green cup');assert.equal(m.getSnapshot().draft.doc.layout.items[1].text,'Hello');assert.equal(m.getSnapshot().undo.length,0);
 m.redo();await m.save();assert.equal(m.getSnapshot().page.doc.layout.items[0].caption,'Accepted green cup');
});

test('late item additions/deletions preserve unrelated server additions and field changes',async()=>{
 const {createStudioModel}=await load(),b=bridgeFixture(),request=b.request.bind(b);let release;
 b.request=async(a,f)=>a==='studioRestore'?new Promise(r=>{release=()=>{const p=page();p.revision=4;p.doc.layout.items[0].caption='Server cup';p.doc.layout.items.push({id:'server',label:'object',caption:'Server new item',bbox:[20,20,40,40]});r(p);};}):request(a,f);
 const m=createStudioModel(b);await m.open(A);const pending=m.restore(1);m.select('note');m.deleteSelection();const localId=m.addItem('text');m.patchItem('cup',{name:'Local cup name'});release();await pending;
 const items=m.getSnapshot().draft.doc.layout.items;assert.equal(items.find(i=>i.id==='cup').caption,'Server cup');assert.equal(items.find(i=>i.id==='cup').name,'Local cup name');assert.ok(items.some(i=>i.id==='server'));assert.ok(items.some(i=>i.id===localId));assert.equal(items.some(i=>i.id==='note'),false);
});

for(const limit of ['items','bytes'])test(`invalid ${limit} merge retains valid local draft and server page until explicit recovery`,async()=>{
 const {createStudioModel}=await load(),{validateStudioDoc}=await import('../src/studio-domain.mjs'),b=bridgeFixture(),request=b.request.bind(b);let release;
 const initial=page();initial.doc.layout.items=Array.from({length:limit==='items'?127:42},(_,index)=>({id:`item-${index}`,label:'object',caption:limit==='items'?'item':'x'.repeat(12000),bbox:[10,10,30,30]}));b.pages.set(A,initial);
 const next=copy(initial);next.revision=4;next.doc.layout.items.push({id:'server-add',label:'object',caption:'s'.repeat(limit==='items'?1:12000),bbox:[40,40,60,60]});validateStudioDoc(next.doc);
 b.request=async(a,f)=>a==='studioResolve'?new Promise(r=>{release=()=>{b.pages.set(A,copy(next));r(copy(next));};}):request(a,f);
 const m=createStudioModel(b);await m.open(A);const emitted=[];const off=m.subscribe(()=>{if(m.getSnapshot().draft)emitted.push(copy(m.getSnapshot().draft.doc));});
 const pending=m.resolve('proposal',['item:server-add']);const local=m.addItem('object');if(limit==='bytes')m.patchItem(local,{caption:'l'.repeat(12000)});const localDoc=copy(m.getSnapshot().draft.doc);release();await pending;
 assert.deepEqual(m.getSnapshot().draft.doc,localDoc);assert.equal(m.getSnapshot().page.revision,4);assert.ok(m.getSnapshot().page.doc.layout.items.some(i=>i.id==='server-add'));assert.equal(m.getSnapshot().conflict,true);assert.match(m.getSnapshot().error,/STUDIO_MERGE_CONFLICT/);
 for(const d of emitted)validateStudioDoc(d);off();
 const {createStudioView}=await import('../client/studio-view.mjs');const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),useState:init=>[typeof init==='function'?init():init,()=>{}],useRef:value=>({current:value}),useEffect:()=>{}};const tree=createStudioView(React)({model:m,sessionId:'s'}),nodes=[];const visit=n=>{if(n&&typeof n==='object'){nodes.push(n);n.children?.forEach(visit);}};visit(tree);assert.equal(nodes.find(n=>n.type==='button'&&n.children.includes('保存')).props.disabled,true);
 assert.doesNotThrow(()=>m.patchTitle('Still editable'));await assert.rejects(m.save(),/STUDIO_MERGE_CONFLICT/);
 await m.open(B,{keepDraft:true});await m.open(A);assert.equal(m.getSnapshot().mergeBlocked,true);await assert.rejects(m.save(),/STUDIO_MERGE_CONFLICT/);
 m.select('item-0');m.deleteSelection();await m.reload();assert.equal(m.getSnapshot().mergeBlocked,false);assert.ok(m.getSnapshot().draft.doc.layout.items.some(i=>i.id==='server-add'));assert.ok(m.getSnapshot().draft.doc.layout.items.some(i=>i.id===local));validateStudioDoc(m.getSnapshot().draft.doc);
 await m.reload({discard:true});assert.equal(m.getSnapshot().dirty,false);assert.equal(m.getSnapshot().draft.doc.layout.items.some(i=>i.id===local),false);
});

test('cancelled pointer gesture restores the prior redo history',async()=>{
 const {createStudioModel}=await load(),m=createStudioModel(bridgeFixture());await m.open(A);m.select('cup');m.moveSelection(10,0);m.undo();assert.equal(m.getSnapshot().redo.length,1);
 m.beginGesture();m.moveSelection(25,0);m.endGesture(true);assert.deepEqual(m.getSnapshot().draft.doc.layout.items[0].bbox,[100,200,300,400]);assert.equal(m.getSnapshot().redo.length,1);m.redo();assert.deepEqual(m.getSnapshot().draft.doc.layout.items[0].bbox,[110,200,310,400]);
});

test('conflict reload can merge local draft onto latest revision or explicitly discard it',async()=>{
 const {createStudioModel}=await load(),b=bridgeFixture(),m=createStudioModel(b);await m.open(A);m.patchItem('note',{text:'Local note'});b.pages.get(A).revision=4;b.pages.get(A).doc.layout.items[0].caption='Remote cup';
 await assert.rejects(m.save(),/STUDIO_CONFLICT/);await m.reload();assert.equal(m.getSnapshot().page.revision,4);assert.equal(m.getSnapshot().draft.doc.layout.items[0].caption,'Remote cup');assert.equal(m.getSnapshot().draft.doc.layout.items[1].text,'Local note');assert.equal(m.getSnapshot().dirty,true);
 await m.reload({discard:true});assert.equal(m.getSnapshot().dirty,false);assert.equal(m.getSnapshot().draft.doc.layout.items[1].text,'Hello');
});

test('selection is pruned when undo removes an added item',async()=>{
 const {createStudioModel}=await load(),m=createStudioModel(bridgeFixture());await m.open(A);m.addItem('object');assert.equal(m.getSnapshot().selected.length,1);m.undo();assert.deepEqual(m.getSnapshot().selected,[]);
});

test('edits made during an open request survive on the source page rather than being lost',async()=>{
 const {createStudioModel}=await load(),b=bridgeFixture(),request=b.request.bind(b);let release;
 b.request=async(a,f)=>a==='studioGetPage'&&f.page_id===B?new Promise(r=>{release=()=>r(page(B));}):request(a,f);
 const m=createStudioModel(b);await m.open(A);const pending=m.open(B);m.patchTitle('While loading second');release();await pending;await m.open(A);
 assert.equal(m.getSnapshot().draft.title,'While loading second');assert.equal(m.getSnapshot().dirty,true);
});

test('same-page reload preserves typed changes and marks server revision conflict',async()=>{
 const {createStudioModel}=await load(),b=bridgeFixture(),m=createStudioModel(b);await m.open(A);let release;
 b.request=async()=>new Promise(r=>{release=()=>r({...page(),revision:4});});
 const pending=m.open(A,{reload:true});m.patchSummary({caption:'Typed during reload'});release();await pending;
 assert.equal(m.getSnapshot().draft.doc.layout.summary.caption,'Typed during reload');assert.equal(m.getSnapshot().dirty,true);assert.equal(m.getSnapshot().page.revision,4);
});

test('compile consumes real domain and partial proposal applies via real SQLite store',async()=>{
 const {createStudioModel}=await load(),{createStudioStore}=await import('../src/studio-store.mjs'),{compileStudioDoc}=await import('../src/studio-domain.mjs');
 const root=await mkdtemp(path.join(os.tmpdir(),'studio-client-'));
 try{
  const store=createStudioStore({dataRoot:root}),actions={studioState:'state',studioCreateSeries:'createSeries',studioCreatePage:'createPage',studioGetPage:'getPage',studioUpdatePage:'updatePage',studioPropose:'propose',studioResolve:'resolve',studioHistory:'history',studioRestore:'restore'};
  const m=createStudioModel({request:async(action,fields)=>action==='studioCompile'?compileStudioDoc(fields.doc):store[actions[action]](fields)});
  await m.refresh();const series=await m.createSeries('Real series');await m.createPage({series_id:series.series_id,title:'Real page',doc:doc()});await m.compile();
  assert.equal(m.getSnapshot().compiled.compiled,true);const prompt=JSON.parse(m.getSnapshot().compiled.prompt);assert.deepEqual(prompt.items[0].bbox,[-312,-412,-112,-212]);
  const proposed=copy(m.getSnapshot().draft.doc);proposed.layout.items[0].caption='Green cup';proposed.caption.caption='Unaccepted caption';await m.propose(proposed,'Cup change');
  const proposal=m.getSnapshot().page.proposals[0];await m.resolve(proposal.proposal_id,['item:cup']);assert.equal(m.getSnapshot().draft.doc.layout.items[0].caption,'Green cup');assert.equal(m.getSnapshot().draft.doc.caption.caption,'Preserved caption');
  await m.history();assert.equal(m.getSnapshot().history.length,3);await m.restore(1);assert.equal(m.getSnapshot().page.revision,4);assert.equal(m.getSnapshot().draft.doc.layout.items[0].caption,'A blue cup');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('view title follows undo and keyboard shortcuts never intercept text entry',async()=>{
 const {createStudioView}=await import('../client/studio-view.mjs'),{createStudioModel}=await load(),m=createStudioModel(bridgeFixture());await m.open(A);m.patchTitle('Renamed');
 const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),useState:init=>[typeof init==='function'?init():init,()=>{}],useRef:value=>({current:value}),useEffect:()=>{}};
 const View=createStudioView(React),tree=View({model:m,sessionId:'s'}),nodes=[];const visit=n=>{if(n&&typeof n==='object'){nodes.push(n);n.children?.forEach(visit);}};visit(tree);
 const title=nodes.find(n=>n.props['aria-label']==='页面标题');assert.equal(title.props.value,'Renamed');
 assert.ok(nodes.some(n=>n.type==='button'&&n.children.includes('保留草稿并读取最新')&&!n.props.disabled));assert.ok(nodes.some(n=>n.type==='button'&&n.children.includes('放弃本地并重载')&&!n.props.disabled));
 let prevented=false;tree.props.onKeyDown({key:'z',ctrlKey:true,target:{closest:()=>true},preventDefault:()=>{prevented=true;},stopPropagation:()=>{}});assert.equal(prevented,false);assert.equal(m.getSnapshot().draft.title,'Renamed');
 tree.props.onKeyDown({key:'z',ctrlKey:true,target:{closest:()=>false},preventDefault:()=>{prevented=true;},stopPropagation:()=>{}});assert.equal(prevented,true);assert.equal(m.getSnapshot().draft.title,'First');
});

test('SVG handlers draw a rectangle, expose eight handles, resize and leave wheel navigation untouched',async()=>{
 const {createStudioView}=await import('../client/studio-view.mjs'),{createStudioModel}=await load(),m=createStudioModel(bridgeFixture());await m.open(A);m.setTool('draw');
 let refIndex=0;const refs=[];
 const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),useState:init=>[typeof init==='function'?init():init,()=>{}],useRef:value=>refs[refIndex++]??(refs[refIndex-1]={current:value}),useEffect:()=>{}};
 const View=createStudioView(React),render=()=>{refIndex=0;const tree=View({model:m,sessionId:'s'}),nodes=[];const visit=n=>{if(n&&typeof n==='object'){nodes.push(n);n.children?.forEach(visit);}};visit(tree);return nodes;};
 const event=(x,y)=>({clientX:x,clientY:y,button:0,pointerId:1,preventDefault(){},stopPropagation(){}});
 let nodes=render(),svg=nodes.find(n=>n.type==='svg');svg.props.ref.current={getBoundingClientRect:()=>({left:0,top:0,width:512,height:512}),focus(){},setPointerCapture(){},releasePointerCapture(){}};
 svg.props.onPointerDown(event(50,60));svg.props.onPointerMove(event(150,160));svg.props.onPointerUp(event(150,160));
 const id=m.getSnapshot().selected[0];assert.deepEqual(m.getSnapshot().draft.doc.layout.items.find(i=>i.id===id).bbox,[100,120,300,320]);
 nodes=render();svg=nodes.find(n=>n.type==='svg');const handles=nodes.filter(n=>n.props['data-handle']);assert.equal(handles.length,8);assert.equal(svg.props.onWheel,undefined);
 handles.find(n=>n.props['data-handle']==='nw').props.onPointerDown(event(50,60));svg.props.onPointerMove(event(60,70));svg.props.onPointerUp(event(60,70));
 assert.deepEqual(m.getSnapshot().draft.doc.layout.items.find(i=>i.id===id).bbox,[120,140,300,320]);m.undo();assert.deepEqual(m.getSnapshot().draft.doc.layout.items.find(i=>i.id===id).bbox,[100,120,300,320]);
});

test('view mounts externally owned model, refreshes once, unsubscribes without disposal and renders caption/layout controls',async()=>{
 const {createStudioView}=await import('../client/studio-view.mjs'),{createStudioModel}=await load(),m=createStudioModel(bridgeFixture());await m.open(A);
 let effects=[],subscribed=0,unsubscribed=0,disposed=0,refreshed=0;
 const actualSubscribe=m.subscribe;m.subscribe=fn=>{subscribed++;const unsub=actualSubscribe(fn);return()=>{unsubscribed++;unsub();};};m.dispose=()=>disposed++;m.refresh=async()=>refreshed++;
 const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),useState:init=>[typeof init==='function'?init():init,()=>{}],useRef:value=>({current:value}),useEffect:fn=>{effects.push(fn);}};
 const View=createStudioView(React),tree=View({model:m,sessionId:'same-session'}),cleanups=effects.map(effect=>effect());await Promise.resolve();
 const nodes=[];const visit=n=>{if(n&&typeof n==='object'){nodes.push(n);n.children?.forEach(visit);}};visit(tree);
 assert.equal(tree.props.className,'mps-studio');assert.ok(nodes.some(n=>n.type==='svg'));assert.ok(nodes.some(n=>n.type==='button'&&n.children.includes('编译预览')));assert.ok(nodes.some(n=>n.type==='button'&&n.children.includes('保存')));
 assert.equal(subscribed,1);assert.equal(refreshed,1);cleanups.forEach(cleanup=>cleanup?.());assert.equal(unsubscribed,1);assert.equal(disposed,0);
});
