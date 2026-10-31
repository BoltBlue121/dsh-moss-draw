import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,readdir,symlink} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {decodePng} from '../src/region-pixels.mjs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
const api=await import('../src/regions.mjs').catch(e=>{if(e.code==='ERR_MODULE_NOT_FOUND')return {};throw e;});
const sha=b=>createHash('sha256').update(b).digest('hex');
function crc(b){let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=c>>>1^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function chunk(t,b){const v=Buffer.concat([Buffer.from(t),b]),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(b.length);c.writeUInt32BE(crc(v));return Buffer.concat([n,v,c]);}
function png(w=320,h=256,color=[20,30,40,128]){const ih=Buffer.alloc(13);ih.writeUInt32BE(w);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;const raw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++)for(let x=0;x<w;x++)raw.set(color,y*(w*4+1)+x*4+1);return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ih),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);}
const asset=(data=png())=>({data,mediaType:'image/png',width:data.readUInt32BE(16),height:data.readUInt32BE(20)});
const draft=(extra={})=>({request_id:'plan-1',mode:'regions',action:'draft',prompt:'Replace each character using the assigned reference.',regions:[{id:'left',box:[16,16,140,230],reference_index:1,prompt:'Use the character from reference 2 in the scene of reference 1.',style:'none',lora_strength:0,seed:42,context_px:16,feather_px:4}],...extra});
async function fixture(t){assert.equal(typeof api.createRegionService,'function','createRegionService must exist');const dataRoot=await mkdtemp(path.join(tmpdir(),'art-regions-'));t.after(()=>rm(dataRoot,{recursive:true,force:true}));const calls=[],states=new Map(),requests=new Map();let unknown=false;const child={async generate(input,assets){calls.push({input,assets});if(requests.has(input.request_id))return structuredClone(states.get(requests.get(input.request_id)));const id=randomUUID(),dir=path.join(dataRoot,'runs',id);await mkdir(dir,{recursive:true});const file=path.join(dir,'image.png'),bytes=png(input.width,input.height,[190,70,40,210]);await writeFile(file,bytes);const r={run_id:id,status:unknown?'unknown':'queued',artifact:{path:file,sha256:sha(bytes),width:input.width,height:input.height}};states.set(id,r);requests.set(input.request_id,id);return structuredClone(r);},async run({run_id},{signal}={}){signal?.throwIfAborted();const r=states.get(run_id);if(r.status!=='unknown')r.status='succeeded';return structuredClone(r);}};return {dataRoot,calls,states,child,set unknown(x){unknown=x;},service:()=>api.createRegionService({dataRoot,childService:child})};}
async function finish(s,id){let r;for(let i=0;i<20;i++){r=await s.run({run_id:id});if(['succeeded','failed','unknown'].includes(r.status))return r;}assert.fail('pipeline did not settle');}
test('region draft is durable pixel preview only, idempotent, immutable and bounded',async t=>{const f=await fixture(t),s=f.service(),inputs=[asset(),asset(png(256,256))];const a=await s.generate(draft(),inputs);assert.equal(a.status,'draft');assert(a.preview_artifact);assert.equal(f.calls.length,0);assert.equal((await s.run({run_id:a.run_id})).status,'draft');const b=await f.service().generate(draft(),inputs);assert.equal(a.run_id,b.run_id);await assert.rejects(s.generate(draft({prompt:'different'}),inputs),{code:'REQUEST_CONFLICT'});await assert.rejects(s.generate(draft({regions:[{...draft().regions[0],box:[-1,0,4,4]}]}),inputs),{code:'INVALID_INPUT'});assert.equal(f.calls.length,0);const c=await s.context({run_id:a.run_id});assert.equal(c.runs[0].params.regions[0].reference_index,1);});
test('execute and restart progress original child once, composite preserves full canvas',async t=>{const f=await fixture(t),s=f.service();const p=await s.generate(draft(),[asset(),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});let r=await s.run({run_id:p.run_id});assert.equal(f.calls.length,1);assert.equal(f.calls[0].input.backend,'moss');assert.equal(f.calls[0].input.style,'none');assert.equal(f.calls[0].input.lora_strength,0);assert.equal(f.calls[0].assets.length,2);r=await finish(f.service(),p.run_id);assert.equal(r.status,'succeeded');assert.equal(f.calls.length,1);assert.equal(r.artifact.width,320);assert.equal(r.artifact.height,256);assert.equal(r.protection.outside_changed_pixels,0);assert.equal(sha(await readFile(r.artifact.path)),r.artifact.sha256);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});await s.run({run_id:p.run_id});assert.equal(f.calls.length,1);});
test('unknown child never resubmits, later known success permits next region',async t=>{const f=await fixture(t);f.unknown=true;const s=f.service(),base=draft().regions[0];const p=await s.generate(draft({regions:[base,{...base,id:'right',box:[160,16,300,230]}]}),[asset(),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});assert.equal((await s.run({run_id:p.run_id})).status,'unknown');await f.service().run({run_id:p.run_id});assert.equal(f.calls.length,1);for(const r of f.states.values())r.status='queued';f.unknown=false;assert.equal((await finish(f.service(),p.run_id)).status,'succeeded');assert.equal(f.calls.length,2);});
test('region Qwen follows edit then full Qwen explicitly relinquishes outer pixel guarantee',async t=>{const f=await fixture(t),s=f.service();const p=await s.generate(draft({regions:[{...draft().regions[0],qwen_prompt:'修整手部，保留其它部分。'}],qwen_full_prompt:'统一全图光照。'}),[asset(),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});const r=await finish(s,p.run_id);assert.equal(r.status,'succeeded');assert.deepEqual(f.calls.map(c=>c.input.backend),['moss','qwen','qwen']);assert.equal(r.protection.scope,'none_after_full_qwen');assert.equal(f.calls[1].assets.length,1);assert.equal(f.calls[2].assets[0].width,320);});
test('trusted pre-stage guard prevents new child calls but does not cancel an already submitted child',async t=>{const f=await fixture(t),s=f.service(),p=await s.generate(draft(),[asset(),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});let allowed=false,checks=0;const beforeStage=async()=>{checks++;if(!allowed)throw Object.assign(Error('Human pause'),{code:'STUDIO_HUMAN_CONTROL'});};await assert.rejects(s.run({run_id:p.run_id},{beforeStage}),{code:'STUDIO_HUMAN_CONTROL'});assert.equal(f.calls.length,0);allowed=true;await s.run({run_id:p.run_id},{beforeStage});assert.equal(f.calls.length,1);allowed=false;await s.run({run_id:p.run_id},{beforeStage});assert.equal(f.calls.length,1);assert.equal(checks,2);});
test('cancelled run performs no child calls and source corruption cannot be silently used',async t=>{const f=await fixture(t),s=f.service(),p=await s.generate(draft(),[asset(),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});await assert.rejects(s.run({run_id:p.run_id},{signal:AbortSignal.abort()}),{name:'AbortError'});assert.equal(f.calls.length,0);const disk=path.join(f.dataRoot,'region-pipelines','runs',p.run_id,'ref1.png');await writeFile(disk,png(320,256,[1,2,3,4]));await assert.rejects(s.run({run_id:p.run_id}),{code:'STORE_CORRUPT'});assert.equal(f.calls.length,0);});
test('draft rejects expanded child prompt overflow and coerced style before permanent claims', async t => {
  const f=await fixture(t),s=f.service(),inputs=[asset(),asset(png(256,256))];
  for(const input of [draft({prompt:'x'.repeat(12000)}),draft({prompt:'x'.repeat(5000),regions:[{...draft().regions[0],prompt:'y'.repeat(8000)}]}),draft({regions:[{...draft().regions[0],style:['none']} ]})]) {
    await assert.rejects(s.generate(input,inputs),{code:'INVALID_INPUT'});
  }
  assert.equal(f.calls.length,0); await assert.rejects(readdir(path.join(f.dataRoot,'region-pipelines','requests')),{code:'ENOENT'});
});

