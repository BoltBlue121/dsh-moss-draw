import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const core = await import('../src/core.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
function createService(options) {
  assert.equal(typeof core.createService, 'function', 'persistent createService must exist');
  return core.createService(options);
}
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) { c ^= b; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function png(width = 256, height = 256) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
const request = (id = 'r1') => ({ request_id: id, prompt: 'Paint a tranquil garden.', width: 256, height: 256 });
async function setup(t, options = {}) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'moss-core-test-'));
  let posts = 0; let views = 0; let payload; let viewQuery = ''; let mode = options.mode || 'pending';
  let recordBeforePost;
  const history = {};
  const queue = { queue_running: [], queue_pending: [] };
  const pngBytes = options.png || png();
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture');
      if (req.method === 'POST' && url.pathname === '/prompt') {
        posts++;
        let body = ''; for await (const part of req) body += part;
        payload = JSON.parse(body);
        const runId = payload.extra_data.moss_run_id;
        recordBeforePost = JSON.parse(await readFile(path.join(dataRoot, 'runs', runId, 'run.json'), 'utf8'));
        const tuple = [1, 'prompt-1', payload.prompt, { ...payload.extra_data, client_id: payload.client_id }, ['12']];
        queue.queue_pending = [tuple];
        if (mode === 'dropped') { req.socket.destroy(); return; }
        if (mode === 'reject') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'invalid prompt' })); return; }
        if (mode === 'server-error') { res.writeHead(503); res.end('unavailable'); return; }
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ prompt_id: 'prompt-1', number: 1, node_errors: {} })); return;
      }
      if (req.method === 'GET' && url.pathname === '/queue') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(queue)); return; }
      if (req.method === 'GET' && (url.pathname === '/history' || url.pathname === '/history/prompt-1')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(history)); return; }
      if (req.method === 'GET' && url.pathname === '/view') {
        views++; viewQuery = url.search;
        if (options.redirect) { res.writeHead(302, { location: 'http://127.0.0.1:1/forbidden' }); res.end(); return; }
        res.setHeader('Content-Type', 'image/png'); res.end(pngBytes); return;
      }
      res.writeHead(404); res.end('unhandled fixture route');
    } catch (e) { res.writeHead(500); res.end(e.message); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const comfyUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dataRoot, { recursive: true, force: true }); });
  return {
    dataRoot, comfyUrl, history, queue,
    service: () => createService({ dataRoot, comfyUrl }),
    get posts() { return posts; }, get views() { return views; }, get payload() { return payload; }, get recordBeforePost() { return recordBeforePost; },
    complete(extra = {}) {
      queue.queue_pending = [];
      history['prompt-1'] = { prompt: [1, 'prompt-1', payload.prompt, { ...payload.extra_data, client_id: payload.client_id }, ['12']], outputs: { '12': { images: [{ filename: 'native_00001_.png', subfolder: `moss_draw/${payload.extra_data.moss_run_id}`, type: 'output' }] } }, status: { status_str: 'success', completed: true, messages: [] }, ...extra };
    },
  };
}

test('single request persists submitting before POST and is idempotent across concurrent calls and restart with omitted seed', async t => {
  const f = await setup(t); const a = f.service(); const b = f.service();
  const results = await Promise.all([a.generate(request()), a.generate(request()), b.generate(request())]);
  assert.equal(f.posts, 1);
  assert(results.every(r => r.run_id === results[0].run_id));
  assert(results.every(r => r.params.seed === results[0].params.seed));
  assert.equal(f.recordBeforePost.status, 'submitting');
  assert.match(f.recordBeforePost.input_hash, /^[0-9a-f]{64}$/);
  assert.equal(f.recordBeforePost.run_id, results[0].run_id);
  assert.equal(f.payload.extra_data.moss_run_id, results[0].run_id);
  assert.equal(f.payload.client_id, `moss-draw-${results[0].run_id}`);
  const restored = await f.service().generate(request());
  assert.equal(restored.run_id, results[0].run_id); assert.equal(restored.params.seed, results[0].params.seed);
  assert.equal(f.posts, 1);
  await assert.rejects(a.generate({ ...request(), prompt: 'different' }), { code: 'REQUEST_CONFLICT' });
  assert.equal(f.posts, 1);
  const disk = JSON.parse(await readFile(path.join(f.dataRoot, 'runs', restored.run_id, 'graph.json'), 'utf8'));
  assert.equal(disk['10'].inputs.seed, restored.params.seed);
  assert(!('graph' in restored));
});

