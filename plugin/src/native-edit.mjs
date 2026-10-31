// Fixed Comfy 60aade0+ native MOSS Edit graph, not a MOSS_EDIT_MODEL adapter.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { STYLES, fault, strictObject, text, number, runId, parseLoras, loraPrefix } from './catalog.mjs';

const template = JSON.parse(readFileSync(new URL('../templates/moss-native-edit.json', import.meta.url), 'utf8'));
const MAX_PIXELS = 2100000;
const REFERENCE_EDGE = 512;
const STYLE_IDS = ['none'];
const INPUT_KEYS = ['backend', 'mode', 'request_id', 'prompt', 'negative', 'model', 'style', 'width', 'height', 'steps', 'cfg', 'shift', 'seed', 'lora_strength', 'loras', 'brief', 'checks', 'parent_run_id'];
const DERIVED_KEYS = ['model_variant', 'sampler', 'scheduler', 'slg', 'batch_size', 'reference_max_edge', 'reference_count', 'reference_sizes'];
const pick = (input, key, fallback) => Object.hasOwn(input, key) ? input[key] : fallback;
const invalid = message => { throw fault('INVALID_INPUT', message); };

function referenceSize(asset) {
  if (!asset || typeof asset !== 'object') invalid('Missing trusted reference metadata.');
  const source_width = number(asset.width, 'reference width', 1, 4096, true);
  const source_height = number(asset.height, 'reference height', 1, 4096, true);
  if (source_width * source_height > MAX_PIXELS) invalid('Reference exceeds the MOSS 2.1 MP limit.');
  const scale = Math.min(1, REFERENCE_EDGE / Math.max(source_width, source_height));
  // Downward alignment never upscales a normal reference; a sub-16 side needs
  // the minimum native latent cell. This branch does not set output dimensions.
  const width = Math.max(16, Math.floor(source_width * scale / 16) * 16);
  const height = Math.max(16, Math.floor(source_height * scale / 16) * 16);
  return Object.freeze({ source_width, source_height, width, height });
}
function normalize(input, safeAssets = []) {
  strictObject(input, INPUT_KEYS);
  if (pick(input, 'backend', 'moss') !== 'moss' || pick(input, 'mode', 'edit') !== 'edit' || pick(input, 'model', 'sft') !== 'sft') invalid('Native Edit requires backend moss, mode edit, model sft.');
  if (!Array.isArray(safeAssets) || safeAssets.length < 1 || safeAssets.length > 4) invalid('Native Edit requires one to four references.');
  const reference_sizes = Object.freeze(Array.from(safeAssets, referenceSize));
  const style = pick(input, 'style', 'none');
  if (!STYLE_IDS.includes(style) || !Object.hasOwn(STYLES, style)) invalid('Unsupported native Edit style.');
  const lora_strength = number(pick(input, 'lora_strength', style === 'none' ? 0 : 1), 'style strength', 0, 2);
  if (style === 'none' && lora_strength !== 0) invalid('Style none requires zero strength.');
  const loras = parseLoras(pick(input, 'loras', undefined));
  if (Object.hasOwn(input, 'width') !== Object.hasOwn(input, 'height')) invalid('Specify both output dimensions or neither.');
  const first = reference_sizes[0];
  const width = number(pick(input, 'width', first.source_width), 'width', 256, 2048, true);
  const height = number(pick(input, 'height', first.source_height), 'height', 256, 2048, true);
  if (width % 16 || height % 16 || width * height > MAX_PIXELS) invalid('Output must be 16-aligned and at most 2.1 MP; provide explicit supported dimensions.');
  const request_id = text(input.request_id, 'request_id', 128, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(request_id)) invalid('Invalid request_id.');
  const rawChecks = pick(input, 'checks', []);
  if (!Array.isArray(rawChecks) || rawChecks.length > 12) invalid('Invalid checks.');
  const checks = Object.freeze(Array.from(rawChecks, value => text(value, 'checks', 160, true)));
  return Object.freeze({ request_id, backend: 'moss', mode: 'edit', model: 'sft', model_variant: 'native-sft-edit',
    prompt: text(input.prompt, 'prompt', 12000, true), negative: text(pick(input, 'negative', ''), 'negative', 3000),
    style, lora_strength, ...(loras.length ? { loras } : {}), width, height,
    steps: number(pick(input, 'steps', 30), 'steps', 1, 100, true), cfg: number(pick(input, 'cfg', 4), 'cfg', 0, 20),
    shift: number(pick(input, 'shift', 5), 'shift', 0.1, 20),
    seed: number(pick(input, 'seed', randomBytes(6).readUIntBE(0, 6)), 'seed', 0, Number.MAX_SAFE_INTEGER, true),
    sampler: 'euler', scheduler: 'sgm_uniform', slg: null, batch_size: 1,
    reference_max_edge: REFERENCE_EDGE, reference_count: reference_sizes.length, reference_sizes,
    brief: text(pick(input, 'brief', ''), 'brief', 1000), checks,
    parent_run_id: Object.hasOwn(input, 'parent_run_id') ? runId(input.parent_run_id) : null });
}
function revalidate(params) {
  strictObject(params, [...INPUT_KEYS, ...DERIVED_KEYS]);
  if (!Array.isArray(params.reference_sizes) || params.reference_sizes.length < 1 || params.reference_sizes.length > 4) invalid('Invalid persisted reference sizes.');
  const assets = Array.from(params.reference_sizes, size => {
    strictObject(size, ['source_width', 'source_height', 'width', 'height']);
    return { width: size.source_width, height: size.source_height };
  });
  const input = Object.fromEntries(INPUT_KEYS.filter(key => Object.hasOwn(params, key) && !(key === 'parent_run_id' && params[key] === null)).map(key => [key, params[key]]));
  const normalized = normalize(input, assets);
  if (!isDeepStrictEqual(normalized, params)) invalid('Effective native Edit parameters do not match the fixed contract.');
  return normalized;
}
function uploadPath(uploaded, id, index) {
  strictObject(uploaded, ['name', 'subfolder', 'type']);
  if (uploaded.type !== 'input' || uploaded.subfolder !== '' || typeof uploaded.name !== 'string' || !['png', 'jpg', 'webp'].some(ext => uploaded.name === `moss-${id}-ref${index + 1}.${ext}`)) invalid('Uploaded reference identity or order does not match this run.');
  return uploaded.name;
}
function compile(params, id, uploaded = []) {
  runId(id); params = revalidate(params);
  if (!Array.isArray(uploaded) || uploaded.length !== params.reference_count) invalid('Uploaded reference count does not match this run.');
  const names = Array.from(uploaded, (item, i) => uploadPath(item, id, i));
  const graph = structuredClone(template);
  const style = STYLES[params.style];
  const entries = params.loras ?? [];
  const styled = params.style !== 'none' && params.lora_strength !== 0;
  let modelSource = '4';
  if (styled) {
    graph['5'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['4', 0], lora_name: style.file, strength_model: params.lora_strength } };
    modelSource = '5';
  }
  let inserted = 0;
  for (const entry of entries) {
    if (entry.strength === 0) continue;
    const key = String(100 + inserted);
    graph[key] = { class_type: 'LoraLoaderModelOnly', inputs: { model: [modelSource, 0], lora_name: entry.file, strength_model: entry.strength } };
    modelSource = key; inserted += 1;
  }
  graph['6'].inputs.model = [modelSource, 0];
  graph['6'].inputs.shift = params.shift;
  const prefix = [styled && style.trigger ? style.trigger : '', loraPrefix(entries)].filter(Boolean).join('\n');
  graph['7'].inputs.prompt = (prefix ? `${prefix}\n` : '') + params.prompt;
  graph['8'].inputs.prompt = params.negative;
  names.forEach((name, i) => {
    const load = String(20 + i * 2), scale = String(21 + i * 2), size = params.reference_sizes[i];
    graph[load] = { class_type: 'LoadImage', inputs: { image: name } };
    graph[scale] = { class_type: 'ImageScale', inputs: { image: [load, 0], upscale_method: 'lanczos', width: size.width, height: size.height, crop: 'disabled' } };
    // Comfy 60aade0 Autogrow.TemplatePrefix starts at zero, unlike Qwen21.
    for (const n of ['7', '8']) graph[n].inputs[`images.image_${i}`] = [scale, 0];
  });
  Object.assign(graph['9'].inputs, { width: params.width, height: params.height });
  Object.assign(graph['10'].inputs, { seed: params.seed, steps: params.steps, cfg: params.cfg });
  graph['12'].inputs.filename_prefix = `moss_draw/${id}/native`;
  return { graph, outputNode: '12' };
}
// Persisted params always carry the derived sampler/scheduler, so the caller
// guard lives here and never inside normalize/revalidate.
const normalizeCaller = (input, safeAssets = []) => {
  if (input && typeof input === 'object' && (Object.hasOwn(input, 'sampler') || Object.hasOwn(input, 'scheduler'))) invalid('Sampler and scheduler are moss t2i only; native Edit is fixed at sampler=none (implicit), scheduler=sgm_uniform. Drop both fields, or use mode t2i to test samplers.');
  return normalize(input, safeAssets);
};
export const NATIVE_EDIT_ADAPTER = Object.freeze({ normalize: normalizeCaller, compile, maxPixels: MAX_PIXELS });
export const NATIVE_EDIT_CATALOG = Object.freeze({
  id: 'edit', model_variant: 'native-sft-edit', required_core_commit: '60aade0bb0cbc298547fceb136cd195cea67800b',
  required_nodes: Object.freeze(['TextEncodeMOSSImageEdit', 'LoraLoaderModelOnly', 'ModelSamplingAuraFlow', 'ImageScale']),
  references: Object.freeze([1, 4]), styles: Object.freeze([...STYLE_IDS]),
  defaults: Object.freeze({ mode: 'edit', model: 'sft', style: 'none', steps: 30, cfg: 4, shift: 5, sampler: 'euler', scheduler: 'sgm_uniform', slg: null, reference_max_edge: 512, dimensions: 'exact_first_reference_or_explicit_pair' }),
  warning: 'Native sampling is not pixel-equivalent to legacy Diffusers Edit. No style LoRA ships in this portable package.',
});
