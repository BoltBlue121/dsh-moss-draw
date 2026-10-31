import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { normalizeInput, createService, compileGraph } from '../src/core.mjs';
const modes = await import('../src/modes.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const id = 'bba17a25-9c17-41f2-8614-9f57186c2c35';
const req = { request_id: 'modes-1', prompt: 'A quiet garden.', seed: 7 };
function crc32(bytes) { let c = 0xffffffff; for (const b of bytes) { c ^= b; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const body = Buffer.concat([Buffer.from(type), data]); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([size, body, crc]); }
function png(width = 256, height = 256, alpha = 'mixed', rgba = true) {
  const channels = rgba ? 4 : 3; const stride = width * channels + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    raw[y * stride + 1 + x * channels] = x % 256;
    if (rgba) raw[y * stride + 1 + x * channels + 3] = alpha === 'mixed' ? (x < width / 2 ? 0 : 255) : alpha;
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = rgba ? 6 : 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const asset = (width = 256, height = 256, alpha = 'mixed', rgba = true) => ({ data: png(width, height, alpha, rgba), mediaType: 'image/png', width, height });
const upload = (n = 1) => ({ name: `moss-${id}-ref${n}.png`, subfolder: '', type: 'input' });
function compile(input, assets = [], uploaded = assets.map((_, i) => upload(i + 1))) {
  assert.equal(typeof modes.compileMode, 'function', 'compileMode must exist');
  return modes.compileMode(normalizeInput(input, assets), id, uploaded);
}

test('valid two-frame APNG cannot turn one reference into a Comfy image batch', () => {
  const base = png();
  const idatLength = base.readUInt32BE(33);
  const idat = base.subarray(41, 41 + idatLength);
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2); // two frames, infinite plays
  const frame = sequence => {
    const data = Buffer.alloc(26); data.writeUInt32BE(sequence); data.writeUInt32BE(256, 4); data.writeUInt32BE(256, 8);
    data.writeUInt16BE(1, 20); data.writeUInt16BE(10, 22); // delay 1/10, dispose none, blend source
    return chunk('fcTL', data);
  };
  const sequence = Buffer.alloc(4); sequence.writeUInt32BE(2);
  const apng = Buffer.concat([base.subarray(0, 33), chunk('acTL', animation), frame(0), chunk('IDAT', idat), frame(1), chunk('fdAT', Buffer.concat([sequence, idat])), chunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => normalizeInput({ ...req, mode: 'edit' }, [{ data: apng, mediaType: 'image/png', width: 256, height: 256 }]), { code: 'INVALID_INPUT' });
});

test('mode t2i preserves final baseline graph and forbids reference or character conditioning', () => {
  const p = normalizeInput(req); const result = compile({ ...req, mode: 't2i' });
  assert.deepEqual(result.graph, compileGraph(p, id)); assert.equal(result.outputNode, '12');
  assert.throws(() => normalizeInput({ ...req, mode: 't2i' }, [asset()]), { code: 'INVALID_INPUT' });
  assert.throws(() => normalizeInput({ ...req, characters: [{ prompt: 'someone' }] }), { code: 'INVALID_INPUT' });
});

test('edit single clones validated template with accurate full SFT parameters', () => {
  const assets = [asset(513, 301)]; const p = normalizeInput({ ...req, mode: 'edit' }, assets);
  const { graph: g, outputNode } = compile({ ...req, mode: 'edit' }, assets);
  assert.equal(outputNode, '4'); assert.deepEqual(Object.keys(g), ['1', '2', '3', '4']);
  assert.equal(g['1'].inputs.snapshot_dir, 'moss_image/MOSS-Image-SFT'); assert.equal(g['1'].inputs.adapter_dir, 'moss_image/Moss-Image-Edit');
  assert.equal(g['2'].inputs.image, upload().name); assert.deepEqual(g['3'].inputs.reference_1, ['2', 0]);
  assert.equal(g['3'].inputs.prompt, req.prompt); assert.equal(g['3'].inputs.steps, 30); assert.equal(g['3'].inputs.cfg, 4); assert.equal(g['3'].inputs.inference_shift, 5); assert.equal(g['3'].inputs.reference_max_edge, 512);
  assert.equal(p.width % 16, 0); assert.equal(p.height % 16, 0); assert.equal(g['3'].inputs.width, p.width); assert.equal(g['3'].inputs.height, p.height);
  assert.equal(g['4'].inputs.filename_prefix, `moss_draw/${id}/native`); assert.equal(p.style, 'none'); assert.equal(p.slg, null);
});

for (const count of [2, 3, 4]) test(`edit ${count} references preserves exact ordering and has no spare connected slots`, () => {
  const assets = Array.from({ length: count }, () => asset());
  const { graph: g, outputNode } = compile({ ...req, mode: 'edit', width: 768, height: 512, steps: 40, cfg: 3.5, shift: 6 }, assets);
  assert.equal(outputNode, '5'); assert.equal(g['4'].inputs.steps, 40); assert.equal(g['4'].inputs.width, 768);
  const loads = Object.entries(g).filter(([, node]) => node.class_type === 'LoadImage'); assert.equal(loads.length, count);
  for (let i = 1; i <= count; i++) { const link = g['4'].inputs[`reference_${i}`]; assert.equal(g[link[0]].inputs.image, upload(i).name); }
  for (let i = count + 1; i <= 4; i++) assert(!g['4'].inputs[`reference_${i}`]);
});

test('mode compiler rejects a safe-looking reference from a different run or wrong ordinal', () => {
  const assets = [asset()];
  for (const u of [{ ...upload(), name: 'moss-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-ref1.png' }, upload(2)]) {
    assert.throws(() => compile({ ...req, mode: 'edit' }, assets, [u]), { code: 'INVALID_INPUT' });
  }
});

test('inpaint preserves crop composite and mask template, RGBA original dimensions and sampler defaults', () => {
  const a = asset(513, 301); const p = normalizeInput({ ...req, mode: 'inpaint', negative: 'blur' }, [a]);
  const { graph: g, outputNode, maskNode } = compile({ ...req, mode: 'inpaint', negative: 'blur' }, [a]);
  assert.equal(outputNode, '60'); assert.equal(maskNode, '62'); assert.equal(p.width, 513); assert.equal(p.height, 301);
  assert.equal(g['10'].inputs.image, upload().name); assert.equal(g['19'].inputs.value, req.prompt); assert.equal(g['21'].inputs.text, 'blur');
  assert.equal(g['30'].inputs.expand, 8); assert.equal(g['30'].inputs.blur_radius, 16); assert.equal(g['31'].inputs.padding, 256);
  assert.equal(g['52'].class_type, 'ImageCompositeMasked'); assert.deepEqual(g['52'].inputs.destination, ['10', 0]);
  assert.equal(g['40'].inputs.steps, 25); assert.equal(g['40'].inputs.cfg, 2.5); assert.equal(g['40'].inputs.sampler_name, 'er_sde'); assert.equal(g['40'].inputs.scheduler, 'simple');
  assert.equal(p.shift, null); assert.equal(p.slg, null); assert.equal(g['62'].inputs.filename_prefix, `moss_draw/${id}/effective-mask`);
});

test('edit compiles the legacy loader with style none and rejects every styled request', () => {
  const {graph:g}=compile({...req,mode:'edit',style:'none',lora_strength:0},[asset()]);
  assert.equal(g['1'].class_type,'MossImageEditLoader');
  assert.equal(g['3'].inputs.prompt,req.prompt);
  // Portable package: the style loader is not a normal path, so any style other
  // than none (or a non-zero strength) must be rejected before compilation.
  for(const patch of [{style:'styled',lora_strength:0.6},{style:'none',lora_strength:0.6}]) {
    assert.throws(()=>normalizeInput({...req,mode:'edit',...patch},[asset(),asset()]),{code:'INVALID_INPUT'});
  }
  assert.throws(()=>modes.compileMode({...normalizeInput({...req,mode:'edit'},[asset()]),style:'not-known'},id,[upload()]));
});

test('mode counts, alpha masks, dimensions, assets and unsupported mode parameters are rejected', () => {
  for (const [input, assets] of [
    [{ ...req, mode: 'bad' }, []], [{ ...req, mode: 'edit' }, []], [{ ...req, mode: 'edit' }, Array(5).fill(asset())],
    [{ ...req, mode: 'inpaint' }, [asset(), asset()]], [{ ...req, mode: 'inpaint' }, [asset(256, 256, 255)]], [{ ...req, mode: 'inpaint' }, [asset(256, 256, 0)]],
    [{ ...req, mode: 'inpaint' }, [asset(256, 256, 128)]], [{ ...req, mode: 'inpaint' }, [asset(256, 256, 'mixed', false)]], [{ ...req, mode: 'inpaint', width: 512 }, [asset()]],
    [{ ...req, mode: 'edit', model: 'base' }, [asset()]], [{ ...req, mode: 'edit', style: 'unknown-style' }, [asset()]], [{ ...req, mode: 'edit', lora_strength: 1 }, [asset()]],
    [{ ...req, mode: 'inpaint', shift: 5 }, [asset()]], [{ ...req, mode: 'characters', shift: 5, characters: [{ prompt: 'person' }] }, []],
    [{ ...req, mode: 'edit', references: ['/fixture/private'] }, [asset()]], [{ ...req, mode: 'edit', graph: {} }, [asset()]],
    [{ ...req, mode: 'edit' }, [{ ...asset(), width: 512 }]], [{ ...req, mode: 'edit' }, [{ ...asset(), mediaType: 'image/jpeg' }]],
    [{ ...req, mode: 'edit' }, [{ ...asset(), path: '/fixture/private' }]], [{ ...req, mode: 'edit' }, [{ ...asset(), data: Buffer.from('not image') }]],
  ]) assert.throws(() => normalizeInput(input, assets), undefined, JSON.stringify(input));
});

test('mode bounds reject worker-unsupported RS steps/cfg and Edit inference shift before claims', async t => {
  const f = await fixture(t);
  for (const patch of [{ steps: 1 }, { cfg: 0.5 }, { characters: [{ prompt: 'A woman.', width: 0.001 }] }, { characters: [{ prompt: 'A woman.', height: 0.001 }] }]) await assert.rejects(f.service().generate({ ...req, mode: 'characters', characters: [{ prompt: 'A woman.' }], ...patch }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.service().generate({ ...req, mode: 'edit', shift: 0 }, [asset()]), { code: 'INVALID_INPUT' });
  await assert.rejects(readdir(path.join(f.dataRoot, 'requests')), { code: 'ENOENT' }); assert.equal(f.posts, 0);
});

test('characters clone RS graph with independent captions and geometry, without style LoRA or t2i patches', () => {
  const input = { ...req, mode: 'characters', model: 'base', characters: [{ prompt: 'Woman in red.', style: 'none' }, { prompt: 'Woman in blue.', style: 'none', x: 0.8, lora_strength: 0 }] };
  const p = normalizeInput(input); const { graph: g, outputNode } = compile(input);
  assert.equal(outputNode, '11'); assert.equal(g['1'].inputs.unet_name, 'moss_image_base_int8_convrot.safetensors');
  assert.equal(g['4'].inputs.value, 'Woman in red.'); assert.equal(g['5'].inputs.value, 'Woman in blue.');
  for (const n of ['6', '7', '8']) assert.equal(g[n].inputs.character_count, 2);
  assert.equal(g['7'].inputs.character1_lora, 'None'); assert.equal(g['7'].inputs.character2_lora, 'None'); assert.equal(g['7'].inputs.character2_lora_strength, 0); assert.equal(g['7'].inputs.character1_lora_clip_strength, 0); assert.equal(g['7'].inputs.lora_application_mode, 'precision');
  assert.equal(g['8'].inputs.character1_x, 0.25); assert.equal(g['8'].inputs.character2_x, 0.8);
  assert.equal(g['10'].inputs.autosave, false); assert.equal(g['10'].inputs.steps, 50); assert.equal(g['10'].inputs.scheduler, 'simple'); assert.equal(g['10'].inputs.prompt, req.prompt);
  assert.equal(p.sampler, 'euler'); assert.equal(p.scheduler, 'simple'); assert.equal(p.slg, null); assert.equal(p.characters[0].prompt, 'Woman in red.'); assert.equal(p.characters[0].style, 'none'); assert.equal(p.characters[0].lora_strength, 0); assert(Object.isFrozen(p.characters[0]));
  assert(!Object.values(g).some(n => ['SkipLayerGuidanceDiTSimple', 'ModelSamplingAuraFlow'].includes(n.class_type)));
});

test('point geometry rejects explicit box width and height instead of pretending control', () => {
  for (const field of ['width', 'height']) {
    assert.throws(() => normalizeInput({ ...req, mode: 'characters', characters: [{ prompt: 'A woman.', [field]: 0.4 }] }), { code: 'INVALID_INPUT' });
  }
});

test('characters enforce 1..2 and accept SFT without silent switches or inherited sample captions', () => {
  const one = { ...req, mode: 'characters', characters: [{ prompt: 'One woman.' }] };
  const p = normalizeInput(one); const { graph: g } = compile(one);
  assert.equal(p.model, 'sft'); assert.equal(g['6'].inputs.character_count, 1); assert(!g['6'].inputs.character2); assert.equal(g['6'].inputs.character2_enable, false);
  assert(!JSON.stringify(g).includes('long blonde hair'));
  for (const input of [
    { ...one, characters: [] }, { ...one, characters: Array(3).fill({ prompt: 'x' }) },
    { ...one, characters: [{ prompt: 'x', style: 'unknown' }] }, { ...one, characters: [{ prompt: 'x', style: 'none', lora_strength: 1 }] }, { ...one, model: 'unknown', characters: [{ prompt: 'x', style: 'none' }] },
    { ...one, characters: [{ prompt: 'x', x: NaN }] }, { ...one, characters: [{ prompt: 'x', width: 0 }] },
    { ...one, characters: [{ prompt: 'x', y: 1.1 }] }, { ...one, characters: [{ prompt: 'x', path: '/bad' }] },
  ]) assert.throws(() => normalizeInput(input));
});

async function fixture(t, options = {}) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'moss-modes-test-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const uploads = []; let posts = 0; let payload; let runRecord; let history = {}; let maskReads = 0; let imageReads = 0;
  const fetchImpl = async (url, init) => {
    const route = new URL(url).pathname;
    if (route === '/upload/image') {
      const file = init.body.get('image'); const name = file.name;
      assert.equal(init.body.get('overwrite'), 'false'); assert.equal(init.body.get('type'), 'input'); assert.equal(init.redirect, 'error');
      const claims = await readdir(path.join(dataRoot, 'requests')); assert.equal(claims.filter(n => n.endsWith('.json')).length, 1, 'claim must precede first upload');
      uploads.push({ name, bytes: Buffer.from(await file.arrayBuffer()) });
      if (options.abortOnUpload) options.abortOnUpload.abort();
      if (options.uploadTimeout) throw new DOMException('lost upload', 'TimeoutError');
      return Response.json(options.unsafeUpload ? { name: '../evil.png', subfolder: '', type: 'input' } : { name, subfolder: '', type: 'input' });
    }
    if (route === '/prompt') {
      posts++; payload = JSON.parse(init.body); runRecord = JSON.parse(await readFile(path.join(dataRoot, 'runs', payload.extra_data.moss_run_id, 'run.json'), 'utf8'));
      assert.equal(runRecord.status, 'submitting');
      if (options.postTimeout) throw new DOMException('lost post', 'TimeoutError');
      if (options.postBodyAbort) return new Response(new ReadableStream({start(c){c.error(new DOMException('lost POST body','AbortError'));}}));
      return Response.json({ prompt_id: 'mode-prompt', number: 1, node_errors: {} });
    }
    if (route.startsWith('/history')) return Response.json(history);
    if (route === '/queue') return Response.json({ queue_running: [], queue_pending: [] });
    if (route === '/view') {
      if (new URL(url).searchParams.get('filename').startsWith('effective-mask')) {
        maskReads++; if (options.maskTimeout && maskReads === 1) throw new DOMException('mask timeout', 'TimeoutError');
      } else imageReads++;
      return new Response(png(runRecord.params.width, runRecord.params.height));
    }
    throw Error('Unexpected local fixture route ' + route);
  };
  const service = adapter => createService({ dataRoot, comfyUrl: 'http://127.0.0.1:1', fetchImpl, ...(adapter ? { adapter } : {}) });
  return { dataRoot, uploads, service, get posts() { return posts; }, get record() { return runRecord; }, get maskReads() { return maskReads; }, get imageReads() { return imageReads; },
    complete() {
      const rid = payload.extra_data.moss_run_id; const node = runRecord.output_node;
      history = { 'mode-prompt': { prompt: [1, 'mode-prompt', payload.prompt, { ...payload.extra_data, client_id: payload.client_id }, [node]], status: { completed: true, status_str: 'success', messages: [] }, outputs: { [node]: { images: [{ filename: 'native_00001_.png', subfolder: `moss_draw/${rid}`, type: 'output' }] }, ...(runRecord.mask_node ? { [runRecord.mask_node]: { images: [{ filename: 'effective-mask_00001_.png', subfolder: `moss_draw/${rid}`, type: 'output' }] } } : {}) } } };
    },
  };
}

test('cancel after reference upload prevents first prompt POST and stays terminal on same request',async t=>{
 const cancel=new AbortController(),f=await fixture(t,{abortOnUpload:cancel}),input={...req,mode:'edit',request_id:'cancel-before-post'};
 await assert.rejects(f.service().generate(input,[asset()],{signal:cancel.signal}),{name:'AbortError'});
 assert.equal(f.posts,0);assert.equal(f.uploads.length,1);
 const same=await f.service().generate(input,[asset()]);assert.equal(same.status,'failed');assert.equal(same.error.code,'CANCELLED_BEFORE_SUBMIT');assert.equal(f.posts,0);assert.equal(f.uploads.length,1);
});

test('edit uploads each asset once, persists original hashes and ordered receipts, hashes images for idempotency', async t => {
  const f = await fixture(t); const assets = [asset(), asset(512, 256)]; const input = { ...req, mode: 'edit' };
  const a = await f.service().generate(input, assets); const b = await f.service().generate(input, assets);
  assert.equal(a.run_id, b.run_id); assert.equal(f.posts, 1); assert.equal(f.uploads.length, 2); assert.equal(f.record.output_node, '5');
  assert.equal(f.record.assets.length, 2); assert.equal(f.record.assets[0].sha256, createHash('sha256').update(assets[0].data).digest('hex'));
  assert.deepEqual(await readFile(path.join(f.dataRoot, 'runs', a.run_id, 'ref1.png')), assets[0].data);
  assert.equal(f.record.uploaded[1].name, `moss-${a.run_id}-ref2.png`);
  await assert.rejects(f.service().generate(input, [asset(256, 256, 128), assets[1]]), { code: 'REQUEST_CONFLICT' });
  f.complete(); const done = await f.service().run({ run_id: a.run_id }); assert.equal(done.status, 'succeeded'); assert.equal(done.artifact.width, 256); assert.equal(done.params.mode, 'edit'); assert.equal(f.posts, 1);
});

for (const option of ['uploadTimeout', 'postTimeout', 'postBodyAbort', 'unsafeUpload']) test(`${option} preserves the submission boundary and never repeats remote writes after restart`, async t => {
  const f = await fixture(t, { [option]: true }); const input = { ...req, mode: 'edit' };
  const submitted = ['postTimeout', 'postBodyAbort'].includes(option);
  const r = await f.service().generate(input, [asset()]); assert.equal(r.status, submitted ? 'unknown' : 'failed');
  assert.equal(r.submission_phase, submitted ? 'submit_started' : 'uploading');
  if (!submitted) {
    assert.equal(r.error.code, 'PRE_SUBMIT_FAILED');
    assert.equal(r.error.source_code, option === 'uploadTimeout' ? 'NETWORK_UNKNOWN' : 'INVALID_RESPONSE');
    assert.equal(r.error.phase, 'uploading');
  }
  const same = await f.service().generate(input, [asset()]); assert.equal(same.run_id, r.run_id); assert.equal(same.status, r.status);
  assert.equal(f.uploads.length, 1); assert.equal(f.posts, submitted ? 1 : 0);
});

test('all original references are durable before the first uncertain upload', async t => {
  const f = await fixture(t, { uploadTimeout: true }); const assets = [asset(), asset(512, 256)];
  const r = await f.service().generate({ ...req, mode: 'edit' }, assets);
  assert.equal(r.status, 'failed'); assert.equal(r.error.code, 'PRE_SUBMIT_FAILED');
  assert.deepEqual(await readFile(path.join(f.dataRoot, 'runs', r.run_id, 'ref2.png')), assets[1].data);
  assert.equal(f.uploads.length, 1); assert.equal(f.posts, 0);
});

test('inpaint routes image60 and effective-mask62 independently under fixed run paths', async t => {
  const f = await fixture(t); const r = await f.service().generate({ ...req, mode: 'inpaint' }, [asset(513, 301)]);
  assert.equal(f.record.output_node, '60'); assert.equal(f.record.mask_node, '62'); f.complete();
  const done = await f.service().run({ run_id: r.run_id }); assert.equal(done.status, 'succeeded'); assert.equal(done.artifact.width, 513);
  assert.equal(done.effective_mask.width, 513); assert.equal(done.effective_mask.path, path.join(f.dataRoot, 'runs', r.run_id, 'effective-mask.png'));
});

test('succeeded inpaint retries only its validated effective-mask GET after transient timeout', async t => {
  const f = await fixture(t, { maskTimeout: true }); const r = await f.service().generate({ ...req, mode: 'inpaint' }, [asset()]); f.complete();
  const first = await f.service().run({ run_id: r.run_id }); assert.equal(first.status, 'succeeded'); assert(first.mask_error); assert(!first.effective_mask);
  const next = await f.service().run({ run_id: r.run_id }); assert.equal(next.status, 'succeeded'); assert(next.effective_mask); assert(!next.mask_error);
  assert.equal(f.posts, 1); assert.equal(f.imageReads, 1); assert.equal(f.maskReads, 2);
});

test('trusted adapter reuses ledger with recorded output limits while default Moss reader retrieves it', async t => {
  const f = await fixture(t);
  const adapter = {
    maxPixels: 4500000,
    normalize(input) { return { ...normalizeInput({ ...input, width: 256, height: 256 }), backend: 'fixture', mode: 'edit', width: 2048, height: 2048 }; },
    compile(params, runId) { return { graph: { '90': { class_type: 'SaveImage', inputs: { filename_prefix: `moss_draw/${runId}/native` } } }, outputNode: '90' }; },
  };
  const r = await f.service(adapter).generate(req);
  assert.equal(f.record.output_node, '90'); assert.equal(f.record.max_pixels, 4500000);
  f.complete(); const done = await f.service().run({ run_id: r.run_id });
  assert.equal(done.status, 'succeeded'); assert.equal(done.artifact.width, 2048); assert.equal(done.params.backend, 'fixture');
  await assert.rejects(f.service().generate({ ...req, request_id: 'moss-large', width: 2048, height: 2048 }), { code: 'INVALID_INPUT' });
});

test('existing pre-mode t2i request hash remains idempotent after adding backend and mode metadata', async t => {
  const f = await fixture(t); const r = await f.service().generate(req);
  const requests = await readdir(path.join(f.dataRoot, 'requests')); const file = path.join(f.dataRoot, 'requests', requests.find(n => n.endsWith('.json')));
  const claim = JSON.parse(await readFile(file, 'utf8')); const legacy = { ...claim.params }; delete legacy.backend; delete legacy.mode;
  claim.input_hash = createHash('sha256').update(JSON.stringify(legacy)).digest('hex'); claim.params = legacy;
  await writeFile(file, JSON.stringify(claim));
  const runFile = path.join(f.dataRoot, 'runs', r.run_id, 'run.json'); const record = JSON.parse(await readFile(runFile, 'utf8')); record.params = legacy; delete record.output_node; await writeFile(runFile, JSON.stringify(record));
  const next = await f.service().generate({ ...req, mode: 't2i' }); assert.equal(next.run_id, r.run_id); assert.equal(f.posts, 1);
  assert.equal(next.params.backend, 'moss'); assert.equal(next.params.mode, 't2i');
});

test('characters has no uploads and retrieves only output11 with faithful compact/full context', async t => {
  const f = await fixture(t); const input = { ...req, mode: 'characters', width: 256, height: 256, characters: [{ prompt: 'A woman.' }] };
  const r = await f.service().generate(input); assert.equal(f.uploads.length, 0); assert.equal(f.record.output_node, '11'); f.complete();
  const done = await f.service().run({ run_id: r.run_id }); assert.equal(done.status, 'succeeded'); assert.equal(done.params.scheduler, 'simple'); assert.equal(done.params.slg, null);
  const ctx = await f.service().context({ run_id: r.run_id }); assert.equal(ctx.runs[0].context.characters[0].prompt, 'A woman.');
});