test('lost POST response remains unknown and reconcile uses marker plus client ID without any resubmit', async t => {
  const f = await setup(t, { mode: 'dropped' });
  const result = await f.service().generate(request());
  assert.equal(result.status, 'unknown');
  const restarted = f.service();
  assert.equal((await restarted.generate(request())).status, 'unknown');
  const queued = await restarted.run({ run_id: result.run_id });
  assert.equal(queued.status, 'queued'); assert.equal(queued.prompt_id, 'prompt-1');
  f.complete();
  const complete = await restarted.run({ run_id: result.run_id });
  assert.equal(complete.status, 'succeeded'); assert.equal(f.posts, 1);
});

test('timeout is unknown, persisted submitting on restart is unknown, and foreign markers never reconcile', async t => {
  const f = await setup(t);
  const s = createService({ dataRoot: f.dataRoot, comfyUrl: f.comfyUrl, fetchImpl: async (url, init) => {
    if (init?.method === 'POST') throw new DOMException('deadline', 'TimeoutError');
    return fetch(url, init);
  } });
  const r = await s.generate(request()); assert.equal(r.status, 'unknown');
  const recordPath = path.join(f.dataRoot, 'runs', r.run_id, 'run.json');
  const record = JSON.parse(await readFile(recordPath, 'utf8')); record.status = 'submitting';
  await writeFile(recordPath, JSON.stringify(record));
  const restarted = f.service();
  assert.equal((await restarted.context({ run_id: r.run_id })).runs[0].status, 'unknown');
  assert.equal(JSON.parse(await readFile(recordPath, 'utf8')).status, 'submitting', 'context recovery must not overwrite a possibly live submitter');
  f.queue.queue_pending = [[1, 'prompt-1', {}, { moss_run_id: r.run_id, client_id: 'foreign' }, ['12']]];
  assert.equal((await restarted.run({ run_id: r.run_id })).status, 'unknown');
  assert.equal(f.posts, 0);
});

test('success requires completed history and only native node12 PNG; output hash and dimensions are verified', async t => {
  const f = await setup(t); const s = f.service(); const r = await s.generate(request());
  f.complete({ status: { status_str: 'success', completed: false, messages: [] } });
  assert.notEqual((await s.run({ run_id: r.run_id })).status, 'succeeded'); assert.equal(f.views, 0);
  f.complete();
  f.history['prompt-1'].outputs['14'] = { images: [{ filename: '../upscaled.png', subfolder: '', type: 'output' }] };
  const done = await s.run({ run_id: r.run_id });
  assert.equal(done.status, 'succeeded');
  assert.deepEqual(Object.keys(done.artifact).sort(), ['height', 'path', 'sha256', 'width']);
  assert.equal(done.artifact.path, path.join(f.dataRoot, 'runs', r.run_id, 'image.png'));
  assert.equal(done.artifact.sha256, createHash('sha256').update(png()).digest('hex'));
  assert.equal(done.artifact.width, 256); assert.equal(done.artifact.height, 256);
  assert.deepEqual(await readFile(done.artifact.path), png());
  assert.equal((await s.run({ run_id: r.run_id })).status, 'succeeded'); assert.equal(f.views, 1);
});

