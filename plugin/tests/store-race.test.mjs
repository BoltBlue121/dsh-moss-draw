import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtemp,rm,readFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createStore,atomicWrite} from '../src/store.mjs';

const record=id=>({schemaVersion:1,run_id:id,request_id:'race',input_hash:'a'.repeat(64),params:{seed:7},status:'submitting',created_at:'2026-10-24T00:00:00.000Z',updated_at:'2026-10-24T00:00:00.000Z'});
async function fixture(t){const root=await mkdtemp(path.join(tmpdir(),'moss-store-race-'));t.after(()=>rm(root,{recursive:true,force:true}));return{root,store:createStore(root)};}

test('observer reading an in-flight submission never writes the owner ledger',async t=>{
 const {root,store}=await fixture(t),id=randomUUID(),original=record(id);await store.write(original);const file=path.join(root,'runs',id,'run.json'),before=await readFile(file,'utf8');
 const observed=await createStore(root).read(id);assert.equal(observed.status,'unknown');assert.equal(observed.params.seed,7);
 assert.equal(await readFile(file,'utf8'),before,'read must return recovery status without overwriting a live owner');
});

test('a stale submitting snapshot cannot roll a newer owner receipt back to unknown',async t=>{
 const {root,store}=await fixture(t),id=randomUUID();await store.write(record(id));const file=path.join(root,'runs',id,'run.json');
 const originalRead=fs.readFile;let release,captured;const gate=new Promise(resolve=>{release=resolve;}),snapshotReady=new Promise(resolve=>{captured=resolve;});let intercept=true;
 fs.readFile=async function(filename,...args){const result=await originalRead(filename,...args);if(intercept&&path.resolve(filename)===file){intercept=false;captured();await gate;}return result;};syncBuiltinESMExports();
 try{
   const observer=createStore(root).read(id);await snapshotReady;
   const accepted={...record(id),status:'queued',prompt_id:'confirmed-prompt',updated_at:'2026-10-24T00:00:01.000Z'};await store.write(accepted);release();assert.equal((await observer).status,'unknown');
   const persisted=JSON.parse(await originalRead(file,'utf8'));assert.equal(persisted.status,'queued');assert.equal(persisted.prompt_id,'confirmed-prompt');assert.equal(persisted.updated_at,accepted.updated_at);
 }finally{release?.();fs.readFile=originalRead;syncBuiltinESMExports();}
});

test('Windows transient sharing violation retries only the same atomic rename', {skip:process.platform!=='win32'},async t=>{
 const {root}=await fixture(t),file=path.join(root,'value.json');await atomicWrite(file,'old');const originalRename=fs.rename;let attempts=0;const calls=[];
 fs.rename=async(from,to)=>{calls.push([from,to]);attempts++;if(attempts<3){assert.equal(await readFile(file,'utf8'),'old');throw Object.assign(new Error('sharing violation'),{code:'EPERM'});}return originalRename(from,to);};syncBuiltinESMExports();
 try{await atomicWrite(file,'new');assert.equal(attempts,3);assert(calls.every(([from,to])=>from===calls[0][0]&&to===file));assert.equal(await readFile(file,'utf8'),'new');}
 finally{fs.rename=originalRename;syncBuiltinESMExports();}
});

test('permanent rename failure stays bounded and never deletes the previous record', {skip:process.platform!=='win32'},async t=>{
 const {root}=await fixture(t),file=path.join(root,'value.json');await atomicWrite(file,'old');const originalRename=fs.rename;let attempts=0;
 fs.rename=async()=>{attempts++;throw Object.assign(new Error('permanent denial'),{code:'EPERM'});};syncBuiltinESMExports();
 try{await assert.rejects(atomicWrite(file,'new'),{code:'EPERM'});assert(attempts>1&&attempts<=10);assert.equal(await readFile(file,'utf8'),'old');}
 finally{fs.rename=originalRename;syncBuiltinESMExports();}
});

test('claim-only recovery remains discoverable without manufacturing a writer record',async t=>{
 const {root,store}=await fixture(t),id=randomUUID();await store.claim('race',record(id));
 assert.deepEqual(await store.recent(3),[id]);assert.equal((await store.read(id)).status,'unknown');
 await assert.rejects(readFile(path.join(root,'runs',id,'run.json')),{code:'ENOENT'});
 await store.write({...record(id),status:'queued',prompt_id:'reconciled'});assert.equal((await store.read(id)).prompt_id,'reconciled');
});
