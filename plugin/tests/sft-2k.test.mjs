import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { normalizeInput, compileGraph } from '../src/core.mjs';
import { catalog, LIMITS } from '../src/catalog.mjs';
import { createDrawingService } from '../src/dispatcher.mjs';
import { registerTools } from '../src/tools.mjs';
import { NATIVE_EDIT_ADAPTER } from '../src/native-edit.mjs';
import { compileMode } from '../src/modes.mjs';

const id = 'bba17a25-9c17-41f2-8614-9f57186c2c35';
const request = { request_id: 'sft-2k-test', prompt: 'One adult woman in a garden.', seed: 202610240240 };

for (const model of ['base', 'sft']) {
  test(`${model} t2i compiles style none without LoRA and keeps CFG3`, () => {
    const p = normalizeInput({ ...request, model, style: 'none' });
    const g = compileGraph(p, id);
    assert.equal(g['1'].inputs.unet_name, model === 'base' ? 'moss_image_base_int8_convrot.safetensors' : 'moss_image_sft_int8_convrot.safetensors');
    assert.equal(p.style, 'none'); assert.equal(p.lora_strength, 0);
    assert(!g['4'], 'portable package compiles no style LoRA node');
    assert.deepEqual(g['5'].inputs.model, ['1', 0]);
    assert.equal(g['7'].inputs.text, request.prompt);
    assert.equal(g['10'].inputs.cfg, 3);
    assert.equal(g['10'].inputs.steps, 50);
    assert.equal(g['10'].inputs.seed, 202610240240);
  });
}

test('catalog exposes the single none style while separating experimental mode quality', () => {
  const c = catalog();
  const entry = c.styles.find(s => s.id === 'none');
  assert.deepEqual(entry.models, ['base', 'sft']);
  assert.deepEqual(entry.characters_models, ['base', 'sft']);
  assert.equal(entry.trigger, '');
  assert.deepEqual(c.styles.map(s => s.id), ['none']);
  const t2i = c.modes.find(m => m.id === 't2i');
  assert.deepEqual(t2i.extra_sizes, [[2560, 1440]]);
  assert.equal(t2i.max_pixels, 3686400);
  assert.equal(c.defaults.model, 'base');
  assert.equal(c.defaults.style, 'none');
  assert.equal(c.defaults.cfg, 3);
  assert.equal(c.limits.pixels, 2100000, 'reference and non-t2i bounds remain unchanged');
});

for (const model of ['base', 'sft']) {
  test(`${model} accepts exact native 2560x1440 without upscale`, () => {
    const g = compileGraph(normalizeInput({ ...request, model, style: 'none', width: 2560, height: 1440 }), id);
    assert.deepEqual(g['9'].inputs, { width: 2560, height: 1440, batch_size: 1 });
    assert.deepEqual(g['12'].inputs.images, ['11', 0]);
    assert(!Object.values(g).some(n => ['ImageScale', 'LoadImage'].includes(n.class_type)));
  });
}