test('Windows worker subfolder separators collect normally without weakening traversal checks', async t => {
  const f=await setup(t),s=f.service(),r=await s.generate(request());f.complete();
  f.history['prompt-1'].outputs['12'].images[0].subfolder=`moss_draw\\${r.run_id}`;
  const done=await s.run({run_id:r.run_id});assert.equal(done.status,'succeeded');assert.equal(f.posts,1);assert.equal(f.views,1);
});
test('cancelled run waiting for the ledger lock exits promptly and never enters its GET',async t=>{
 const f=await setup(t),r=await f.service().generate(request()),cancel=new AbortController();
 const {createStore}=await import('../src/store.mjs');let release,entered;const ready=new Promise(resolve=>{entered=resolve});
 const holding=createStore(f.dataRoot).locked(async()=>{entered();await new Promise(resolve=>{release=resolve;});});await ready;
 const pending=f.service().run({run_id:r.run_id},{signal:cancel.signal});cancel.abort();
 let timer;try{await Promise.race([assert.rejects(pending,{name:'AbortError'}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('lock cancellation delayed')),200);})]);}finally{clearTimeout(timer);release();await holding;await pending.catch(()=>{});}
 assert.equal(f.views,0);
});
test('run cancellation propagates to in-flight GET without changing generation state',async t=>{
  const f=await setup(t),r=await f.service().generate(request()),cancel=new AbortController();let entered;
  const ready=new Promise(resolve=>{entered=resolve;});
  const s=createService({dataRoot:f.dataRoot,comfyUrl:f.comfyUrl,fetchImpl:async (_url,options)=>{entered();await new Promise((_,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});}});
  const waiting=s.run({run_id:r.run_id},{signal:cancel.signal});await ready;cancel.abort();await assert.rejects(waiting,{name:'AbortError'});
  assert.equal((await f.service().context({run_id:r.run_id})).runs[0].status,'queued');assert.equal(f.posts,1);
});
test('previous Windows collection failure can reconcile GET-only while real execution failure remains terminal',async t=>{
  const f=await setup(t),s=f.service(),r=await s.generate(request());f.complete();
  f.history['prompt-1'].outputs['12'].images[0].subfolder=`moss_draw\\${r.run_id}`;
  const file=path.join(f.dataRoot,'runs',r.run_id,'run.json'),record=JSON.parse(await readFile(file,'utf8'));
  record.status='failed';record.error={code:'UNSAFE_OUTPUT',message:'old separator rejection'};await writeFile(file,JSON.stringify(record));
  assert.equal((await f.service().run({run_id:r.run_id})).status,'succeeded');assert.equal(f.posts,1);
});
test('transient GET error during old collection recovery does not become terminal',async t=>{
  const f=await setup(t),s=f.service(),r=await s.generate(request());f.complete();
  f.history['prompt-1'].outputs['12'].images[0].subfolder=`moss_draw\\${r.run_id}`;
  const file=path.join(f.dataRoot,'runs',r.run_id,'run.json'),record=JSON.parse(await readFile(file,'utf8'));
  record.status='failed';record.error={code:'UNSAFE_OUTPUT',message:'old separator rejection'};await writeFile(file,JSON.stringify(record));
  const offline=createService({dataRoot:f.dataRoot,comfyUrl:f.comfyUrl,fetchImpl:async()=>{throw Error('offline')}});
  const interrupted=await offline.run({run_id:r.run_id});assert.equal(interrupted.status,'unknown');
  assert.equal((await f.service().run({run_id:r.run_id})).status,'succeeded');assert.equal(f.posts,1);
});
for (const [name, bytes] of [['invalid signature', Buffer.from('not png')], ['wrong dimensions', png(512, 256)], ['truncated PNG', png().subarray(0, 40)], ['corrupt CRC', (() => { const p = png(); p[29] ^= 1; return p; })()]]) {
  test(`artifact rejects ${name}`, async t => {
    const f = await setup(t, { png: bytes }); const s = f.service(); const r = await s.generate(request()); f.complete();
    const out = await s.run({ run_id: r.run_id });
    assert.equal(out.status, 'failed'); assert.equal(out.error.code, 'INVALID_ARTIFACT'); assert(!out.artifact);
  });
}

