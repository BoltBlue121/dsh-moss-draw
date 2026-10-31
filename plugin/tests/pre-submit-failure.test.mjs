import test from 'node:test';
import assert from 'node:assert/strict';
import fs, { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createService, normalizeInput, compileGraph } from '../src/core.mjs';
import { QWEN_ADAPTER } from '../src/backends.mjs';
import { hash } from '../src/store.mjs';

const request = { request_id: 'pre-submit-failure', prompt: 'Keep the subject unchanged.', width: 256, height: 256 };
const json = async file => JSON.parse(await readFile(file, 'utf8'));
const localError = code => Object.assign(new Error(path.resolve('fixture-private/token-secret/file')), { code });
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]); let c = 0xffffffff;
  for (const byte of body) { c ^= byte; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE((c ^ 0xffffffff) >>> 0);
  return Buffer.concat([size, body, crc]);
}
function reference() {
  const header = Buffer.alloc(13); header.writeUInt32BE(1024); header.writeUInt32BE(1024, 4); header[8] = 8; header[9] = 2;
  return { data: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((1024 * 3 + 1) * 1024))), chunk('IEND', Buffer.alloc(0))]), mediaType: 'image/png', width: 1024, height: 1024 };
}

// Only the external fetch boundary is faked; real core, compilers, claims,
// filesystem writes/fsync and restart reads run against a temporary ledger.
async function fixture(t, options = {}) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'moss-pre-submit-test-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const calls = []; const postRecords = []; const uploadRecords = [];
  let history = {}; let queue = { queue_running: [], queue_pending: [] }; let getError;
  const file = id => path.join(dataRoot, 'runs', id, 'run.json');
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname; calls.push({ route, method: init.method });
    if (route === '/upload/image') {
      const image = init.body.get('image'); const id = image.name.slice(5, 41);
      uploadRecords.push(await json(file(id)));
      if (options.upload) return options.upload(image, init);
      return Response.json({ name: image.name, subfolder: '', type: 'input' });
    }
    if (route === '/prompt') {
      const payload = JSON.parse(init.body); postRecords.push(await json(file(payload.extra_data.moss_run_id)));
      if (options.post) return options.post(payload, init);
      return Response.json({ prompt_id: 'accepted-prompt', number: 1, node_errors: {} });
    }
    if (getError) throw getError;
    if (route.startsWith('/history')) return Response.json(history);
    if (route === '/queue') return Response.json(queue);
    assert.fail('Unexpected fixture route ' + route);
  };
  return { dataRoot, file, calls, postRecords, uploadRecords,
    service: adapter => createService({ dataRoot, comfyUrl: 'http://fixture.invalid', fetchImpl, ...(adapter ? { adapter } : {}) }),
    setGetError(error) { getError = error; },
    setEvidence(nextHistory, nextQueue = { queue_running: [], queue_pending: [] }) { history = nextHistory; queue = nextQueue; },
  };
}

// Fault injection stays at the filesystem boundary, after actual temp writes
// and fsync. No production-only testing hook and no fake persistence layer.
async function interceptRename(operation, intercept) {
  const original = fs.rename;
  fs.rename = async (from, to) => intercept(from, to, () => original(from, to));
  syncBuiltinESMExports();
  try { return await operation(); }
  finally { fs.rename = original; syncBuiltinESMExports(); }
}
async function assertReserved(f, input, assets, adapter, result) {
  const before = f.calls.length;
  const same = await f.service(adapter).generate(input, assets);
  assert.equal(same.run_id, result.run_id); assert.equal(same.status, result.status);
  assert.equal(same.params.seed, result.params.seed, 'omitted seed must retain original request identity');
  assert.deepEqual(same.error, result.error); assert.equal(f.calls.length, before, 'no upload or POST retry');
  const claim = await json(path.join(f.dataRoot, 'requests', `${hash(input.request_id)}.json`));
  assert.equal(claim.run_id, result.run_id);
  await assert.rejects(f.service(adapter).generate({ ...input, prompt: 'changed' }, assets), { code: 'REQUEST_CONFLICT' });
  return same;
}
function assertPreSubmit(result, source, phase) {
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'PRE_SUBMIT_FAILED');
  assert.equal(result.error.source_code, source); assert.equal(result.error.phase, phase);
  assert.equal(result.submission_phase, phase); assert.equal(result.prompt_id, undefined);
  assert(!JSON.stringify(result).includes('token-secret'));
}