test('pending stage must not read another run reference with a valid hash', async t => {
  const f=await fixture(t),s=f.service(),p=await s.generate(draft(),[asset(),asset(png(256,256))]);
  await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});
  const original=f.child.generate; f.child.generate=async()=>{throw new Error('child transport unavailable');};
  await assert.rejects(s.run({run_id:p.run_id}));
  const file=path.join(f.dataRoot,'region-pipelines','runs',p.run_id,'run.json'),r=JSON.parse(await readFile(file,'utf8'));
  const foreignDir=path.join(f.dataRoot,'runs',randomUUID());await mkdir(foreignDir,{recursive:true});
  const foreign=path.join(foreignDir,'private.png'),bytes=png(256,256,[1,2,3,255]);await writeFile(foreign,bytes);
  r.pending.assets[1]={path:foreign,sha256:sha(bytes),mediaType:'image/png',width:256,height:256};await writeFile(file,JSON.stringify(r));
  f.child.generate=original;
  await assert.rejects(s.run({run_id:p.run_id}),{code:'STORE_CORRUPT'});assert.equal(f.calls.length,0);
});

test('cancel during child submission durably retains its ID and queued cancellation starts no stage', async t => {
  const f=await fixture(t),s=f.service(),p=await s.generate(draft(),[asset(),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});
  const original=f.child.generate;let release,entered;const enteredPromise=new Promise(resolve=>{entered=resolve;});const gate=new Promise(resolve=>{release=resolve;});
  f.child.generate=async(...args)=>{const r=await original(...args);entered();await gate;return r;};
  const activeAbort=new AbortController(),waitingAbort=new AbortController();
  const active=s.run({run_id:p.run_id},{signal:activeAbort.signal});await enteredPromise;
  const waiting=s.run({run_id:p.run_id},{signal:waitingAbort.signal});const waitingRejected=assert.rejects(waiting,{name:'AbortError'});
  waitingAbort.abort();activeAbort.abort();await waitingRejected;release();await assert.rejects(active,{name:'AbortError'});
  const disk=JSON.parse(await readFile(path.join(f.dataRoot,'region-pipelines','runs',p.run_id,'run.json'),'utf8'));assert(disk.pending.child_run_id);
  assert.equal((await finish(f.service(),p.run_id)).status,'succeeded');assert.equal(f.calls.length,1);
});

