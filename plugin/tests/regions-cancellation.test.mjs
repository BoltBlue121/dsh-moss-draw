import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {tmpdir} from 'node:os';
import fsPromises,{mkdtemp,rm,readdir,readFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {createDrawingService} from '../src/dispatcher.mjs';
import {createRegionService} from '../src/regions.mjs';
import {createStore} from '../src/store.mjs';
import {createWorkbenchStore} from '../src/workbench-store.mjs';
import {createWorkbenchBridge} from '../src/workbench-host.mjs';
import {encodePng} from '../src/region-pixels.mjs';

const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return{promise,resolve};};
const draft={request_id:'cancel-plan',mode:'regions',action:'draft',prompt:'Keep the scene.',regions:[{id:'one',box:[16,16,200,200],reference_index:1,prompt:'Apply this character.',style:'none',lora_strength:0,seed:42}]};
async function setup(t){
  const root=await mkdtemp(path.join(tmpdir(),'moss-region-cancel-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const data=encodePng({width:256,height:256,pixels:Buffer.alloc(256*256*4,255)}),asset={data,mediaType:'image/png',width:256,height:256};
  let network=0;const service=createDrawingService({dataRoot:root,comfyUrl:'http://127.0.0.1:1',fetchImpl:async()=>{network++;throw Error('Unexpected network');}});
  const store=createStore(path.join(root,'region-pipelines'));
  return{root,asset,assets:[asset,asset],service,store,network:()=>network};
}
async function hold(store){const entered=deferred(),release=deferred();const done=store.locked(async()=>{entered.resolve();await release.promise;});await entered.promise;return{release:()=>release.resolve(),done};}
async function entries(root,name){try{return await readdir(path.join(root,'region-pipelines',name));}catch(e){if(e.code==='ENOENT')return[];throw e;}}
async function queuedAbort(t,store,invoke){
  const held=await hold(store);t.after(async()=>{held.release();await held.done;});
  const controller=new AbortController();const result=invoke(controller.signal).then(value=>({value}),error=>({error}));
  // Invoking async generate synchronously enqueues behind the held in-process
  // store lock. Abort while that real lock is still held, then release it.
  controller.abort();held.release();await held.done;
  const settled=await result;await store.locked(async()=>{});return settled;
}

test('real region generate cancelled while queued creates no permanent claim or draft files',async t=>{
  const f=await setup(t);const direct=createRegionService({dataRoot:f.root,childService:{generate:async()=>assert.fail('child submit'),run:async()=>assert.fail('child run')}});
  const result=await queuedAbort(t,f.store,signal=>direct.generate(draft,f.assets,{signal}));
  assert.equal(result.error?.name,'AbortError');assert.deepEqual(await entries(f.root,'requests'),[]);assert.deepEqual(await entries(f.root,'runs'),[]);
});

test('real drawing dispatcher propagates queued draft cancellation before any ledger claim',async t=>{
  const f=await setup(t);const result=await queuedAbort(t,f.store,signal=>f.service.generate(draft,f.assets,{signal}));
  assert.equal(result.error?.name,'AbortError');assert.deepEqual(await entries(f.root,'requests'),[]);assert.deepEqual(await entries(f.root,'runs'),[]);assert.equal(f.network(),0);
});

test('queued execute cancellation leaves saved draft byte-identical and never launches a child',async t=>{
  const f=await setup(t);const p=await f.service.generate(draft,f.assets);const file=path.join(f.root,'region-pipelines','runs',p.run_id,'run.json');const before=await readFile(file);
  const result=await queuedAbort(t,f.store,signal=>f.service.generate({mode:'regions',action:'execute',plan_id:p.run_id},[],{signal}));
  assert.equal(result.error?.name,'AbortError');assert.deepEqual(await readFile(file),before);assert.equal(f.network(),0);
});

test('materialize aborted after entering real dispatcher but waiting on region lock writes no draft',async t=>{
  const f=await setup(t),entered=deferred();const entry={dataRoot:f.root,workbench:createWorkbenchStore({dataRoot:f.root}),service:{...f.service,generate(...args){const result=f.service.generate(...args);entered.resolve();return result;}}};
  const bridge=createWorkbenchBridge({getEntry:()=>entry,resolveReference:async()=>f.asset,previewImage:async a=>a,readRunImage:async()=>f.asset,inspectPlan:async()=>assert.fail('no import')});
  const doc=await bridge({action:'create',title:'Cancellation',canvas:{width:256,height:256,reference:'base.png'},references:['base.png','char.png'],prompt:draft.prompt,regions:draft.regions},{});
  const held=await hold(f.store);t.after(async()=>{held.release();await held.done;});const controller=new AbortController();
  const pending=bridge({action:'materialize',document_id:doc.document_id,expected_revision:doc.revision},{signal:controller.signal}).then(value=>({value}),error=>({error}));
  await entered.promise;controller.abort();held.release();await held.done;const result=await pending;await f.store.locked(async()=>{});
  assert.equal(result.error?.name,'AbortError');assert.deepEqual(await entries(f.root,'requests'),[]);assert.deepEqual(await entries(f.root,'runs'),[]);assert.equal(f.network(),0);
  assert.equal((await entry.workbench.get({document_id:doc.document_id})).revision,1);
});

test('queued cancellation rejects promptly without releasing the active owner lock',async t=>{
  const f=await setup(t),held=await hold(f.store);t.after(async()=>{held.release();await held.done;});const c=new AbortController();
  const pending=f.service.generate(draft,f.assets,{signal:c.signal}).then(value=>({value}),error=>({error}));c.abort();
  const result=await Promise.race([pending,delay(1000).then(()=>({timeout:true}))]);
  assert.equal(result.error?.name,'AbortError');assert.deepEqual(await entries(f.root,'requests'),[]);
  held.release();await held.done;await f.store.locked(async()=>{});assert.deepEqual(await entries(f.root,'runs'),[]);
});

test('abort immediately after real permanent claim settles a recoverable complete draft with zero GPU',async t=>{
  const f=await setup(t),controller=new AbortController();const original=fsPromises.link;let claims=0;
  // Intercept only the completion of the actual hard-link claim. No fake store,
  // no production hook: filesystem claim/fsync/asset writes remain real.
  fsPromises.link=async(source,target)=>{const result=await original(source,target);if(String(target).startsWith(path.join(f.root,'region-pipelines','requests'))&&String(target).endsWith('.json')){claims++;controller.abort();}return result;};
  syncBuiltinESMExports();
  try{await assert.rejects(f.service.generate(draft,f.assets,{signal:controller.signal}),{name:'AbortError'});}
  finally{fsPromises.link=original;syncBuiltinESMExports();}
  assert.equal(claims,1);assert.equal(f.network(),0);
  const requestFiles=await entries(f.root,'requests');assert.equal(requestFiles.length,1);
  const claim=JSON.parse(await readFile(path.join(f.root,'region-pipelines','requests',requestFiles[0]),'utf8'));
  const recovered=await f.service.generate(draft,f.assets);
  assert.equal(recovered.run_id,claim.run_id);assert.equal(recovered.status,'draft');assert(recovered.preview_artifact);
  const record=JSON.parse(await readFile(path.join(f.root,'region-pipelines','runs',claim.run_id,'run.json'),'utf8'));
  assert.equal(record.assets.length,2);await readFile(record.assets[0].path);await readFile(record.assets[1].path);await readFile(record.preview_artifact.path);
  assert.deepEqual(await entries(f.root,'runs'),[claim.run_id]);assert.equal(f.network(),0);
});

test('already cancelled direct draft and execute never create region ledger directories',async t=>{
  const f=await setup(t);const direct=createRegionService({dataRoot:f.root,childService:{generate:async()=>assert.fail('child submit'),run:async()=>assert.fail('child run')}});
  const signal=AbortSignal.abort();await assert.rejects(direct.generate(draft,f.assets,{signal}),{name:'AbortError'});
  await assert.rejects(direct.generate({mode:'regions',action:'execute',plan_id:'bba17a25-9c17-41f2-8614-9f57186c2c35'},[],{signal}),{name:'AbortError'});
  assert.deepEqual(await entries(f.root,'requests'),[]);assert.deepEqual(await entries(f.root,'runs'),[]);
});
