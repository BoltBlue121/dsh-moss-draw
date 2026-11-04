import { setTimeout as delay } from 'node:timers/promises';

export const WAIT_MS = 30 * 60 * 1000;
export const WAIT_TOOL_TIMEOUT_MS = WAIT_MS + 60000;
// Field incident 2026-10-30: the GPU host left Tailscale mid-run. Every poll kept
// the last confirmed status with NETWORK_UNKNOWN, so art_run waited 30 minutes,
// asked for another art_run, and the user's questions sat unanswered for 90+
// minutes. Silence this long ends the wait for this turn instead.
export const UNREACHABLE_MS = 3 * 60 * 1000;
const active = new Set(['queued','running','pending','submitting']);
// Reconcile codes meaning "no usable worker answer". Conflicting markers or bad
// artifacts are real answers and keep the normal bounded wait.
const unobserved = new Set(['NETWORK_UNKNOWN','HTTP_ERROR','INVALID_RESPONSE']);
export async function waitForRun(service, input, {signal, intervalMs=5000, timeoutMs=WAIT_MS, unreachableMs=UNREACHABLE_MS}={}) {
  const deadline=Date.now()+timeoutMs;
  let last, silentSince=null;
  const timedOut=result=>({...result,wait_timed_out:true,next_action:'The original task is still active. Call art_run once more to continue the managed wait; do not ask for a continuation message, use art_view to poll, or submit another generation.'});
  const unreachable=(result,ms)=>({...result,worker_unreachable:true,next_action:`The drawing worker has given no usable reply for about ${Math.max(1,Math.round(ms/60000))} min (status queries or the image download kept failing), so this wait stopped early. Last confirmed status: ${result.status}; the run is kept under run_id ${result.run_id??input.run_id}. Tell the user plainly that the GPU worker cannot be reached reliably right now and needs to be brought back online or reconnected. Do not call art_run again this turn, do not resubmit, and keep the same request_id; once the worker is back, one art_run on this run_id collects the result.`});
  for (;;) {
    signal?.throwIfAborted();
    if(last && Date.now()>=deadline) return timedOut(last);
    const askedAt=Date.now();
    const result=await service.run(input,{signal});
    last=result;
    signal?.throwIfAborted();
    if (result.status==='draft') return {...result,next_action:result.next_action??'Inspect the preview, then execute this saved plan under user authorization. Do not wait on a draft.'};
    if (result.status==='abandoned') return {...result,next_action:result.next_action??'A human archived this unresolved result. Do not re-submit or refund it; read the current page for review and new-request requirements.'};
    if (result.status==='succeeded') return {...result,next_action:'Now art_view → art_review → art_deliver in this turn, then include markdown_link in the final reply. Do not wait for another user message.'};
    if (!active.has(result.status)) return {...result,next_action:'Report the actual failure or uncertain state and run_id. Never resubmit automatically or claim the image is ready.'};
    if (unobserved.has(result.error?.code)) {
      silentSince??=askedAt;
      const silent=Date.now()-silentSince;
      if (silent>=unreachableMs) return unreachable(result,silent);
    } else silentSince=null;
    const remaining=deadline-Date.now();
    if (remaining<=0) return timedOut(result);
    await delay(Math.min(intervalMs,remaining),undefined,{signal});
  }
}
