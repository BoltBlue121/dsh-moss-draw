import test from 'node:test';
import assert from 'node:assert/strict';
const subject=()=>import('../src/wait.mjs');

test('one wait call internally follows queued running succeeded without generation',async()=>{
 const {waitForRun}=await subject();let calls=0;
 const states=['queued','running','running','succeeded'];
 const service={run:async args=>({run_id:args.run_id,status:states[calls++],artifact:calls===4?{path:'result.png'}:undefined})};
 const result=await waitForRun(service,{run_id:'run-1'},{intervalMs:1,timeoutMs:1000});
 assert.equal(result.status,'succeeded');assert.equal(calls,4);assert.match(result.next_action,/art_view.*art_review.*art_deliver/);
});
test('draft returns preview contract without claiming failure or submitting',async()=>{
 const {waitForRun}=await subject();let calls=0;const r=await waitForRun({run:async()=>{calls++;return {status:'draft',next_action:'Inspect preview then execute under user authorization.'};}},{run_id:'x'});
 assert.equal(calls,1);assert.match(r.next_action,/preview/);assert.doesNotMatch(r.next_action,/failure/);
});
test('failed and unknown return promptly and never submit again',async()=>{
 const {waitForRun}=await subject();
 for(const status of ['failed','unknown']){let calls=0;const r=await waitForRun({run:async()=>{calls++;return {status};}},{run_id:'x'},{intervalMs:1,timeoutMs:1000});assert.equal(r.status,status);assert.equal(calls,1);}
});
test('human abandonment returns its settlement instruction without another wait',async()=>{const{waitForRun}=await subject();let calls=0;const r=await waitForRun({run:async()=>{calls++;return{status:'abandoned',next_action:'Human archived this unresolved result; do not re-submit or refund.'};}},{run_id:'x'});assert.equal(calls,1);assert.match(r.next_action,/Human archived/);});
test('cancellation stops observation without cancelling remote generation',async()=>{
 const {waitForRun}=await subject(),cancel=new AbortController();let calls=0;
 await assert.rejects(()=>waitForRun({run:async()=>{calls++;cancel.abort();return{status:'running'};}},{run_id:'x'},{signal:cancel.signal,intervalMs:1,timeoutMs:1000}),{name:'AbortError'});
 assert.equal(calls,1);
});
test('elapsed deadline before next loop cannot advance another region stage',async t=>{
 const {waitForRun}=await subject();let clock=0,calls=0;
 t.mock.method(Date,'now',()=>{const value=clock;clock+=10;return value;});
 const r=await waitForRun({run:async()=>{calls++;return{status:'running'};}},{run_id:'x'},{intervalMs:1,timeoutMs:15});
 assert.equal(calls,1);assert.equal(r.wait_timed_out,true);
});
test('bounded wait reports still-running truthfully, instructing assistant to keep waiting not ask user',async()=>{
 const {waitForRun}=await subject();const r=await waitForRun({run:async()=>({status:'running'})},{run_id:'x'},{intervalMs:2,timeoutMs:5});
 assert.equal(r.status,'running');assert.equal(r.wait_timed_out,true);assert.match(r.next_action,/art_run/);assert.ok(!r.next_action.includes('ask the user'));
});
// Regression: a worker can become unreachable mid-run. Every poll kept the last
// confirmed status (running) with NETWORK_UNKNOWN, so a bounded art_run would
// spend its whole budget waiting and then ask for another art_run while the
// user's questions waited in the inbox.
const lost={code:'NETWORK_UNKNOWN',message:'Worker reply unavailable; query this run, never resubmit it.'};
test('sustained worker silence ends the wait early with worker_unreachable instead of a 30 minute loop',async t=>{
 const {waitForRun}=await subject();let clock=0,calls=0;t.mock.method(Date,'now',()=>clock);
 const r=await waitForRun({run:async args=>{calls++;clock+=100;return{run_id:args.run_id,status:'running',prompt_id:'p-1',error:lost};}},{run_id:'run-1'},{intervalMs:1,timeoutMs:10000,unreachableMs:250});
 assert.equal(calls,3);assert.equal(r.worker_unreachable,true);assert.equal(r.wait_timed_out,undefined);
 assert.equal(r.status,'running');assert.equal(r.run_id,'run-1');assert.equal(r.error.code,'NETWORK_UNKNOWN');
 assert.match(r.next_action,/run-1/);assert.match(r.next_action,/do not call art_run again this turn/i);assert.match(r.next_action,/resubmit/);
 assert.ok(!r.next_action.includes('ask the user'));
});
test('one confirmed observation resets the unreachable clock, so a flaky link still waits for the result',async t=>{
 const {waitForRun}=await subject();let clock=0,calls=0;t.mock.method(Date,'now',()=>clock);
 const states=[{status:'running',error:lost},{status:'running',error:lost},{status:'running'},{status:'running',error:lost},{status:'running',error:lost},{status:'succeeded'}];
 const r=await waitForRun({run:async()=>{clock+=100;return states[calls++];}},{run_id:'x'},{intervalMs:1,timeoutMs:10000,unreachableMs:250});
 assert.equal(calls,6);assert.equal(r.status,'succeeded');assert.equal(r.worker_unreachable,undefined);
});
test('a worker that answers only with HTTP errors is unobservable too',async t=>{
 const {waitForRun}=await subject();let clock=0,calls=0;t.mock.method(Date,'now',()=>clock);
 const r=await waitForRun({run:async()=>{calls++;clock+=100;return{status:'queued',error:{code:'HTTP_ERROR',message:'Worker HTTP error; ask maintenance to inspect.'}};}},{run_id:'x'},{intervalMs:1,timeoutMs:10000,unreachableMs:250});
 assert.equal(calls,3);assert.equal(r.worker_unreachable,true);assert.equal(r.status,'queued');
});
test('non-transport errors keep the normal bounded wait and are not reported as an offline worker',async t=>{
 const {waitForRun}=await subject();let clock=0,calls=0;t.mock.method(Date,'now',()=>clock);
 const r=await waitForRun({run:async()=>{calls++;clock+=100;return{status:'running',error:{code:'RECONCILE_AMBIGUOUS',message:'Conflicting worker markers; ask maintenance to reconcile, never resubmit.'}};}},{run_id:'x'},{intervalMs:1,timeoutMs:1000,unreachableMs:250});
 assert.equal(r.worker_unreachable,undefined);assert.equal(r.wait_timed_out,true);assert.equal(calls,10);
});
test('default unreachable window tolerates a short relay hiccup but is far shorter than the managed wait',async()=>{
 const {UNREACHABLE_MS,WAIT_MS,WAIT_TOOL_TIMEOUT_MS}=await subject();
 assert.ok(UNREACHABLE_MS>=60000);assert.ok(UNREACHABLE_MS*5<=WAIT_MS);assert.ok(WAIT_TOOL_TIMEOUT_MS>WAIT_MS);
});
