import test from 'node:test';
import assert from 'node:assert/strict';

// Import failures become explicit feature assertions during the initial RED run.
const core = await import('../src/core.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
const api = () => {
  assert.equal(typeof core.normalizeInput, 'function', 'normalizeInput must exist');
  assert.equal(typeof core.compileGraph, 'function', 'compileGraph must exist');
  return core;
};
const id = 'bba17a25-9c17-41f2-8614-9f57186c2c35';
const input = { request_id: 'req-1', prompt: 'An airy ink drawing of a woman.' };

test('compiler uses final native MOSS defaults without style LoRA or image conditioning', () => {
  const { normalizeInput, compileGraph } = api();
  const p = normalizeInput(input);
  const g = compileGraph(p, id);
  // Portable package: STYLES only contains none, so node 4 (LoraLoaderModelOnly)
  // does not exist and the sampling chain stays on the raw UNET loader.
  assert.deepEqual(Object.keys(g), ['1', '2', '3', '5', '6', '7', '8', '9', '10', '11', '12']);
  assert.equal(p.style, 'none');
  assert.equal(p.lora_strength, 0);
  assert(!g['4'], 'no style LoRA node is compiled');
  assert.deepEqual(g['10'].inputs, { model: ['6', 0], positive: ['7', 0], negative: ['8', 0], latent_image: ['9', 0], seed: p.seed, steps: 50, cfg: 3, sampler_name: 'euler', scheduler: 'sgm_uniform', denoise: 1 });
  assert.equal(g['1'].inputs.unet_name, 'moss_image_base_int8_convrot.safetensors');
  assert.equal(g['2'].inputs.clip_name, 'qwen3.5_9b_w4a8_gptq.safetensors');
  assert.equal(g['3'].inputs.vae_name, 'flux2-vae_small.safetensors');
  assert.deepEqual(g['5'].inputs.model, ['1', 0]);
  assert.equal(g['5'].inputs.shift, 5);
  assert.equal(g['6'].inputs.single_layers, '22');
  assert.equal(g['7'].inputs.text, input.prompt);
  assert.deepEqual(g['9'].inputs, { width: 1024, height: 1536, batch_size: 1 });
  assert.deepEqual(g['12'].inputs.images, ['11', 0]);
  assert.equal(g['12'].inputs.filename_prefix, `moss_draw/${id}/native`);
  assert.equal(p.prompt, input.prompt);
  assert(Object.isFrozen(p));
  assert(Object.isFrozen(p.checks));
  assert(Number.isSafeInteger(p.seed));
});

test('explicit parameters and exact prompt remain intact; no style trigger is prepended', () => {
  const { normalizeInput, compileGraph } = api();
  const raw = { ...input, style: 'none', prompt: '  prompt\ntext ', negative: 'blur', width: 1536, height: 864, seed: 0, steps: 60, cfg: 4.5, shift: 6, lora_strength: 0, brief: 'brief', checks: ['one subject'] };
  const p = normalizeInput(raw);
  assert.equal(p.prompt, raw.prompt);
  assert.deepEqual(p.checks, ['one subject']);
  const g = compileGraph(p, id);
  assert.equal(g['7'].inputs.text, raw.prompt);
  assert.equal(g['8'].inputs.text, 'blur');
  assert(!g['4'], 'style none compiles no LoRA loader');
  for (const key of ['seed', 'steps', 'cfg']) assert.equal(g['10'].inputs[key], raw[key]);
  assert.equal(g['5'].inputs.shift, 6);
});

test('style is none-only: SFT compiles without a LoRA and any other style is rejected', () => {
  const { normalizeInput, compileGraph, catalog } = api();
  const g = compileGraph(normalizeInput({ ...input, model: 'sft', style: 'none' }), id);
  assert.equal(g['1'].inputs.unet_name, 'moss_image_sft_int8_convrot.safetensors');
  assert(!g['4']);
  assert.deepEqual(g['5'].inputs.model, ['1', 0]);
  assert.equal(g['7'].inputs.text, input.prompt);
  // The portable catalog ships exactly one style; any other id is an invalid
  // style, never a normal path. The two rejected ids stay generic on purpose.
  assert.deepEqual(catalog().styles.map(style => style.id), ['none']);
  assert.equal(catalog().defaults.style, 'none');
  assert.equal(catalog().defaults.lora_strength, 0);
  for (const style of ['unknown-style', 'legacy-style']) {
    assert.throws(() => normalizeInput({ ...input, model: 'sft', style }), { code: 'INVALID_INPUT' }, style);
  }
});

test('input whitelist rejects arbitrary graph, image, URL, path and shell fields', () => {
  const { normalizeInput, compileGraph } = api();
  for (const key of ['image', 'mask', 'url', 'comfyUrl', 'shell', 'graph', 'workflow', 'path', 'out_dir', 'sampler', 'scheduler', 'batch_size', '__proto__']) {
    const raw = JSON.parse(JSON.stringify(input));
    Object.defineProperty(raw, key, { value: 'bad', enumerable: true });
    assert.throws(() => normalizeInput(raw), { code: 'INVALID_INPUT' }, key);
  }
  assert.throws(() => compileGraph(normalizeInput(input), '../escape'), { code: 'INVALID_INPUT' });
});

test('compileGraph validates effective parameters even when called directly', () => {
  const { normalizeInput, compileGraph } = api();
  const p = normalizeInput(input);
  // Sampler/scheduler are caller-selectable now, so the rejected values here are
  // names the worker's KSampler does not have, plus the fields that stay fixed.
  for (const patch of [{ width: 17 }, { sampler: 'euler_ancestral_v2' }, { scheduler: 'sgm_uniform2' }, { model: 'unknown' }, { slg: '3' }, { batch_size: 2 }, { graph: {} }]) {
    assert.throws(() => compileGraph({ ...p, ...patch }, id), undefined, JSON.stringify(patch));
  }
});

test('strict bounds and types reject coercion, invalid enums, identifiers and overlong context', () => {
  const { normalizeInput } = api();
  for (const patch of [
    { request_id: '../x' }, { request_id: '' }, { prompt: '   ' }, { prompt: 'x'.repeat(12001) },
    { style: 'unknown-style' }, { model: '../../model' }, { style: ['none'] }, { model: ['base'] }, { width: 1025 }, { width: '1024' },
    { width: 2048, height: 1536 }, { height: 0 }, { seed: -1 }, { seed: Number.MAX_SAFE_INTEGER + 1 },
    { seed: 1.5 }, { steps: 0 }, { steps: 101 }, { cfg: Infinity }, { cfg: -1 },
    { shift: NaN }, { lora_strength: 3 }, { negative: null }, { brief: 'x'.repeat(1001) },
    { checks: 'not an array' }, { checks: Array(13).fill('x') }, { checks: ['x'.repeat(161)] },
    { parent_run_id: '../escape' }, { style: 'none', lora_strength: 1 },
  ]) assert.throws(() => normalizeInput({ ...input, ...patch }), { code: 'INVALID_INPUT' }, JSON.stringify(patch));
});
