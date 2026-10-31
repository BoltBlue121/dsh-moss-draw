import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {encodePng} from '../src/region-pixels.mjs';
const entry=new URL('../src/dispatcher.mjs',import.meta.url);
test('dispatcher routes draft parent context preview and execution without confusing child ledger',async t=>{
 const {createDrawingService}=await import(entry);const root=await mkdtemp(path.join(os.tmpdir(),'art-parent-'));t.after(()=>rm(root,{recursive:true,force:true}));let posts=0;
 const s=createDrawingService({dataRoot:root,comfyUrl:'http://127.0.0.1:9',fetchImpl:async()=>{posts++;throw Error('offline');}});
 const a={data:encodePng({width:256,height:256,pixels:Buffer.alloc(256*256*4,255)}),mediaType:'image/png',width:256,height:256};
 const p=await s.generate({mode:'regions',action:'draft',request_id:'draft1',prompt:'garden',regions:[{id:'p',box:[10,10,240,240],reference_index:1,prompt:'assigned person',style:'none'}]},[a,a]);
 assert.equal(p.status,'draft');assert.equal(posts,0);assert.equal((await s.run({run_id:p.run_id})).status,'draft');
 const c=await s.context({run_id:p.run_id});assert.equal(c.runs[0].preview_artifact.sha256,p.preview_artifact.sha256);
 assert.equal((await s.context({})).runs[0].run_id,p.run_id);await s.review({run_id:p.run_id,observations:['layout checked'],issues:[],next_change:''});
 assert.equal((await s.context({run_id:p.run_id})).runs[0].review.observations[0],'layout checked');
 assert.equal((await s.generate({mode:'regions',action:'execute',plan_id:p.run_id})).status,'running');assert.equal(posts,0);
 const state=await s.run({run_id:p.run_id});assert.equal(state.status,'failed');assert.equal(posts,1);
 const recent=await s.context({});assert.deepEqual(recent.runs.map(r=>r.run_id),[p.run_id],'internal children must not displace the user plan');
 const child=await s.context({run_id:state.progress.child_run_id});assert.equal(child.runs[0].pipeline_run_id,p.run_id);
 const followup=await s.generate({mode:'t2i',request_id:'after-plan',prompt:'New variation after the plan.',parent_run_id:p.run_id});assert.equal(followup.status,'unknown');
 const latest=await s.context({});assert.equal(latest.runs[0].run_id,followup.run_id,'user followup must remain discoverable');assert.equal(latest.runs[0].context.parent_run_id,p.run_id);
});
test('unified drawing dispatcher exists and rejects unlisted backend before any I/O',async()=>{
 const {createDrawingService}=await import(entry);
 const s=createDrawingService({dataRoot:path.join(os.tmpdir(),'art-dispatch-unused'),comfyUrl:'http://127.0.0.1:9',fetchImpl:()=>{throw Error('must not fetch')}});
 await assert.rejects(()=>s.generate({backend:'shell',request_id:'x',prompt:'hi'}),/BACKEND/);
 const c=s.catalog();assert.deepEqual(c.backends.map(x=>x.id),['moss','k2','qwen']);
 assert.equal(c.backends.find(x=>x.id==='k2').defaults.style,'none');assert.equal(c.backends.find(x=>x.id==='k2').defaults.lora_strength,0);
 assert.equal(c.backends.find(x=>x.id==='qwen').defaults.style,'none');
 assert.equal(c.backends.find(x=>x.id==='qwen').defaults.mode,'edit');
});
test('unified context uses the same ledger and compact multi-backend catalog',async()=>{
 const {createDrawingService}=await import(entry);const root=await mkdtemp(path.join(os.tmpdir(),'art-dispatch-'));
 try{
 const s=createDrawingService({dataRoot:root,comfyUrl:'http://127.0.0.1:9',fetchImpl:async()=>{throw Error('offline')}});
 const r=await s.generate({backend:'moss',request_id:'a',prompt:'Blue cup',seed:9});assert.equal(r.status,'unknown');
 const c=await s.context({run_id:r.run_id});assert.equal(c.runs[0].context.prompt,'Blue cup');assert.ok(c.catalog.backends);
 await assert.rejects(()=>s.generate({backend:'k2',mode:'edit',request_id:'b',prompt:'x'}));
 }finally{await rm(root,{recursive:true,force:true});}
});
