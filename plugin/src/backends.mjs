// Pure fixed adapters: no networking, uploads, provider processes or caller graphs.
// Provenance and acceptance boundaries: ../docs/k2-qwen-research.md.
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fault, strictObject, text, number, strings, runId, parseLoras, loraPrefix } from './catalog.mjs';

const templates = Object.fromEntries(['k2-t2i', 'qwen-edit'].map(name => [name, JSON.parse(readFileSync(new URL(`../templates/${name}.json`, import.meta.url), 'utf8'))]));
const INPUT_KEYS = ['backend', 'mode', 'request_id', 'prompt', 'negative', 'model', 'style', 'width', 'height', 'steps', 'cfg', 'seed', 'lora_strength', 'loras', 'brief', 'checks', 'parent_run_id'];
const DERIVED_KEYS = ['sampler', 'scheduler', 'shift', 'slg', 'batch_size', 'reference_count'];
const K2_PIXELS = 2560 * 1536;
const QWEN_PIXELS = 4500000;
const K2_MODEL = 'krea2_turbo_fp8_scaled';
const QWEN_MODEL = 'qwen_image_2.1_turbo_int8_convrot';
const pick = (input, key, fallback) => Object.hasOwn(input, key) ? input[key] : fallback;
const invalid = message => { throw fault('INVALID_INPUT', message); };
const requireValue = (input, key, expected) => { if (pick(input, key, expected) !== expected) invalid(`Unsupported ${key} for this backend.`); };