test('Qwen upload body local error settles before graph or prompt and keeps original claim', async t => {
  const f = await fixture(t, { upload: () => new Response(new ReadableStream({ start(c) { c.error(localError('ENOSPC')); } })) });
  const input = { request_id: request.request_id, prompt: request.prompt, backend: 'qwen', mode: 'edit' }; const assets = [reference(), reference()];
  const result = await f.service(QWEN_ADAPTER).generate(input, assets);
  assertPreSubmit(result, 'ENOSPC', 'uploading');
  const record = await json(f.file(result.run_id));
  assert.deepEqual(record.uploaded, []); assert.equal(record.output_node, undefined); assert.equal(record.prompt_id, undefined);
  for (const name of ['ref1.png', 'ref2.png']) assert.deepEqual(await readFile(path.join(f.dataRoot, 'runs', result.run_id, name)), assets[0].data);
  await assert.rejects(readFile(path.join(f.dataRoot, 'runs', result.run_id, 'graph.json')), { code: 'ENOENT' });
  await assertReserved(f, input, assets, QWEN_ADAPTER, result);
  assert.deepEqual(await f.service().run({ run_id: result.run_id }), result, 'terminal pre-submit failure never reconciles away its cause');
  assert.equal(f.calls.length, 1); assert.equal(f.postRecords.length, 0);
});

for (const [code, source] of [['INVALID_INPUT', 'INVALID_INPUT'], ['ENOSPC', 'ENOSPC'], ['private-token-secret', 'LOCAL_ERROR']]) test(`compiler failure retains only safe source code ${source}`, async t => {
  const f = await fixture(t); const adapter = { normalize: normalizeInput, compile() { throw localError(code); } };
  const result = await f.service(adapter).generate(request);
  assertPreSubmit(result, source, 'preparing'); assert.equal(f.calls.length, 0);
  await assertReserved(f, request, [], adapter, result);
});

for (const target of ['initial-record', 'reference', 'graph', 'compiled-record', 'submit-marker', 'submit-marker-after-rename']) test(`${target} persistence failure forbids prompt POST and retains a terminal reservation`, async t => {
  const f = await fixture(t); const assets = target === 'reference' ? [reference()] : [];
  const input = assets.length ? { ...request, mode: 'edit' } : request;
  let injected = false;
  const result = await interceptRename(() => f.service().generate(input, assets), async (from, to, proceed) => {
    let match = target === 'reference' && path.basename(to) === 'ref1.png' || target === 'graph' && path.basename(to) === 'graph.json';
    if (path.basename(to) === 'run.json') {
      const next = await json(from);
      match ||= target === 'initial-record' && next.status === 'submitting' && !next.output_node;
      match ||= target === 'compiled-record' && next.submission_phase === 'compiled';
      match ||= target.startsWith('submit-marker') && next.submission_phase === 'submit_started';
    }
    if (match && !injected) {
      injected = true;
      if (target === 'submit-marker-after-rename') await proceed();
      throw localError('ENOSPC');
    }
    return proceed();
  });
  assert.equal(injected, true, 'the expected durability boundary was exercised');
  assertPreSubmit(result, 'ENOSPC', ['compiled-record', 'submit-marker', 'submit-marker-after-rename'].includes(target) ? 'compiled' : 'preparing');
  assert.equal(f.calls.length, 0); await assertReserved(f, input, assets, undefined, result);
});

test('persistent marker and settlement write failure leaves a recoverable unknown reservation without POST', async t => {
  const f = await fixture(t); let markerFailed = false;
  await interceptRename(() => assert.rejects(f.service().generate(request), { code: 'LOCAL_ERROR' }), async (from, to, proceed) => {
    if (path.basename(to) === 'run.json') {
      const next = await json(from);
      if (next.submission_phase === 'submit_started') markerFailed = true;
      if (markerFailed) throw localError('ENOSPC');
    }
    return proceed();
  });
  assert.equal(markerFailed, true); assert.equal(f.calls.length, 0);
  const same = await f.service().generate(request);
  assert.equal(same.status, 'unknown'); assert.equal(same.submission_phase, 'compiled');
  assert.equal((await f.service().run({ run_id: same.run_id })).status, 'unknown');
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});

