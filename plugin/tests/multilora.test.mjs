import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { parseLoras } from '../src/catalog.mjs';
import { normalizeInput, compileGraph } from '../src/core.mjs';
import { normalizeMode, compileMode } from '../src/modes.mjs';
import { K2_ADAPTER, QWEN_ADAPTER } from '../src/backends.mjs';
import { NATIVE_EDIT_ADAPTER } from '../src/native-edit.mjs';
import { normalizeRegions } from '../src/regions.mjs';
import { createWorkbenchStore } from '../src/workbench-store.mjs';
import { createWorkbenchModel } from '../client/model.mjs';
import { createWorkbenchView } from '../client/view.mjs';
import { DEFAULT_CAMERA } from '../src/workbench-camera.mjs';

const id = 'bba17a25-9c17-41f2-8614-9f57186c2c35';
const base = { request_id: 'multi-lora-1', prompt: 'One adult in a workshop.' };
const loras = [
  { file: 'moss/line.safetensors', strength: 0.8, trigger: 'artist:Line' },
  { file: 'detail/grain.safetensors', strength: 0.4, trigger: 'grain' },
];
const prefixed = 'artist:Line\ngrain\nOne adult in a workshop.';
function crc(b) { let c = 0xffffffff; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = c >>> 1 ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ 0xffffffff) >>> 0; }
function chunk(t, b) { const v = Buffer.concat([Buffer.from(t), b]), n = Buffer.alloc(4), c = Buffer.alloc(4); n.writeUInt32BE(b.length); c.writeUInt32BE(crc(v)); return Buffer.concat([n, v, c]); }
function png(w = 320, h = 256, alpha = () => 255) { const ih = Buffer.alloc(13); ih.writeUInt32BE(w); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6; const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = y * (w * 4 + 1) + x * 4 + 1; raw[p] = 20; raw[p + 1] = 30; raw[p + 2] = 40; raw[p + 3] = alpha(x, y); } return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); }
const asset = data => ({ data, mediaType: 'image/png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) });
const upload = (i = 1) => ({ name: `moss-${id}-ref${i}.png`, subfolder: '', type: 'input' });

test('parseLoras accepts an ordered list and rejects malformed entries', () => {
  const parsed = parseLoras(loras);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(x => x.file), ['moss/line.safetensors', 'detail/grain.safetensors']);
  assert.equal(parsed[0].strength, 0.8);
  assert.equal(parsed[1].trigger, 'grain');
  assert.deepEqual(parseLoras(undefined), []);
  for (const bad of [
    [{ file: 'x.ckpt' }], [{ file: '../x.safetensors' }], [{ file: '/abs.safetensors' }],
    [{ file: 'a.safetensors' }, { file: 'A.safetensors' }], [{ file: 'a.safetensors', strength: 3 }],
    [{ file: 'a.safetensors', trigger: 'x'.repeat(501) }], [{ file: 'a.safetensors', extra: 1 }],
    Array.from({ length: 5 }, (_, i) => ({ file: `a${i}.safetensors` })),
  ]) assert.throws(() => parseLoras(bad), { code: 'INVALID_INPUT' });
});

test('moss t2i stacks caller LoRAs from the base model in listed order', () => {
  const plain = normalizeInput({ ...base, style: 'none', lora_strength: 0, loras });
  const g = compileGraph(plain, id);
  assert.equal(g['100'].class_type, 'LoraLoaderModelOnly');
  assert.equal(g['100'].inputs.lora_name, 'moss/line.safetensors');
  assert.deepEqual(g['100'].inputs.model, ['1', 0]);
  assert.deepEqual(g['101'].inputs.model, ['100', 0]);
  assert.equal(g['101'].inputs.strength_model, 0.4);
  assert.deepEqual(g['5'].inputs.model, ['101', 0]);
  assert.equal(g['7'].inputs.text, prefixed);
  assert.deepEqual(plain.loras.map(x => x.file), ['moss/line.safetensors', 'detail/grain.safetensors']);
});

test('a zero-strength entry is skipped instead of breaking the chain', () => {
  const plain = normalizeInput({ ...base, style: 'none', lora_strength: 0, loras: [{ file: 'moss/line.safetensors', strength: 0 }] });
  const g = compileGraph(plain, id);
  assert.equal(g['100'], undefined);
  assert.deepEqual(g['5'].inputs.model, ['1', 0]);
  assert.equal(g['7'].inputs.text, 'One adult in a workshop.');
});

test('k2 stacks caller LoRAs from the base model', () => {
  const style = K2_ADAPTER.normalize({ ...base, backend: 'k2', mode: 't2i', model: 'krea2_turbo_fp8_scaled', style: 'none', lora_strength: 0, loras }, []);
  const g = K2_ADAPTER.compile(style, id, []).graph;
  assert.deepEqual(g['100'].inputs.model, ['1', 0]);
  assert.deepEqual(g['101'].inputs.model, ['100', 0]);
  assert.deepEqual(g['7'].inputs.model, ['101', 0]);
  assert.equal(g['4'].inputs.text, prefixed);
});

test('qwen rejects caller LoRAs instead of silently ignoring them', () => {
  const qwen = { backend: 'qwen', mode: 'edit', request_id: 'qwen-lora', prompt: 'Edit.', model: 'qwen_image_2.1_turbo_int8_convrot', style: 'none', lora_strength: 0, steps: 8, cfg: 1, loras };
  assert.throws(() => QWEN_ADAPTER.normalize(qwen, [asset(png(320, 256))]), { code: 'INVALID_INPUT' });
});

test('native edit stacks caller LoRAs after the fixed edit adapter LoRA', () => {
  const p = NATIVE_EDIT_ADAPTER.normalize({ ...base, backend: 'moss', mode: 'edit', model: 'sft', style: 'none', lora_strength: 0, loras }, [{ width: 768, height: 512 }]);
  const { graph: g } = NATIVE_EDIT_ADAPTER.compile(p, id, [upload(1)]);
  assert.equal(g['4'].inputs.lora_name, 'MOSS-Image-Edit-rank64.safetensors');
  assert.deepEqual(g['100'].inputs.model, ['4', 0]);
  assert.deepEqual(g['101'].inputs.model, ['100', 0]);
  assert.deepEqual(g['6'].inputs.model, ['101', 0]);
  assert.equal(g['7'].inputs.prompt, prefixed);
});

test('legacy edit chains caller LoRAs after the edit loader', () => {
  const p = normalizeMode({ ...base, mode: 'edit', style: 'none', lora_strength: 0, loras }, [{ width: 768, height: 512 }]);
  const { graph: g } = compileMode(p, id, [upload(1)]);
  assert.equal(g['1'].class_type, 'MossImageEditLoader');
  assert.deepEqual(g['100'].inputs.model, ['1', 0]);
  assert.deepEqual(g['101'].inputs.model, ['100', 0]);
  assert.deepEqual(g['3'].inputs.model, ['101', 0]);
  assert.equal(g['3'].inputs.prompt, prefixed);
});

test('inpaint chains caller LoRAs after DifferentialDiffusion', () => {
  const mask = png(320, 256, (x) => x < 160 ? 255 : 128);
  const p = normalizeMode({ ...base, mode: 'inpaint', negative: '', loras }, [asset(mask)]);
  const { graph: g } = compileMode(p, id, [upload(1)]);
  assert.deepEqual(g['100'].inputs.model, ['4', 0]);
  assert.deepEqual(g['101'].inputs.model, ['100', 0]);
  assert.deepEqual(g['40'].inputs.model, ['101', 0]);
  assert.equal(g['19'].inputs.value, prefixed);
});

test('characters chains caller LoRAs on the shared model', () => {
  const p = normalizeMode({ ...base, mode: 'characters', model: 'base', characters: [{ prompt: 'Woman in red.', style: 'none', lora_strength: 0 }], loras }, []);
  const { graph: g } = compileMode(p, id, []);
  assert.deepEqual(g['100'].inputs.model, ['1', 0]);
  assert.deepEqual(g['101'].inputs.model, ['100', 0]);
  assert.deepEqual(g['10'].inputs.model, ['101', 0]);
  assert.equal(g['10'].inputs.prompt, prefixed);
});

test('regions carry a per-region LoRA stack into the saved draft', () => {
  const draft = { request_id: 'region-loras', mode: 'regions', action: 'draft', prompt: 'Replace the character.', regions: [{ id: 'one', box: [16, 16, 240, 240], reference_index: 1, prompt: 'Use the character.', style: 'none', lora_strength: 0, loras }] };
  const normalized = normalizeRegions(draft, [asset(png(320, 256)), asset(png(256, 256))]);
  assert.deepEqual(normalized.regions[0].loras.map(x => x.file), ['moss/line.safetensors', 'detail/grain.safetensors']);
  assert.throws(() => normalizeRegions({ ...draft, regions: [{ ...draft.regions[0], loras: [{ file: 'bad.ckpt' }] }] }, [asset(png(320, 256)), asset(png(256, 256))]), { code: 'INVALID_INPUT' });
});

test('workbench store persists a region LoRA stack and rejects malformed entries', async t => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'multi-lora-wb-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = createWorkbenchStore({ dataRoot });
  const create = lorasValue => store.create({
    title: 'Multi LoRA workbench',
    canvas: { width: 640, height: 512, reference: 'base.png' },
    references: ['base.png', 'char.png'],
    prompt: 'Scene',
    regions: [{ id: 'person', box: [64, 64, 384, 448], reference_index: 1, prompt: 'One adult.', style: 'none', lora_strength: 0, loras: lorasValue }],
    camera: DEFAULT_CAMERA,
  });
  const doc = await create(loras);
  assert.deepEqual(doc.regions[0].loras.map(x => x.file), ['moss/line.safetensors', 'detail/grain.safetensors']);
  const reloaded = await store.get({ document_id: doc.document_id });
  assert.equal(reloaded.regions[0].loras[1].strength, 0.4);
  await assert.rejects(() => create([{ file: 'not-a-lora.ckpt' }]), { code: 'INVALID_INPUT' });
});