function common(input, backend, mode) {
  strictObject(input, INPUT_KEYS);
  requireValue(input, 'backend', backend); requireValue(input, 'mode', mode);
  const request_id = text(input.request_id, 'request_id', 128, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(request_id)) invalid('Invalid request_id.');
  return {
    backend, mode, request_id, prompt: text(input.prompt, 'prompt', 12000, true),
    negative: text(pick(input, 'negative', ''), 'negative', 3000),
    seed: number(pick(input, 'seed', randomBytes(6).readUIntBE(0, 6)), 'seed', 0, Number.MAX_SAFE_INTEGER, true),
    brief: text(pick(input, 'brief', ''), 'brief', 1000),
    checks: Object.freeze(strings(pick(input, 'checks', []), 'checks', 12, 160)),
    parent_run_id: Object.hasOwn(input, 'parent_run_id') ? runId(input.parent_run_id) : null,
  };
}
function dimensions(width, height, grid, maxSide, maxPixels) {
  width = number(width, 'width', 256, maxSide, true); height = number(height, 'height', 256, maxSide, true);
  if (width % grid || height % grid || width * height > maxPixels) invalid('Unsupported output dimensions; provide an explicit supported canvas.');
  return { width, height };
}
function normalizeK2(input, assets = []) {
  const base = common(input, 'k2', 't2i');
  if (!Array.isArray(assets) || assets.length) invalid('K2 text-to-image takes no references.');
  requireValue(input, 'model', K2_MODEL); requireValue(input, 'cfg', 1);
  const style = pick(input, 'style', 'none');
  if (style !== 'none') invalid('This portable package ships no K2 LoRA; use style none.');
  const lora_strength = number(pick(input, 'lora_strength', 0), 'LoRA strength', 0, 2);
  if (lora_strength !== 0) invalid('This portable package ships no K2 LoRA; use lora_strength 0.');
  const loras = parseLoras(pick(input, 'loras', undefined));
  const size = dimensions(pick(input, 'width', 1024), pick(input, 'height', 1536), 32, 2560, K2_PIXELS);
  const legacy = size.width <= 2048 && size.height <= 2048 && size.width % 64 === 0 && size.height % 64 === 0 && size.width * size.height <= 2097152;
  if (!legacy && ![[2048,1536],[2560,1440],[2560,1536]].some(([w,h]) => w === size.width && h === size.height)) invalid('K2 canvas is outside the established generation contract.');
  return Object.freeze({ ...base, ...size, model: K2_MODEL, style, lora_strength, ...(loras.length ? { loras } : {}),
    steps: number(pick(input, 'steps', 8), 'steps', 8, 20, true), cfg: 1,
    sampler: 'euler', scheduler: 'simple', shift: null, slg: null, batch_size: 1, reference_count: 0 });
}
function normalizeQwen(input, assets = []) {
  const base = common(input, 'qwen', 'edit');
  if (!Array.isArray(assets) || assets.length < 1 || assets.length > 2) invalid('Qwen edit requires one or two references.');
  requireValue(input, 'model', QWEN_MODEL); requireValue(input, 'style', 'none');
  requireValue(input, 'lora_strength', 0); requireValue(input, 'steps', 8); requireValue(input, 'cfg', 1);
  if (Object.hasOwn(input, 'loras')) invalid('Qwen Edit has no LoRA path; use backend moss or k2.');
  if (base.negative !== '') invalid('This fixed Qwen EditPlus workflow has no negative prompt control.');
  if (Object.hasOwn(input, 'width') !== Object.hasOwn(input, 'height')) invalid('Specify both width and height or neither.');
  // Preserve the first canvas exactly by default. Never silently choose a ratio,
  // enlarge to 2K, round dimensions, crop, or square a post-processing request.
  const size = dimensions(pick(input, 'width', assets[0]?.width), pick(input, 'height', assets[0]?.height), 32, 4096, QWEN_PIXELS);
  return Object.freeze({ ...base, ...size, model: QWEN_MODEL, style: 'none', lora_strength: 0,
    steps: 8, cfg: 1, sampler: 'euler', scheduler: 'manual_sigmas', shift: null, slg: null,
    batch_size: 1, reference_count: assets.length });
}
function revalidate(params, normalize) {
  strictObject(params, [...INPUT_KEYS, ...DERIVED_KEYS]);
  const count = number(params.reference_count, 'reference count', 0, 2, true);
  const input = Object.fromEntries(INPUT_KEYS.filter(k => Object.hasOwn(params, k) && !(k === 'parent_run_id' && params[k] === null)).map(k => [k, params[k]]));
  const result = normalize(input, Array.from({ length: count }, () => ({ width: params.width, height: params.height })));
  if (!isDeepStrictEqual(result, params)) invalid('Effective parameters do not match the fixed backend contract.');
  return result;
}
function uploadedNames(uploaded, id, count) {
  if (!Array.isArray(uploaded) || uploaded.length !== count) invalid('Uploaded reference count does not match the request.');
  return uploaded.map((item, i) => {
    strictObject(item, ['name', 'subfolder', 'type']);
    if (item.type !== 'input' || item.subfolder !== '' || typeof item.name !== 'string' || !['png', 'jpg', 'webp'].some(ext => item.name === `moss-${id}-ref${i + 1}.${ext}`)) invalid('Invalid uploaded reference identity or order.');
    return item.name;
  });
}
function compileK2(params, id, uploaded = []) {
  runId(id); params = revalidate(params, normalizeK2); uploadedNames(uploaded, id, 0);
  const graph = structuredClone(templates['k2-t2i']);
  const entries = params.loras ?? [];
  let modelSource = '1';
  let inserted = 0;
  for (const entry of entries) {
    if (entry.strength === 0) continue;
    const key = String(100 + inserted);
    graph[key] = { class_type: 'LoraLoaderModelOnly', inputs: { model: [modelSource, 0], lora_name: entry.file, strength_model: entry.strength } };
    modelSource = key; inserted += 1;
  }
  const prefix = loraPrefix(entries);
  graph['4'].inputs.text = (prefix ? `${prefix}\n` : '') + params.prompt;
  if (params.negative) graph['5'] = { class_type: 'CLIPTextEncode', inputs: { clip: ['2', 0], text: params.negative } };
  Object.assign(graph['6'].inputs, { width: params.width, height: params.height });
  Object.assign(graph['7'].inputs, { seed: params.seed, steps: params.steps });
  graph['7'].inputs.model = [modelSource, 0];
  graph['9'].inputs.filename_prefix = `moss_draw/${id}/native`;
  return { graph, outputNode: '9' };
}
function compileQwen(params, id, uploaded = []) {
  runId(id); params = revalidate(params, normalizeQwen);
  const names = uploadedNames(uploaded, id, params.reference_count);
  const graph = structuredClone(templates['qwen-edit']);
  graph['4'].inputs.image = names[0];
  if (names.length === 2) graph['5'].inputs.image = names[1];
  else { delete graph['5']; delete graph['6'].inputs.image2; }
  graph['6'].inputs.prompt = params.prompt;
  Object.assign(graph['8'].inputs, { width: params.width, height: params.height });
  graph['11'].inputs.noise_seed = params.seed;
  graph['13'].inputs.filename_prefix = `moss_draw/${id}/native`;
  return { graph, outputNode: '13' };
}
export const K2_ADAPTER = Object.freeze({ normalize: normalizeK2, compile: compileK2, maxPixels: K2_PIXELS });
export const QWEN_ADAPTER = Object.freeze({ normalize: normalizeQwen, compile: compileQwen, maxPixels: QWEN_PIXELS });
const deepFreeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
};
export const BACKEND_CATALOG = deepFreeze([
  { id: 'k2', modes: ['t2i'], defaults: { mode: 't2i', model: K2_MODEL, style: 'none', lora_strength: 0, width: 1024, height: 1536, steps: 8, cfg: 1, sampler: 'euler', scheduler: 'simple' },
    limits: { pixels: K2_PIXELS, references: [0,0], steps: [8,20], dimension_multiple: 64, large_landscapes: [[2048,1536],[2560,1440],[2560,1536]] },
    styles: [{ id: 'none', trigger: '', strength: 0 }] },
  { id: 'qwen', modes: ['edit'], defaults: { mode: 'edit', model: QWEN_MODEL, style: 'none', width: null, height: null, dimensions: 'inherit_first_reference_exactly', steps: 8, cfg: 1, sampler: 'euler', scheduler: 'manual_sigmas' },
    limits: { pixels: QWEN_PIXELS, references: [1,2], dimension_min: 256, dimension_max: 4096, dimension_multiple: 32 },
    styles: [{ id: 'none', trigger: '', strength: 0 }], warning: 'Whole-image edit: no exterior pixel lock or transparent-background guarantee.' },
]);