test('failed child is terminal and malformed child dimensions never start a replacement generation', async t => {
  const f=await fixture(t),s=f.service(),p=await s.generate(draft(),[asset(),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});
  const first=await s.run({run_id:p.run_id});const child=f.states.get(first.progress.child_run_id);child.status='unknown';
  const originalRun=f.child.run;f.child.run=async()=>({...child,status:'failed'});
  assert.equal((await s.run({run_id:p.run_id})).status,'failed');await s.run({run_id:p.run_id});await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});await s.run({run_id:p.run_id});assert.equal(f.calls.length,1);
  f.child.run=originalRun;
  const q=await s.generate(draft({request_id:'dimensions'}),[asset(),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:q.run_id});const qr=await s.run({run_id:q.run_id});const changed=f.states.get(qr.progress.child_run_id);changed.status='queued';changed.artifact.width++;
  await assert.rejects(s.run({run_id:q.run_id}),{code:'STORE_CORRUPT'});await assert.rejects(s.run({run_id:q.run_id}),{code:'STORE_CORRUPT'});assert.equal(f.calls.length,2);
});

test('ordered overlap uses later pixels while every RGBA byte outside the region union remains original', async t => {
  const f=await fixture(t),s=f.service(),base=png(320,256,[20,30,40,0]),r=draft().regions[0];
  const regions=[{...r,box:[20,20,180,200],context_px:0,feather_px:0},{...r,id:'second',box:[100,40,240,220],context_px:0,feather_px:0}];
  const original=f.child.generate;f.child.generate=async(input,assets)=>{const child=await original(input,assets);const color=f.calls.length===1?[200,0,0,255]:[0,210,0,255];const bytes=png(input.width,input.height,color);await writeFile(child.artifact.path,bytes);f.states.get(child.run_id).artifact.sha256=sha(bytes);child.artifact.sha256=sha(bytes);return child;};
  const p=await s.generate(draft({regions}),[asset(base),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});const done=await finish(s,p.run_id);
  const source=decodePng(base),out=decodePng(await readFile(done.artifact.path));let outside=0;
  for(let y=0;y<256;y++)for(let x=0;x<320;x++){const i=(y*320+x)*4;if(!regions.some(({box:[l,t,r,b]})=>x>=l&&x<r&&y>=t&&y<b)){assert.deepEqual(out.pixels.subarray(i,i+4),source.pixels.subarray(i,i+4));outside++;}}
  assert(outside>0);assert.deepEqual([...out.pixels.subarray((60*320+120)*4,(60*320+120)*4+4)],[0,210,0,255]);assert.equal(f.calls.length,2);
});

async function waitForFile(file,child) {
  const until=Date.now()+5000;
  while(Date.now()<until){try{return await readFile(file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}if(child.exitCode!==null)throw Error('Fixture child exited before marker');await delay(10);}
  assert.fail('Fixture child did not reach marker');
}
function processRunner(t,root,id,{hang=false}={}) {
  const moduleUrl=new URL('../src/regions.mjs',import.meta.url).href;
  const code=`import {createRegionService} from ${JSON.stringify(moduleUrl)};import {readFile,writeFile,appendFile} from 'node:fs/promises';import {randomUUID} from 'node:crypto';import {setTimeout} from 'node:timers/promises';const root=${JSON.stringify(root)};const child={async generate(){let r;try{r=JSON.parse(await readFile(root+'/child-claim.json','utf8'));}catch(e){if(e.code!=='ENOENT')throw e;r={run_id:randomUUID(),status:'unknown'};await writeFile(root+'/child-claim.json',JSON.stringify(r));await appendFile(root+'/submissions.log','submit\\n');}await writeFile(root+'/entered','yes');await setTimeout(${hang?60000:150});return r;},async run(){await appendFile(root+'/queries.log','query\\n');return JSON.parse(await readFile(root+'/child-claim.json','utf8'));}};await createRegionService({dataRoot:root,childService:child}).run({run_id:${JSON.stringify(id)}});`;
  const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
  const done=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});t.after(()=>{if(child.exitCode===null)child.kill();});return{child,done};
}