test('receipt persistence failure after accepted POST keeps submit_started and never retries submission', async t => {
  const f = await fixture(t);
  await interceptRename(() => assert.rejects(f.service().generate(request), { code: 'LOCAL_ERROR' }), async (from, to, proceed) => {
    if (path.basename(to) === 'run.json' && (await json(from)).status === 'queued') throw localError('ENOSPC');
    return proceed();
  });
  const same = await f.service().generate(request);
  assert.equal(same.status, 'unknown'); assert.equal(same.submission_phase, 'submit_started');
  assert.equal(same.prompt_id, undefined); assert.equal(f.postRecords.length, 1);
});

test('durable stages precede upload and prompt and expose graph receipt before submit_started', async t => {
  const f = await fixture(t); const assets = [reference()]; const input = { ...request, mode: 'edit' }; const writes = [];
  const result = await interceptRename(() => f.service().generate(input, assets), async (from, to, proceed) => {
    const saved = path.basename(to) === 'run.json' ? await json(from) : null;
    const done = await proceed();
    if (saved) {
      writes.push(saved.submission_phase);
      if (saved.submission_phase === 'compiled' || saved.submission_phase === 'submit_started') {
        const graph = await json(path.join(path.dirname(to), 'graph.json'));
        assert.equal(graph[saved.output_node].inputs.filename_prefix, `moss_draw/${saved.run_id}/native`);
      }
    }
    return done;
  });
  assert.equal(result.status, 'queued');
  assert.deepEqual([...new Set(writes)], ['preparing', 'uploading', 'compiled', 'submit_started']);
  assert.equal(f.uploadRecords[0].submission_phase, 'uploading');
  assert.equal(f.postRecords[0].submission_phase, 'submit_started'); assert.equal(f.postRecords[0].status, 'submitting');
  assert.equal((await f.service().context({ run_id: result.run_id })).runs[0].submission_phase, 'submit_started');
});

for (const [name, post, code] of [
  ['lost reply', () => { throw localError('ECONNRESET'); }, 'NETWORK_UNKNOWN'],
  ['body read error', () => new Response(new ReadableStream({ start(c) { c.error(localError('ENOSPC')); } })), 'LOCAL_ERROR'],
  ['invalid receipt', () => Response.json({}), 'INVALID_RESPONSE'],
  ['server error', () => new Response('', { status: 503 }), 'HTTP_ERROR'],
]) test(`possible prompt POST ${name} stays unknown and preserves first cause across absent/error reconciliation`, async t => {
  const f = await fixture(t, { post }); const result = await f.service().generate(request);
  assert.equal(result.status, 'unknown'); assert.equal(result.error.code, code);
  assert.equal(result.submission_phase, 'submit_started'); assert.equal(result.initial_error.code, code); assert.equal(result.initial_error.phase, 'submit_started');
  assert.equal(result.initial_error.source_code, name === 'body read error' ? 'ENOSPC' : code);
  assert(!JSON.stringify(result).includes('token-secret'));
  await assertReserved(f, request, [], undefined, result);
  for (let i = 0; i < 2; i++) {
    const absent = await f.service().run({ run_id: result.run_id });
    assert.equal(absent.status, 'unknown'); assert.equal(absent.error.code, 'NOT_FOUND_YET');
    assert.deepEqual(absent.initial_error, result.initial_error); assert.equal(absent.submission_phase, 'submit_started');
  }
  f.setGetError(new Error('network down'));
  const unreadable = await f.service().run({ run_id: result.run_id });
  assert.equal(unreadable.status, 'unknown'); assert.deepEqual(unreadable.initial_error, result.initial_error);
  assert.equal((await json(f.file(result.run_id))).initial_error.code, code); assert.equal(f.postRecords.length, 1);
});

for (const status of [400, 401, 403, 404, 422]) test(`explicit prompt HTTP ${status} remains terminal failed rather than pre-submit`, async t => {
  const f = await fixture(t, { post: () => new Response('', { status }) });
  const result = await f.service().generate(request);
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'HTTP_ERROR'); assert.equal(result.submission_phase, 'submit_started');
  await assertReserved(f, request, [], undefined, result); assert.equal(f.postRecords.length, 1);
});

test('upload HTTP server error is still a definite pre-prompt failure', async t => {
  const f = await fixture(t, { upload: () => new Response('', { status: 503 }) });
  const result = await f.service().generate({ ...request, mode: 'edit' }, [reference()]);
  assertPreSubmit(result, 'HTTP_ERROR', 'uploading'); assert.equal(f.postRecords.length, 0);
});