test('2K exception preserves old sizes and rejects adjacent oversized or non-integer canvases', () => {
  for (const [width, height] of [[1024, 1536], [1792, 1008], [2048, 1024], [1152, 1728]]) {
    const p = normalizeInput({ ...request, width, height });
    assert.equal(p.width, width); assert.equal(p.height, height);
  }
  for (const [width, height] of [[2560, 1424], [2560, 1456], [2544, 1440], [1440, 2560], [2560, 256], [2048, 1536], [1025, 1536], [2560.5, 1440], ['2560', 1440]]) {
    assert.throws(() => normalizeInput({ ...request, width, height }), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => normalizeInput({ ...request, model: 'unknown' }), { code: 'INVALID_INPUT' });
  assert.throws(() => normalizeInput({ ...request, style: 'unknown' }), { code: 'INVALID_INPUT' });
});

test('RS and native Edit accept style none without adding a style LoRA', () => {
  const p = normalizeInput({ ...request, mode: 'characters', model: 'sft', cfg: 3, characters: [{ prompt: 'One adult.', style: 'none' }] });
  const { graph: g } = compileMode(p, id);
  assert.equal(g['1'].inputs.unet_name, 'moss_image_sft_int8_convrot.safetensors');
  assert.equal(g['7'].inputs.character1_lora, 'None');
  assert.equal(g['4'].inputs.value, 'One adult.');
  assert.equal(g['10'].inputs.cfg, 3);
  assert.equal(g['10'].inputs.scheduler, 'simple');
  const e = NATIVE_EDIT_ADAPTER.normalize({ ...request, mode: 'edit', model: 'sft', style: 'none', cfg: 3 }, [{ width: 512, height: 512 }]);
  const { graph: ng } = NATIVE_EDIT_ADAPTER.compile(e, id, [{ name: `moss-${id}-ref1.png`, subfolder: '', type: 'input' }]);
  assert.equal(ng['1'].inputs.unet_name, 'moss_image_sft_int8_convrot.safetensors');
  assert.equal(ng['4'].inputs.lora_name, 'MOSS-Image-Edit-rank64.safetensors');
  assert(!ng['5'], 'no style LoRA node after the edit adapter');
  assert.equal(ng['7'].inputs.prompt, request.prompt);
  assert.equal(ng['10'].inputs.cfg, 3);
});

test('t2i 2K exception does not change non-t2i canvas and reference contracts', () => {
  assert.throws(() => normalizeInput({ ...request, mode: 'characters', model: 'base', width: 2560, height: 1440, characters: [{ prompt: 'One adult.', style: 'none' }] }), { code: 'INVALID_INPUT' });
  assert.throws(() => NATIVE_EDIT_ADAPTER.normalize({ ...request, mode: 'edit', width: 2560, height: 1440 }, [{ width: 512, height: 512 }]), { code: 'INVALID_INPUT' });
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) { c ^= b; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), crc = Buffer.alloc(4);
  size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([size, body, crc]);
}
function png(width, height) {
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t, width = 2560, height = 1440) {
  const prefix = path.join(tmpdir(), 'moss-sft-2k-');
  const dataRoot = await mkdtemp(prefix);
  t.after(async () => { assert(dataRoot.startsWith(prefix)); await rm(dataRoot, { recursive: true, force: true }); });
  const bytes = png(width, height); let posts = 0, payload, record;
  const config = { dataRoot, workspaceRoot: dataRoot, comfyUrl: 'http://fixture.invalid', fetchImpl: async (url, options) => {
    const route = new URL(url).pathname;
    if (route === '/prompt') {
      posts++; payload = JSON.parse(options.body);
      record = JSON.parse(await readFile(path.join(dataRoot, 'runs', payload.extra_data.moss_run_id, 'run.json'), 'utf8'));
      return Response.json({ prompt_id: 'sft-test', node_errors: {} });
    }
    if (route === '/queue') return Response.json({ queue_running: [], queue_pending: [] });
    if (route === '/history/sft-test') return Response.json({ 'sft-test': {
      prompt: [1, 'sft-test', payload.prompt, { ...payload.extra_data, client_id: payload.client_id }, ['12']],
      status: { status_str: 'success', completed: true, messages: [] },
      outputs: { '12': { images: [{ filename: 'native_00001_.png', subfolder: `moss_draw/${record.run_id}`, type: 'output' }] } },
    } });
    if (route === '/view') return new Response(bytes);
    throw Error('Unexpected fixture request: ' + route);
  } };
  return { config, bytes, service: () => createDrawingService(config), get posts() { return posts; }, get record() { return record; }, get graph() { return payload?.prompt; } };
}

test('native tool style-none/SFT/2K survives collection, restart, viewing and byte-exact delivery', async t => {
  const f = await fixture(t), definitions = new Map(), saved = [];
  const service = f.service();
  const attachments = {
    async saveImage(input) { saved.push(input); return { id: 'test-preview', mediaType: 'image/png', width: 2560, height: 1440 }; },
    async saveFile(input) { saved.push(input); return { id: 'test-file', name: input.name }; },
  };
  registerTools({ tools: { register: d => definitions.set(d.name, d) } }, {
    sdk: { tools: { defineTool: d => d } }, service, readGuide: async () => ({}), config: f.config, attachments,
  });
  const exec = { agent: { session: { deriveMessages: () => [] } }, signal: new AbortController().signal };
  const input = { ...request, backend: 'moss', mode: 't2i', model: 'sft', style: 'none', width: 2560, height: 1440, cfg: 3 };
  const queued = await definitions.get('art_generate').execute(input, exec);
  assert.equal(queued.status, 'queued'); assert.equal(f.posts, 1);
  assert.equal(f.record.max_pixels, 3686400, '2K collection limit persisted before submission');
  assert.equal(f.graph['1'].inputs.unet_name, 'moss_image_sft_int8_convrot.safetensors');
  assert(!f.graph['4'], 'portable 2K t2i compiles no style LoRA'); assert.equal(f.graph['10'].inputs.cfg, 3);
  const restored = f.service();
  const complete = await restored.run({ run_id: queued.run_id });
  assert.equal(complete.status, 'succeeded', JSON.stringify(complete.error));
  assert.equal(complete.artifact.width, 2560); assert.equal(complete.artifact.height, 1440);
  assert.deepEqual(await readFile(complete.artifact.path), f.bytes);
  const retry = await restored.generate(input); assert.equal(retry.run_id, queued.run_id); assert.equal(f.posts, 1);
  const view = await definitions.get('art_view').execute({ run_id: queued.run_id }, exec);
  const delivery = await definitions.get('art_deliver').execute({ run_id: queued.run_id }, exec);
  const digest = createHash('sha256').update(f.bytes).digest('hex');
  assert.equal(view.sha256, digest); assert.equal(delivery.sha256, digest);
  assert(saved.every(s => s.data.equals(f.bytes)));
  assert.equal(f.posts, 1, 'view/delivery/idempotency cannot generate another image');
});

test('native art_generate accepts a style-none region draft without submitting inference', async t => {
  const f = await fixture(t, 256, 256), definitions = new Map();
  const reference = path.join(f.config.dataRoot, 'reference.png'); await writeFile(reference, f.bytes);
  registerTools({ tools: { register: d => definitions.set(d.name, d) } }, {
    sdk: { tools: { defineTool: d => d } }, service: f.service(), readGuide: async () => ({}), config: f.config,
    attachments: { async saveImage() { return { id: 'test-reference', width: 256, height: 256 }; } },
  });
  const exec = { agent: { session: { deriveMessages: () => [{ source: { kind: 'user' }, content: [{ type: 'text', text: `Use @"${reference}"` }] }] } }, signal: new AbortController().signal };
  const result = await definitions.get('art_generate').execute({ request_id: request.request_id, prompt: request.prompt, mode: 'regions', action: 'draft', references: [reference, reference], regions: [{ id: 'person', box: [0, 0, 128, 256], reference_index: 1, prompt: 'One adult.', style: 'none', lora_strength: 0, cfg: 3, seed: request.seed }] }, exec);
  assert.equal(result.status, 'draft'); assert.equal(f.posts, 0);
});

test('ordinary t2i keeps the original persisted image limit', async t => {
  const f = await fixture(t, 1024, 1536);
  const run = await f.service().generate({ ...request, width: 1024, height: 1536 });
  assert.equal(f.record.max_pixels, 2100000);
  assert.equal((await f.service().run({ run_id: run.run_id })).status, 'succeeded');
  assert.equal(LIMITS.pixels, 2100000);
});
