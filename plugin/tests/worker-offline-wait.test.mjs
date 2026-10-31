import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createService } from '../src/core.mjs';
import { waitForRun } from '../src/wait.mjs';

// Regression: ComfyUI accepted the prompt and a later poll confirmed it running,
// then the worker host became unreachable. Only the external fetch boundary is
// faked; the real ledger, reconcile and wait loop run against a temporary data root.
test('worker that disappears after confirming a run ends art_run early with worker_unreachable, no resubmission', async t => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'moss-offline-wait-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const posts = []; let offline = false, running = [];
  const fetchImpl = async (url, init = {}) => {
    if (offline) throw new TypeError('fetch failed');
    const route = new URL(url).pathname;
    if (route === '/prompt') {
      const body = JSON.parse(init.body); posts.push(body);
      running = [[1, 'offline-prompt', body.prompt, { ...body.extra_data, client_id: body.client_id }, ['12']]];
      return Response.json({ prompt_id: 'offline-prompt', number: 1, node_errors: {} });
    }
    if (route.startsWith('/history')) return Response.json({});
    if (route === '/queue') return Response.json({ queue_running: running, queue_pending: [] });
    assert.fail('Unexpected fixture route ' + route);
  };
  const service = createService({ dataRoot, comfyUrl: 'http://fixture.invalid', fetchImpl });
  const submitted = await service.generate({ request_id: 'offline-wait', prompt: 'A quiet studio portrait.', width: 256, height: 256 });
  assert.equal(posts.length, 1);
  const observed = await service.run({ run_id: submitted.run_id });
  assert.equal(observed.status, 'running'); assert.equal(observed.error, undefined);

  offline = true;
  const started = Date.now();
  const r = await waitForRun(service, { run_id: submitted.run_id }, { intervalMs: 5, timeoutMs: 3000, unreachableMs: 60 });
  assert.ok(Date.now() - started < 2500, 'must not spend the whole managed wait polling a silent worker');
  assert.equal(r.worker_unreachable, true); assert.equal(r.wait_timed_out, undefined);
  assert.equal(r.status, 'running', 'last confirmed state is kept, not rewritten to failed/unknown');
  assert.equal(r.error.code, 'NETWORK_UNKNOWN');
  assert.match(r.next_action, new RegExp(submitted.run_id)); assert.match(r.next_action, /resubmit/);
  assert.equal(posts.length, 1, 'no second POST while the worker is unreachable');
});