for (const image of [
  { filename: '../escape.png', subfolder: '', type: 'output' },
  { filename: 'evil%2fescape.png', subfolder: '', type: 'output' },
  { filename: 'x.png', subfolder: 'a/../b', type: 'output' },
  { filename: 'x.png', subfolder: path.join('fixture-tmp','nested'), type: 'output' },
  { filename: 'x.png', subfolder: '', type: 'input' },
]) test(`unsafe history output is rejected before /view: ${JSON.stringify(image)}`, async t => {
  const f = await setup(t); const s = f.service(); const r = await s.generate(request()); f.complete({ outputs: { '12': { images: [image] } } });
  const out = await s.run({ run_id: r.run_id }); assert.equal(out.status, 'failed'); assert.equal(out.error.code, 'UNSAFE_OUTPUT'); assert.equal(f.views, 0);
});

test('redirects are not followed and do not produce successful artifacts', async t => {
  const f = await setup(t, { redirect: true }); const s = f.service(); const r = await s.generate(request()); f.complete();
  const out = await s.run({ run_id: r.run_id }); assert.notEqual(out.status, 'succeeded'); assert.equal(out.error.code, 'REDIRECT_BLOCKED'); assert(!out.artifact);
});

test('failed execution cannot become success from incidental images', async t => {
  const f = await setup(t); const s = f.service(); const r = await s.generate(request());
  f.complete({ status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: 'private worker detail' }]] } });
  const out = await s.run({ run_id: r.run_id }); assert.equal(out.status, 'failed'); assert.equal(out.error.code, 'EXECUTION_FAILED'); assert.equal(f.views, 0); assert(!JSON.stringify(out).includes('private worker detail'));
});

test('context is bounded, explicit run restores exact prompt, review cannot mutate generation', async t => {
  const f = await setup(t); const s = f.service(); let r;
  for (let i = 0; i < 4; i++) r = await s.generate({ ...request(`r${i}`), prompt: 'x'.repeat(12000), negative: 'avoid blur', brief: 'Brief', checks: ['single person'] });
  const latest = await s.context(); assert.equal(latest.runs.length, 3); assert(latest.catalog); assert(!JSON.stringify(latest).includes('x'.repeat(501))); assert(JSON.stringify(latest).length < 18000);
  const specified = (await s.context({ run_id: r.run_id })).runs[0]; assert.equal(specified.context.prompt, 'x'.repeat(12000)); assert.equal(specified.context.negative, 'avoid blur');
  const recordPath = path.join(f.dataRoot, 'runs', r.run_id, 'run.json');
  const before = await readFile(recordPath, 'utf8');
  const review = { run_id: r.run_id, observations: ['looked at pixels'], issues: ['hand shape'], next_change: 'change hand pose' };
  assert.deepEqual((await s.review(review)).review.observations, ['looked at pixels']);
  assert.equal(await readFile(recordPath, 'utf8'), before, 'review is stored separately from immutable run inputs');
  assert.equal((await f.service().context({ run_id: r.run_id })).runs[0].context.review.next_change, 'change hand pose');
  await assert.rejects(s.context({ limit: 4 }), { code: 'INVALID_INPUT' });
  await assert.rejects(s.context({ run_id: '../x' }), { code: 'INVALID_INPUT' });
  await assert.rejects(s.review({ ...review, score: 5 }), { code: 'INVALID_INPUT' });
  await assert.rejects(s.review({ ...review, verdict: 'accept' }), { code: 'INVALID_INPUT' });
  await assert.rejects(s.generate({ ...request('parent'), parent_run_id: 'bba17a25-9c17-41f2-8614-9f57186c2c35' }), { code: 'RUN_NOT_FOUND' });
  assert.equal((await readdir(path.join(f.dataRoot, 'runs'))).length, 4);
});