test('independent Node processes serialize advancement with SQLite and query the same unknown child', async t => {
  const f=await fixture(t),s=f.service(),p=await s.generate(draft(),[asset(),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});
  const a=processRunner(t,f.dataRoot,p.run_id);await waitForFile(path.join(f.dataRoot,'entered'),a.child);const b=processRunner(t,f.dataRoot,p.run_id);
  assert.deepEqual(await Promise.all([a.done,b.done]),[0,0]);assert.equal(await readFile(path.join(f.dataRoot,'submissions.log'),'utf8'),'submit\n');assert.equal(await readFile(path.join(f.dataRoot,'queries.log'),'utf8'),'query\n');
  assert.equal((await s.context({run_id:p.run_id})).runs[0].status,'unknown');
});

test('process death releases SQLite ownership and missing parent receipt recovers the permanent child claim', async t => {
  const f=await fixture(t),s=f.service(),p=await s.generate(draft(),[asset(),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});
  const a=processRunner(t,f.dataRoot,p.run_id,{hang:true});await waitForFile(path.join(f.dataRoot,'entered'),a.child);a.child.kill();await a.done;
  const b=processRunner(t,f.dataRoot,p.run_id);assert.equal(await b.done,0);
  assert.equal(await readFile(path.join(f.dataRoot,'submissions.log'),'utf8'),'submit\n');assert.equal((await s.context({run_id:p.run_id})).runs[0].status,'unknown');
});

test('child artifact directory junction cannot redefine session containment', async t => {
  const f=await fixture(t),outside=await mkdtemp(path.join(tmpdir(),'art-regions-external-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  const s=f.service(),p=await s.generate(draft(),[asset(),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});const first=await s.run({run_id:p.run_id});
  const childId=randomUUID(),externalFile=path.join(outside,'image.png'),bytes=png(256,256);await writeFile(externalFile,bytes);await symlink(outside,path.join(f.dataRoot,'runs',childId),process.platform==='win32'?'junction':'dir');
  const recordPath=path.join(f.dataRoot,'region-pipelines','runs',p.run_id,'run.json'),r=JSON.parse(await readFile(recordPath,'utf8'));r.pending.child_run_id=childId;await writeFile(recordPath,JSON.stringify(r));
  f.child.run=async()=>({run_id:childId,status:'succeeded',artifact:{path:path.join(f.dataRoot,'runs',childId,'image.png'),sha256:sha(bytes),width:256,height:256}});
  await assert.rejects(s.run({run_id:p.run_id}),{code:'STORE_CORRUPT'});assert.equal(f.calls.length,1);assert(first.progress.child_run_id);
});

test('cancelling while another process owns SQLite lock does not cancel its job or advance locally', async t => {
  const f=await fixture(t),s=f.service(),p=await s.generate(draft(),[asset(),asset(png(256,256))]);await s.generate({mode:'regions',action:'execute',plan_id:p.run_id});
  const a=processRunner(t,f.dataRoot,p.run_id,{hang:true});await waitForFile(path.join(f.dataRoot,'entered'),a.child);
  const controller=new AbortController();const waiting=s.run({run_id:p.run_id},{signal:controller.signal}),rejected=assert.rejects(waiting,{name:'AbortError'});
  await delay(60);controller.abort();await rejected;assert.equal(a.child.exitCode,null);assert.equal(f.calls.length,0);a.child.kill();await a.done;
});

test('has is read-only and preserves malformed-record errors',async t=>{const f=await fixture(t),s=f.service();assert.equal(await s.has(randomUUID()),false);await assert.rejects(s.has('../escape'),{code:'INVALID_INPUT'});const p=await s.generate(draft(),[asset(),asset(png(256,256))]);assert.equal(await s.has(p.run_id),true);const file=path.join(f.dataRoot,'region-pipelines','runs',p.run_id,'run.json');await writeFile(file,'invalid');await assert.rejects(s.has(p.run_id),{code:'STORE_CORRUPT'});});
