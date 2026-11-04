import test from 'node:test';import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';import path from 'node:path';import {mkdtemp,rm} from 'node:fs/promises';
import {createStudioStore} from '../src/studio-store.mjs';
import {createWorkbenchBridge} from '../src/workbench-host.mjs';
import {emptyStudioDoc,upgradeStudioDoc} from '../src/studio-domain.mjs';
async function fixture(t){const dataRoot=await mkdtemp(path.join(tmpdir(),'portable-presentation-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));
const studio=createStudioStore({dataRoot}),doc=upgradeStudioDoc(emptyStudioDoc());doc.layout.width=doc.layout.height=128;
doc.layout.summary.caption='Synthetic';doc.layout.items=[{id:'hero',label:'character',caption:'A figure',bbox:[8,8,40,96]}];
const series=await studio.createSeries({title:'Fixture'}),page=await studio.createPage({series_id:series.series_id,title:'Page',doc});
const bridge=createWorkbenchBridge({getEntry:()=>({studio,dataRoot})}),exec={agent:{session:{id:'fixture'}}};
const call=(actor,action,args)=>bridge({action,...args},exec,actor),edit=(rev,family,command,extra={})=>call('agent','studioEdit',{page_id:page.page_id,expected_revision:rev,edit:{family,command},...extra});
return {studio,page,call,edit,read:()=>studio.getPage({page_id:page.page_id})};}
test('shared workspace pages stay readable but queued presentation and its acknowledgement belong to the issuing session',async t=>{
 const {studio,page}=await fixture(t),entry={studio};
 const bridge=createWorkbenchBridge({getEntry:()=>entry});
 const call=(session,action,fields={})=>bridge({action,...fields},{agent:{session:{id:session}}},'ui');
 await studio.startTask({page_id:page.page_id,expected_revision:page.revision,intent:'Legacy unbound task'});
 const of=async session=>(await call(session,'studioTaskState')).tasks.find(t=>t.page_id===page.page_id).task.presentation;
 assert.equal(await of('A'),undefined);assert.equal(await of('B'),undefined);
 const shown=await call('A','studioOpen',{page_id:page.page_id}),request=shown.task.presentation;
 assert.equal(request.session_id,'A');assert.equal((await of('A')).request_id,request.request_id);assert.equal(await of('B'),undefined);
 const ack={page_id:page.page_id,request_id:request.request_id,client_id:'window',surface:'main'};
 await assert.rejects(call('B','studioOpen',{page_id:page.page_id}),{code:'STUDIO_OPEN_STALE'});
 await assert.rejects(call('B','studioAckOpen',ack),{code:'STUDIO_OPEN_STALE'});
 await assert.rejects(call('B','studioAckOpen',{...ack,session_id:'A'}),{code:'STUDIO_INVALID_INPUT'});
 assert.equal((await call('A','studioAckOpen',ack)).task.presentation.status,'opened');
 assert.equal((await call('B','studioGetPage',{page_id:page.page_id})).page_id,page.page_id);
 assert.equal((await call('B','studioOpen',{page_id:page.page_id})).task.presentation.session_id,'B');
});
test('old clients cannot silently strip rich metadata, while restore names every affected layer',async t=>{
 const {studio,edit,read,page}=await fixture(t);
 const task=await studio.startTask({page_id:page.page_id,expected_revision:page.revision,intent:'Pose the traveler'});
 await edit(task.revision,'rig',{op:'enable',id:'hero',build:'standard'});
 const rich=await read(),stripped=structuredClone(rich.doc);delete stripped.layout.items[0].rig;
 const args={page_id:page.page_id,expected_revision:rich.revision,doc:stripped};
 await assert.rejects(studio.agentUpdate(args),{code:'STUDIO_RICH_REMOVED'});
 await assert.rejects(studio.propose({...args,summary:'Old client'}),{code:'STUDIO_RICH_REMOVED'});
 const control=await studio.takeover({page_id:page.page_id,expected_revision:rich.revision,client_id:'rich-restore'});
 const guarded={page_id:page.page_id,expected_revision:control.page.revision,lease_token:control.lease_token};
 await assert.rejects(studio.updatePage({...guarded,doc:stripped}),{code:'STUDIO_RICH_REMOVED'});
 let acknowledge;await assert.rejects(studio.restore({...guarded,revision:page.revision}),e=>{
  acknowledge=e.restoreDiff;assert.deepEqual(acknowledge.removed_rich_item_ids,['hero']);return e.code==='STUDIO_RESTORE_ACK_REQUIRED';
 });
 const restored=await studio.restore({...guarded,revision:page.revision,acknowledge});
 assert.deepEqual(restored.doc,page.doc);
});
