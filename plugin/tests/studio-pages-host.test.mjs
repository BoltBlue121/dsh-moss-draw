import test from 'node:test';import assert from 'node:assert/strict';import{mkdtemp,rm}from'node:fs/promises';import os from'node:os';import path from'node:path';
import {handleStudioAction} from '../src/studio-host.mjs';import {createBridge} from '../client/model.mjs';import {emptyStudioDoc} from '../src/studio-domain.mjs';
test('native command fields carry series CAS and tombstone pages without generating',async t=>{
 const dataRoot=await mkdtemp(path.join(os.tmpdir(),'studio-management-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));const entry={dataRoot};let calls=0;
 const execute=async(sid,line)=>{assert.equal(sid,'same-session');calls++;const{action,...args}=JSON.parse(line.slice('/art-workbench '.length));return{ok:true,value:{result:{kind:'success',text:JSON.stringify(await handleStudioAction(entry,action,args))}}};};
 const bridge=createBridge({sessionId:'same-session',remote:{commands:{execute}}});
 const s=await bridge.request('studioCreateSeries',{title:'First'});const p=await bridge.request('studioCreatePage',{series_id:s.series_id,title:'Page',doc:emptyStudioDoc()});
 const state=await bridge.request('studioState',{series_id:s.series_id,offset:0,limit:10});assert.equal(state.page_total,1);assert.equal(state.next_offset,null);
 await bridge.request('studioRenameSeries',{series_id:s.series_id,expected_title:'First',title:'Renamed'});await assert.rejects(bridge.request('studioRenameSeries',{series_id:s.series_id,expected_title:'First',title:'Stale'}),/revision|changed|title/i);
 await bridge.request('studioDeletePage',{page_id:p.page_id,expected_revision:1});await assert.rejects(bridge.request('studioGetPage',{page_id:p.page_id}),/not found/i);
 await bridge.request('studioDeleteSeries',{series_id:s.series_id,expected_title:'Renamed',expected_pages:[]});assert.equal((await bridge.request('studioState')).series.length,0);assert.ok(calls>=9);
});