test('permanent request claim remains queryable after crash before run JSON write', async t => {
  const f = await setup(t); const s = f.service(); const r = await s.generate(request());
  const file = path.join(f.dataRoot, 'runs', r.run_id, 'run.json');
  await rm(file);
  const recovered = await f.service().generate(request());
  assert.equal(recovered.status, 'unknown'); assert.equal(recovered.run_id, r.run_id); assert.equal(f.posts, 1);
  f.complete();
  assert.equal((await f.service().run({ run_id: r.run_id })).status, 'succeeded');
});

test('native artifact must belong to this run marker, not an unrelated safe output path', async t => {
  const f = await setup(t); const s = f.service(); const r = await s.generate(request());
  f.complete({ outputs: { '12': { images: [{ filename: 'secret.png', subfolder: 'other-project', type: 'output' }] } } });
  const result = await s.run({ run_id: r.run_id });
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'UNSAFE_OUTPUT'); assert.equal(f.views, 0);
});

test('unknown marker conflicts cannot select an arbitrary matching worker job', async t => {
  const f = await setup(t, { mode: 'dropped' }); const s = f.service(); const r = await s.generate(request());
  const first = f.queue.queue_pending[0]; f.queue.queue_running = [[first[0], 'prompt-2', ...first.slice(2)]];
  const result = await s.run({ run_id: r.run_id });
  assert.equal(result.status, 'unknown'); assert.equal(result.error.code, 'RECONCILE_AMBIGUOUS'); assert.equal(f.posts, 1);
});

test('request reservation prevents duplicate POST across independent Node processes', async t => {
  const f = await setup(t);
  const moduleUrl = new URL('../src/core.mjs', import.meta.url).href;
  const code = `import {createService} from ${JSON.stringify(moduleUrl)}; const s=createService(${JSON.stringify({ dataRoot: f.dataRoot, comfyUrl: f.comfyUrl })}); const r=await s.generate(${JSON.stringify(request())}); if(!r.run_id) process.exitCode=1;`;
  const child = () => new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', code], { stdio: 'inherit' });
    process.on('error', reject); process.on('exit', status => status === 0 ? resolve() : reject(new Error(`child exited ${status}`)));
  });
  await Promise.all([child(), child()]);
  await child(); // A third fresh process also returns the original claim.
  assert.equal(f.posts, 1);
  assert.equal((await readdir(path.join(f.dataRoot, 'runs'))).length, 1);
});

test('bounded response rejects a worker PNG exceeding the byte limit without downloading it', async t => {
  const f = await setup(t);
  const service = createService({ dataRoot: f.dataRoot, comfyUrl: f.comfyUrl, fetchImpl: async (url, init) => {
    if (new URL(url).pathname === '/view') return new Response('not downloaded', { headers: { 'content-length': '33554433' } });
    return fetch(url, init);
  } });
  const r = await service.generate(request()); f.complete();
  const out = await service.run({ run_id: r.run_id });
  assert.equal(out.status, 'failed'); assert.equal(out.error.code, 'RESPONSE_TOO_LARGE'); assert(!out.artifact);
});

test('oversized history remains recoverable rather than marking unknown execution failed', async t => {
  const f = await setup(t, { mode: 'dropped' }); let oversized = true;
  const service = createService({ dataRoot: f.dataRoot, comfyUrl: f.comfyUrl, fetchImpl: async (url, init) => {
    if (oversized && new URL(url).pathname === '/history') return new Response('{}', { headers: { 'content-length': '8388609' } });
    return fetch(url, init);
  } });
  const r = await service.generate(request()); assert.equal(r.status, 'unknown');
  f.queue.queue_pending = []; // No other source can identify this job yet.
  const pending = await service.run({ run_id: r.run_id });
  assert.equal(pending.status, 'unknown'); assert.equal(pending.error.code, 'RESPONSE_TOO_LARGE');
  oversized = false; f.complete();
  assert.equal((await service.run({ run_id: r.run_id })).status, 'succeeded'); assert.equal(f.posts, 1);
});

