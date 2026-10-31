import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
const api=await import('../src/workbench-store.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const camera={orbit:0,pitch:0,roll:0,distance:5,fov:50,pan_x:0,pan_y:0,pan_z:0};
const region=(id='left',extra={})=>({id,box:[16,16,140,240],reference_index:1,prompt:`Character ${id}.`,...extra});
const initial=(extra={})=>({title:'Scene',canvas:{width:320,height:256,reference:'visible/base.png'},references:['visible/base.png','attachment:character-1'],regions:[region()],prompt:'A quiet garden.',...extra});
async function setup(t){assert.equal(typeof api.createWorkbenchStore,'function','workbench document store must exist');const dataRoot=await mkdtemp(path.join(tmpdir(),'workbench-store-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));return{dataRoot,store:()=>api.createWorkbenchStore({dataRoot})};}

test('create persists detached bounded document and camera defaults across instances without reading references',async t=>{
 const f=await setup(t),s=f.store(),input=initial();const d=await s.create(input);assert.match(d.document_id,/^[0-9a-f-]{36}$/);assert.equal(d.revision,1);assert.deepEqual(d.camera,camera);assert.equal(d.qwen_full_prompt,'');assert.equal(d.regions[0].style,'none');assert.equal(d.regions[0].lora_strength,0);assert.equal(d.regions[0].locked,false);assert(Number.isSafeInteger(d.regions[0].seed));assert.deepEqual(d.proposals,[]);
 input.regions[0].box[0]=99;d.references[0]='changed';d.camera.fov=100;
 const loaded=await f.store().get({document_id:d.document_id});assert.equal(loaded.regions[0].box[0],16);assert.equal(loaded.references[0],'visible/base.png');assert.equal(loaded.camera.fov,50);
 assert.equal((await s.list()).documents[0].document_id,d.document_id);assert.deepEqual((await s.history({document_id:d.document_id})).revisions.map(r=>[r.revision,r.operation]),[[1,'create']]);
});

test('update uses revision CAS and retains immutable previous snapshots for restore',async t=>{
 const f=await setup(t),s=f.store(),d=await s.create(initial());const u=await s.update({document_id:d.document_id,expected_revision:1,patch:{prompt:'New garden',camera:{orbit:30}}});
 assert.equal(u.revision,2);assert.equal(u.camera.orbit,30);assert.equal(u.camera.fov,50);assert.equal(u.prompt,'New garden');
 await assert.rejects(f.store().update({document_id:d.document_id,expected_revision:1,patch:{title:'stale'}}),{code:'WORKBENCH_CONFLICT'});
 const restored=await s.restore({document_id:d.document_id,expected_revision:2,revision:1});assert.equal(restored.revision,3);assert.equal(restored.prompt,'A quiet garden.');assert.deepEqual(restored.camera,camera);assert.equal(restored.document_id,d.document_id);
 assert.deepEqual((await s.history({document_id:d.document_id})).revisions.map(r=>r.revision),[3,2,1]);assert.equal((await s.get({document_id:d.document_id})).title,'Scene');
});

test('proposal preserves content until partial region acceptance and closes all unselected changes',async t=>{
 const f=await setup(t),s=f.store(),d=await s.create(initial({regions:[region(),region('right',{box:[160,16,300,240]})]}));
 const p=await s.propose({document_id:d.document_id,expected_revision:1,summary:'Move left; rewrite global prompt',patch:{prompt:'Unaccepted prompt',regions:[{...d.regions[0],box:[20,20,144,244]},{...d.regions[1],prompt:'Unaccepted right'}]}});
 assert.equal(p.revision,2);assert.equal(p.prompt,d.prompt);assert.deepEqual(p.regions,d.regions);const proposal=p.proposals[0];assert.equal(proposal.base_revision,1);assert.equal(proposal.submitted_revision,2);assert.equal(proposal.status,'pending');assert.equal(proposal.patch.regions[0].box[0],20);
 const a=await s.resolve({document_id:d.document_id,expected_revision:2,proposal_id:proposal.proposal_id,accept:['region:left']});assert.equal(a.revision,3);assert.equal(a.regions[0].box[0],20);assert.deepEqual(a.regions[1],d.regions[1]);assert.equal(a.prompt,d.prompt);assert.equal(a.proposals[0].status,'accepted');assert.deepEqual(a.proposals[0].accepted,['region:left']);
 await assert.rejects(s.resolve({document_id:d.document_id,expected_revision:3,proposal_id:proposal.proposal_id,accept:['prompt']}),{code:'WORKBENCH_CONFLICT'});
});

test('stale proposal never overwrites a later manual edit even when caller has latest revision',async t=>{
 const f=await setup(t),s=f.store(),d=await s.create(initial());const p=await s.propose({document_id:d.document_id,expected_revision:1,patch:{prompt:'AI change'},summary:'AI'});const id=p.proposals[0].proposal_id;
 await s.update({document_id:d.document_id,expected_revision:2,patch:{prompt:'Human change'}});
 await assert.rejects(s.resolve({document_id:d.document_id,expected_revision:3,proposal_id:id,accept:['prompt']}),{code:'WORKBENCH_CONFLICT'});assert.equal((await s.get({document_id:d.document_id})).prompt,'Human change');
});

test('reject records a revision without changing content and restore cannot reactivate proposals',async t=>{
 const f=await setup(t),s=f.store(),d=await s.create(initial());const p=await s.propose({document_id:d.document_id,expected_revision:1,patch:{prompt:'Not accepted'},summary:'AI'});
 const rejected=await s.resolve({document_id:d.document_id,expected_revision:2,proposal_id:p.proposals[0].proposal_id,accept:[],reject:true});assert.equal(rejected.revision,3);assert.equal(rejected.prompt,d.prompt);assert.equal(rejected.proposals[0].status,'rejected');
 const restored=await s.restore({document_id:d.document_id,expected_revision:3,revision:2});assert.equal(restored.revision,4);assert.equal(restored.proposals[0].status,'rejected');
});

test('region selector adds or removes exactly one region while only regions selector reorders the whole list',async t=>{
 const f=await setup(t),s=f.store();let d=await s.create(initial({regions:[region(),region('right',{box:[160,16,300,240]})]}));
 let p=await s.propose({document_id:d.document_id,expected_revision:d.revision,patch:{regions:[d.regions[1],region('third',{box:[40,20,100,100]})]},summary:'Remove left/add third/reorder'});
 d=await s.resolve({document_id:d.document_id,expected_revision:p.revision,proposal_id:p.proposals.at(-1).proposal_id,accept:['region:third']});assert.deepEqual(d.regions.map(r=>r.id),['left','right','third']);
 p=await s.propose({document_id:d.document_id,expected_revision:d.revision,patch:{regions:[d.regions[2],d.regions[1]]},summary:'Remove left'});
 d=await s.resolve({document_id:d.document_id,expected_revision:p.revision,proposal_id:p.proposals.at(-1).proposal_id,accept:['region:left']});assert.deepEqual(d.regions.map(r=>r.id),['right','third']);
 p=await s.propose({document_id:d.document_id,expected_revision:d.revision,patch:{regions:[d.regions[1],d.regions[0]]},summary:'Reorder'});
 d=await s.resolve({document_id:d.document_id,expected_revision:p.revision,proposal_id:p.proposals.at(-1).proposal_id,accept:['regions']});assert.deepEqual(d.regions.map(r=>r.id),['third','right']);
});

test('locked existing regions cannot be replaced removed reordered or unlocked by proposals',async t=>{
 const f=await setup(t),s=f.store();let d=await s.create(initial({regions:[region('left',{locked:true}),region('right',{box:[160,16,300,240]})]}));
 for(const regions of [[{...d.regions[0],prompt:'changed'},d.regions[1]],[d.regions[1]],[d.regions[1],d.regions[0]],[{...d.regions[0],locked:false},d.regions[1]]]) await assert.rejects(s.propose({document_id:d.document_id,expected_revision:1,patch:{regions},summary:'touch locked'}),{code:'WORKBENCH_LOCKED'});
 d=await s.update({document_id:d.document_id,expected_revision:1,patch:{regions:[{...d.regions[0],locked:false},d.regions[1]]}});
 const p=await s.propose({document_id:d.document_id,expected_revision:2,patch:{regions:[{...d.regions[0],prompt:'now allowed'},d.regions[1]]},summary:'unlocked'});assert.equal(p.revision,3);
});

test('strict document validation rejects path IDs malformed shapes and immutable asset replacement',async t=>{
 const f=await setup(t),s=f.store();
 for(const input of [initial({canvas:{width:320,height:256,reference:'wrong'}}),initial({references:['one']}),initial({regions:[]}),initial({regions:[region(),region()]}),initial({regions:[region('a',{box:[-1,0,100,100]})]}),initial({regions:[region('a',{reference_index:0})]}),initial({regions:[region('a',{style:['none']})]}),initial({regions:[region('a',{seed:-1})]}),initial({regions:[region('a',{url:'http://example'})]}),initial({camera:{fov:NaN}}),initial({camera:{shell:'bad'}}),initial({regions:[region('a',{body:{x:0,y:0,width:-1,height:1}})]}),initial({references:['x'.repeat(4097),'ref']}),initial({prompt:'x'.repeat(12001)}),initial({canvas:{width:4096,height:4096,reference:'visible/base.png'}})]) await assert.rejects(s.create(input),{code:'INVALID_INPUT'});
 const d=await s.create(initial());
 for(const patch of [{canvas:d.canvas},{references:d.references},{document_id:d.document_id},{revision:99},{shell:'bad'}]) await assert.rejects(s.update({document_id:d.document_id,expected_revision:1,patch}),{code:'INVALID_INPUT'});
 await assert.rejects(s.get({document_id:'../escape'}),{code:'INVALID_INPUT'});await assert.rejects(s.list({limit:101}),{code:'INVALID_INPUT'});await assert.rejects(s.history({document_id:d.document_id,limit:101}),{code:'INVALID_INPUT'});
});

test('selectors and proposed partial results cannot violate bounds or select non-proposed values',async t=>{
 const f=await setup(t),s=f.store(),d=await s.create(initial({regions:[region('a'),region('b'),region('c'),region('d')]}));
 const p=await s.propose({document_id:d.document_id,expected_revision:1,summary:'swap',patch:{regions:[...d.regions.slice(1),region('e')]}});const pid=p.proposals[0].proposal_id;
 for(const accept of [['region:e'],['region:missing'],['prompt'],['regions','region:a'],['region:a','region:a'],[]]) await assert.rejects(s.resolve({document_id:d.document_id,expected_revision:2,proposal_id:pid,accept}),{code:'INVALID_INPUT'});
 assert.equal((await s.get({document_id:d.document_id})).revision,2);
});

test('sparse reference region and box arrays fail before they can persist null entries',async t=>{
 const f=await setup(t),s=f.store();const references=['visible/base.png'];references.length=2;
 const regions=[];regions.length=1;const box=[16,16,140];box.length=4;
 for(const input of [initial({references}),initial({regions}),initial({regions:[region('left',{box})]})])await assert.rejects(s.create(input),{code:'INVALID_INPUT'});
 assert.equal((await s.list()).documents.length,0);
});

test('proposal details are detached and bounded while immutable history remains complete',async t=>{
 const f=await setup(t),s=f.store();let d=await s.create(initial());
 for(let i=0;i<22;i++){d=await s.propose({document_id:d.document_id,expected_revision:d.revision,patch:{prompt:`Proposal ${i}`},summary:`Change ${i}`});}
 assert.equal(d.proposals.length,20);assert.equal(d.proposals.at(-1).base.prompt,'A quiet garden.');assert.equal(d.proposals.at(-1).proposed.prompt,'Proposal 21');
 d.proposals.at(-1).base.prompt='mutated';d.proposals.at(-1).patch.prompt='mutated';
 const loaded=await s.get({document_id:d.document_id});assert.equal(loaded.proposals.at(-1).patch.prompt,'Proposal 21');assert.equal((await s.history({document_id:d.document_id,limit:100})).revisions.length,23);
});

test('proposal recency follows revision order even when timestamps collide',async t=>{
 t.mock.timers.enable({apis:['Date'],now:2000000000000});const f=await setup(t),s=f.store();let d=await s.create(initial());
 for(let i=0;i<23;i++)d=await s.propose({document_id:d.document_id,expected_revision:d.revision,patch:{prompt:`Same timestamp ${i}`},summary:'same time'});
 assert.deepEqual(d.proposals.map(p=>p.submitted_revision),Array.from({length:20},(_,i)=>i+5));
});

test('replacement region lists preserve existing automatic seeds and rejected transactions add no history',async t=>{
 const f=await setup(t),s=f.store();const d=await s.create(initial());
 const changed=await s.update({document_id:d.document_id,expected_revision:1,patch:{regions:[region('left',{prompt:'New words'})]}});assert.equal(changed.regions[0].seed,d.regions[0].seed);
 await assert.rejects(s.update({document_id:d.document_id,expected_revision:2,patch:{regions:[region('left',{box:[0,0,400,256]})]}}),{code:'INVALID_INPUT'});
 assert.equal((await s.get({document_id:d.document_id})).revision,2);assert.equal((await s.history({document_id:d.document_id})).revisions.length,2);
});

test('body group camera and projection metadata never silently rewrite the stored execution box',async t=>{
 const f=await setup(t),s=f.store(),box=[16,16,140,240];const d=await s.create(initial({camera:{orbit:45},regions:[region('left',{box,group:'pair',body:{x:10,y:1,z:4,width:2,height:3,depth:1,yaw:30}})]}));
 assert.deepEqual(d.regions[0].box,box);assert.equal(d.regions[0].body.x,10);assert.equal(d.regions[0].group,'pair');assert.equal(d.camera.orbit,45);
});

function childUpdate(t,dataRoot,id,label){const moduleUrl=new URL('../src/workbench-store.mjs',import.meta.url).href;const code=`import{createWorkbenchStore}from ${JSON.stringify(moduleUrl)};import{writeFile}from'node:fs/promises';let value;try{const d=await createWorkbenchStore({dataRoot:${JSON.stringify(dataRoot)}}).update({document_id:${JSON.stringify(id)},expected_revision:1,patch:{prompt:${JSON.stringify(label)}}});value={status:'ok',revision:d.revision};}catch(e){value={status:e.code};}await writeFile(${JSON.stringify(path.join(dataRoot,label+'.json'))},JSON.stringify(value));`;const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});t.after(()=>{if(child.exitCode===null)child.kill();});return done;}
test('independent Node processes race one revision with exactly one CAS winner and intact history',async t=>{
 const f=await setup(t),s=f.store(),d=await s.create(initial());assert.deepEqual(await Promise.all([childUpdate(t,f.dataRoot,d.document_id,'one'),childUpdate(t,f.dataRoot,d.document_id,'two')]),[0,0]);
 const results=await Promise.all(['one','two'].map(async label=>JSON.parse(await readFile(path.join(f.dataRoot,label+'.json'),'utf8'))));assert.deepEqual(results.map(r=>r.status).sort(),['WORKBENCH_CONFLICT','ok']);assert.equal((await f.store().get({document_id:d.document_id})).revision,2);assert.deepEqual((await s.history({document_id:d.document_id})).revisions.map(r=>r.revision),[2,1]);
});