test('old unknown record keeps its original safe local error without inventing a submission stage', async t => {
  const f = await fixture(t); const result = await f.service().generate(request);
  const record = await json(f.file(result.run_id)); record.status = 'unknown';
  record.error = { code: 'LOCAL_ERROR', message: 'Local operation failed; ask maintenance to inspect.' };
  delete record.prompt_id; delete record.submission_phase; delete record.initial_error; await writeFile(f.file(result.run_id), JSON.stringify(record));
  const observed = await f.service().run({ run_id: result.run_id });
  assert.equal(observed.status, 'unknown'); assert.equal(observed.error.code, 'NOT_FOUND_YET'); assert.equal(observed.submission_phase, undefined);
  assert.deepEqual(observed.initial_error, record.error);
  assert.deepEqual((await f.service().context({ run_id: result.run_id })).runs[0].initial_error, record.error);
});

for (const phase of [undefined, 'preparing', 'uploading', 'compiled', 'submit_started']) test(`interrupted record phase ${phase} never means permission to settle or submit again`, async t => {
  const f = await fixture(t); const result = await f.service().generate(request); const record = await json(f.file(result.run_id));
  record.status = 'submitting'; delete record.prompt_id;
  if (phase) record.submission_phase = phase; else delete record.submission_phase;
  await writeFile(f.file(result.run_id), JSON.stringify(record));
  assert.equal((await f.service().generate(request)).status, 'unknown');
  assert.equal((await f.service().run({ run_id: result.run_id })).status, 'unknown'); assert.equal(f.postRecords.length, 1);
});

test('claim-only preparing marker is not evidence of no POST and still recovers matching worker receipt', async t => {
  const f = await fixture(t); const result = await f.service().generate(request);
  // Remove only this fixture's resolved run record; the permanent claim survives.
  assert.equal(path.dirname(f.file(result.run_id)), path.join(f.dataRoot, 'runs', result.run_id));
  await rm(f.file(result.run_id));
  const observed = (await f.service().context()).runs[0]; assert.equal(observed.status, 'unknown');
  await assert.rejects(readFile(f.file(result.run_id)), { code: 'ENOENT' });
  assert.equal((await f.service().generate(request)).run_id, result.run_id);
  assert.equal((await f.service().run({ run_id: result.run_id })).status, 'unknown');
  const params = normalizeInput({ ...request, seed: result.params.seed });
  const tuple = [1, 'accepted-prompt', compileGraph(params, result.run_id), { client_id: `moss-draw-${result.run_id}`, moss_run_id: result.run_id }, ['12']];
  f.setEvidence({}, { queue_running: [], queue_pending: [tuple] });
  const recovered = await f.service().run({ run_id: result.run_id });
  assert.equal(recovered.status, 'queued'); assert.equal(recovered.prompt_id, 'accepted-prompt'); assert.equal(f.postRecords.length, 1);
});

for (const boundary of ['compiled', 'submit_started']) test(`cancellation while ${boundary} marker is written never reaches POST`, async t => {
  const f = await fixture(t); const controller = new AbortController(); let cancelled = false;
  await interceptRename(() => assert.rejects(f.service().generate(request, [], { signal: controller.signal }), { name: 'AbortError' }), async (from, to, proceed) => {
    const saved = path.basename(to) === 'run.json' ? await json(from) : null;
    const done = await proceed();
    if (!cancelled && saved?.submission_phase === boundary) { cancelled = true; controller.abort(); }
    return done;
  });
  assert.equal(cancelled, true); assert.equal(f.calls.length, 0);
  const same = await f.service().generate(request); assert.equal(same.status, 'failed'); assert.equal(same.error.code, 'CANCELLED_BEFORE_SUBMIT');
});

test('caller cancellation after POST starts cannot change an uncertain submission into cancelled-before-submit', async t => {
  const controller = new AbortController(); const f = await fixture(t, { post: () => { controller.abort(); throw controller.signal.reason; } });
  const result = await f.service().generate(request, [], { signal: controller.signal });
  assert.equal(result.status, 'unknown'); assert.equal(result.error.code, 'NETWORK_UNKNOWN'); assert.equal(result.submission_phase, 'submit_started');
  assert.equal(f.postRecords.length, 1); assert.equal((await f.service().generate(request)).run_id, result.run_id);
});