test('persistent oversized global history cannot block queue marker recovery and targeted history', async t => {
  const f = await setup(t, { mode: 'dropped' }); let globalReads = 0; let targetedReads = 0;
  const service = createService({ dataRoot: f.dataRoot, comfyUrl: f.comfyUrl, fetchImpl: async (url, init) => {
    const route = new URL(url).pathname;
    if (route === '/history') { globalReads++; return new Response('{}', { headers: { 'content-length': '8388609' } }); }
    if (route === '/history/prompt-1') targetedReads++;
    return fetch(url, init);
  } });
  const r = await service.generate(request());
  const queued = await service.run({ run_id: r.run_id });
  assert.equal(queued.prompt_id, 'prompt-1'); assert.equal(queued.status, 'queued');
  assert.equal(targetedReads, 1, 'identified queue job is queried by prompt_id immediately');
  assert.equal(JSON.parse(await readFile(path.join(f.dataRoot, 'runs', r.run_id, 'run.json'), 'utf8')).prompt_id, 'prompt-1');
  f.complete();
  assert.equal((await service.run({ run_id: r.run_id })).status, 'succeeded');
  assert.equal(globalReads, 1, 'known prompt_id must not reread oversized global history');
  assert.equal(targetedReads, 2); assert.equal(f.posts, 1);
});

test('queue failure cannot discard already completed matching targeted history', async t => {
  const f = await setup(t);
  const service = createService({ dataRoot: f.dataRoot, comfyUrl: f.comfyUrl, fetchImpl: async (url, init) => {
    if (new URL(url).pathname === '/queue') throw new DOMException('queue unavailable', 'TimeoutError');
    return fetch(url, init);
  } });
  const r = await service.generate(request()); f.complete();
  assert.equal((await service.run({ run_id: r.run_id })).status, 'succeeded'); assert.equal(f.posts, 1);
});

test('recent context discovers claim-only crash without caller remembering its run ID', async t => {
  const f = await setup(t); const s = f.service(); const r = await s.generate(request());
  const file = path.join(f.dataRoot, 'runs', r.run_id, 'run.json'); await rm(file);
  const recent = await f.service().context();
  assert.equal(recent.runs.length, 1); assert.equal(recent.runs[0].run_id, r.run_id); assert.equal(recent.runs[0].status, 'unknown');
  await assert.rejects(readFile(file, 'utf8'), { code: 'ENOENT' }, 'context discovers claims without manufacturing run records');
  f.complete(); assert.equal((await f.service().run({ run_id: recent.runs[0].run_id })).status, 'succeeded'); assert.equal(f.posts, 1);
});

test('coded external errors never expose raw filesystem paths or secret messages', async t => {
  const f = await setup(t);
  const service = createService({ dataRoot: f.dataRoot, comfyUrl: f.comfyUrl, fetchImpl: async (url, init) => {
    if (new URL(url).pathname === '/view') return new Response(new ReadableStream({ start(controller) { controller.error(Object.assign(new Error(path.resolve('fixture-private/token-secret/image.png')), { code: 'ENOSPC' })); } }));
    return fetch(url, init);
  } });
  const r = await service.generate(request()); f.complete();
  const out = await service.run({ run_id: r.run_id });
  assert.equal(out.error.code, 'LOCAL_ERROR'); assert(!JSON.stringify(out).includes('token-secret'));
});

test('explicit validation HTTP rejection fails; server ambiguity never automatically resubmits', async t => {
  for (const [mode, status] of [['reject', 'failed'], ['server-error', 'unknown']]) {
    const f = await setup(t, { mode }); const s = f.service(); const r = await s.generate(request());
    assert.equal(r.status, status); assert.equal((await f.service().generate(request())).run_id, r.run_id); assert.equal(f.posts, 1);
  }
});