test('workbench view renders and edits a region LoRA stack', async t => {
  const doc = { document_id: id, revision: 1, title: 'LoRA view', canvas: { width: 512, height: 512, reference: 'base' }, references: ['base', 'person'], regions: [{ id: 'person', box: [64, 64, 384, 448], reference_index: 1, prompt: 'One adult.', style: 'none', lora_strength: 0, loras: [...loras] }], prompt: 'Scene', qwen_full_prompt: '', camera: DEFAULT_CAMERA, proposals: [] };
  const model = createWorkbenchModel({ request: async () => structuredClone(doc) });
  await model.open(id); model.select('person');
  const React = {
    Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(c => c !== null && c !== false && c !== undefined) }),
    useState: init => [typeof init === 'function' ? init() : init, () => {}], useRef: current => ({ current }), useEffect: () => {},
  };
  const View = createWorkbenchView(React);
  const root = View({ makeModel: () => model, useTabInfo: () => ({ tab: { signal: new AbortController().signal } }), sessionId: 'multi-lora-view' });
  const nodes = []; const walk = n => { if (n && typeof n === 'object') { nodes.push(n); n.children?.forEach(walk); } }; walk(root);
  assert(nodes.some(n => n.type === 'strong' && n.children?.includes('叠加 LoRA')), 'LoRA section must render');
  const fileInputs = nodes.filter(n => n.type === 'input' && n.props.value === 'moss/line.safetensors');
  assert.equal(fileInputs.length, 1, 'existing LoRA file row must render');
  const remove = nodes.find(n => n.type === 'button' && n.children?.includes('删除'));
  assert(remove, 'remove button must render');
  remove.props.onClick();
  assert.deepEqual(model.getSnapshot().draft.regions[0].loras.map(x => x.file), ['detail/grain.safetensors']);
  model.dispose();
});