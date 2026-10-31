import { readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { MODELS, STYLES, LIMITS, fault, strictObject, text, number, strings, runId, parseLoras, loraPrefix } from './catalog.mjs';
import { validatePng } from './comfy.mjs';
import { compileGraph } from './core.mjs';

const templates = Object.fromEntries(['edit-single', 'edit-multi', 'inpaint', 'characters'].map(name => [name, JSON.parse(readFileSync(new URL(`../templates/${name}.json`, import.meta.url), 'utf8'))]));
const pick = (input, key, fallback) => Object.hasOwn(input, key) ? input[key] : fallback;
const invalid = message => { throw fault('INVALID_INPUT', message); };
export const INPUT_KEYS = ['request_id', 'prompt', 'negative', 'style', 'model', 'width', 'height', 'steps', 'cfg', 'shift', 'seed', 'sampler', 'scheduler', 'lora_strength', 'loras', 'brief', 'checks', 'parent_run_id', 'mode', 'characters'];
export const extension = mediaType => ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[mediaType];

function imageDimensions(data, mediaType) {
  if (mediaType === 'image/png') {
    if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) invalid('Invalid PNG reference.');
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (mediaType === 'image/jpeg') {
    if (data[0] !== 255 || data[1] !== 216 || data.at(-2) !== 255 || data.at(-1) !== 217) invalid('Invalid JPEG reference.');
    let offset = 2;
    while (offset + 4 <= data.length) {
      if (data[offset++] !== 255) invalid('Invalid JPEG marker.');
      while (data[offset] === 255) offset++;
      const marker = data[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      const size = data.readUInt16BE(offset);
      if (size < 2 || offset + size > data.length) invalid('Invalid JPEG length.');
      if ([0xc0, 0xc1, 0xc2].includes(marker)) {
        if (size < 8) invalid('Invalid JPEG dimensions.');
        return { width: data.readUInt16BE(offset + 5), height: data.readUInt16BE(offset + 3) };
      }
      offset += size;
    }
    invalid('Unsupported JPEG reference.');
  }
  if (mediaType === 'image/webp') {
    if (data.length < 30 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WEBP' || data.readUInt32LE(4) + 8 !== data.length) invalid('Invalid WebP reference.');
    const type = data.toString('ascii', 12, 16);
    if (type === 'VP8X') {
      if (data[20] & 2) invalid('Animated references are not supported.');
      return { width: 1 + data.readUIntLE(24, 3), height: 1 + data.readUIntLE(27, 3) };
    }
    if (type === 'VP8 ' && data.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) return { width: data.readUInt16LE(26) & 0x3fff, height: data.readUInt16LE(28) & 0x3fff };
    if (type === 'VP8L' && data[20] === 0x2f) {
      const bits = data.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    invalid('Unsupported WebP reference.');
  }
  invalid('Reference must be PNG, JPEG or WebP.');
}
// Host has decoded visible image attachments; core independently checks the
// immutable bytes/signature/dimensions and performs full PNG validation.
export function validateAssets(assets, maxPixels = LIMITS.pixels) {
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 4500000) invalid('Invalid trusted pixel limit.');
  if (!Array.isArray(assets) || assets.length > 4) invalid('At most four reference images are allowed.');
  return assets.map(asset => {
    strictObject(asset, ['data', 'mediaType', 'width', 'height']);
    if (!Buffer.isBuffer(asset.data) || !asset.data.length || asset.data.length > LIMITS.png_bytes || !extension(asset.mediaType)) invalid('Invalid reference bytes or media type.');
    const data = Buffer.from(asset.data);
    const width = number(asset.width, 'reference width', 1, 4096, true), height = number(asset.height, 'reference height', 1, 4096, true);
    if (width * height > maxPixels) invalid('Reference exceeds the backend pixel limit.');
    const dimensions = imageDimensions(data, asset.mediaType);
    if (dimensions.width !== width || dimensions.height !== height) invalid('Reference metadata does not match bytes.');
    if (asset.mediaType === 'image/png') {
      try { validatePng(data, { width, height }, { maxPixels }); } catch { invalid('Invalid reference PNG.'); }
    }
    return { data, mediaType: asset.mediaType, width, height, sha256: createHash('sha256').update(data).digest('hex') };
  });
}
function styleId(value, model) {
  if (typeof value !== 'string' || !Object.hasOwn(STYLES, value)) invalid('Unknown style.');
  if (!STYLES[value].models.includes(model)) throw fault('MODEL_STYLE_MISMATCH', 'This style does not support the selected model.');
  return value;
}
function maskCheck(asset) {
  if (asset.mediaType !== 'image/png') invalid('Inpaint requires one RGBA PNG.');
  const decoded = validatePng(asset.data, asset, { pixels: true });
  if (decoded.channels !== 4) invalid('Inpaint requires an alpha mask.');
  let edit = false, keep = false;
  for (let i = 3; i < decoded.pixels.length; i += 4) { edit ||= decoded.pixels[i] < 255; keep ||= decoded.pixels[i] === 255; }
  if (!edit || !keep) invalid('Mask must contain both editable and preserved pixels.');
}
export function normalizeMode(input, assets) {
  strictObject(input, INPUT_KEYS);
  const mode = input.mode;
  if (!['edit', 'inpaint', 'characters'].includes(mode)) invalid('Unknown mode.');
  if (mode === 'edit' && (assets.length < 1 || assets.length > 4)) invalid('Edit requires one to four references.');
  if (mode === 'inpaint' && assets.length !== 1) invalid('Inpaint requires exactly one reference.');
  if (mode === 'characters' && assets.length) invalid('Characters mode cannot use image references.');
  if (mode !== 'characters' && Object.hasOwn(input, 'characters')) invalid('Characters are not supported in this mode.');
  // Sampler choice is a t2i-only control. Naming each mode's real fixed pair
  // keeps the rejection actionable instead of "Unsupported input field".
  if (Object.hasOwn(input, 'sampler') || Object.hasOwn(input, 'scheduler')) {
    const fixed = { edit: ['none (the native Edit sampler is implicit)', 'MOSSImageScheduler'], inpaint: ['er_sde', 'simple'], characters: ['euler', 'simple'] }[mode];
    invalid(`Sampler and scheduler are moss t2i only; ${mode} is fixed at sampler=${fixed[0]}, scheduler=${fixed[1]}. Drop both fields, or use mode t2i to test samplers.`);
  }
  const model = pick(input, 'model', 'sft');
  if (typeof model !== 'string' || !Object.hasOwn(MODELS, model) || (mode !== 'characters' && model !== 'sft')) invalid('This mode requires model sft.');
  const style = pick(input, 'style', 'none');
  if (typeof style !== 'string' || !Object.hasOwn(STYLES, style)) invalid('Unknown style.');
  const lora_strength = number(pick(input, 'lora_strength', style === 'none' ? 0 : 1), 'style strength', 0, 2);
  if ((style === 'none' && lora_strength !== 0) || (mode !== 'edit' && (style !== 'none' || lora_strength !== 0))) invalid('Only style none with zero strength is supported in these modes.');
  const loras = parseLoras(pick(input, 'loras', undefined));
  if (mode !== 'edit' && Object.hasOwn(input, 'shift')) invalid('This template has no shift control.');
  let width, height;
  if (mode === 'inpaint') {
    maskCheck(assets[0]); width = assets[0].width; height = assets[0].height;
    if (pick(input, 'width', width) !== width || pick(input, 'height', height) !== height) invalid('Inpaint preserves original image dimensions.');
  } else {
    const first = assets[0];
    const scale = first ? Math.min(1, 2048 / first.width, 2048 / first.height, Math.sqrt(LIMITS.pixels / (first.width * first.height))) : 1;
    width = number(pick(input, 'width', first ? Math.max(256, Math.floor(first.width * scale / 16) * 16) : 1024), 'width', 256, 2048, true);
    height = number(pick(input, 'height', first ? Math.max(256, Math.floor(first.height * scale / 16) * 16) : 1536), 'height', 256, 2048, true);
    if (width % 16 || height % 16 || width * height > LIMITS.pixels) invalid('Invalid mode output dimensions.');
  }
  let characters;
  if (mode === 'characters') {
    if (!Array.isArray(input.characters) || input.characters.length < 1 || input.characters.length > 2) invalid('Provide one or two characters.');
    characters = Object.freeze(input.characters.map((character, i) => {
      strictObject(character, ['prompt', 'style', 'x', 'y', 'lora_strength']);
      const style = styleId(pick(character, 'style', 'none'), model);
      const strength = number(pick(character, 'lora_strength', style === 'none' ? 0 : 1), 'character LoRA strength', 0, 2);
      if (style === 'none' && strength !== 0) invalid('Style none requires zero strength.');
      return Object.freeze({ prompt: text(character.prompt, 'character prompt', 4000, true), style, lora_strength: strength,
        x: number(pick(character, 'x', i ? 0.75 : 0.25), 'x', 0, 1), y: number(pick(character, 'y', 0.5), 'y', 0, 1) });
    }));
  }
  const request_id = text(input.request_id, 'request_id', 128, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(request_id)) invalid('Invalid request_id.');
  return Object.freeze({ request_id, backend: 'moss', mode, prompt: text(input.prompt, 'prompt', 12000, true), negative: text(pick(input, 'negative', ''), 'negative', 3000), model, style, lora_strength, ...(loras.length ? { loras } : {}),
    width, height, steps: number(pick(input, 'steps', mode === 'edit' ? 30 : mode === 'inpaint' ? 25 : 50), 'steps', mode === 'characters' ? 2 : 1, 100, true), cfg: number(pick(input, 'cfg', mode === 'edit' ? 4 : mode === 'inpaint' ? 2.5 : 3), 'cfg', mode === 'characters' ? 1 : 0, 20),
    shift: mode === 'edit' ? number(pick(input, 'shift', 5), 'inference shift', 0.1, 20) : null,
    seed: number(pick(input, 'seed', randomBytes(6).readUIntBE(0, 6)), 'seed', 0, Number.MAX_SAFE_INTEGER, true),
    sampler: mode === 'edit' ? null : mode === 'inpaint' ? 'er_sde' : 'euler', scheduler: mode === 'edit' ? 'MOSSImageScheduler' : 'simple', slg: null, batch_size: 1,
    ...(mode === 'edit' ? { model_variant: 'full-sft-edit', reference_max_edge: 512 } : {}), ...(characters ? { characters } : {}),
    brief: text(pick(input, 'brief', ''), 'brief', 1000), checks: Object.freeze(strings(pick(input, 'checks', []), 'checks', 12, 160)), parent_run_id: Object.hasOwn(input, 'parent_run_id') ? runId(input.parent_run_id) : null });
}
function uploadPath(uploaded, id, index) {
  if (!uploaded || uploaded.type !== 'input' || typeof uploaded.name !== 'string' || !/^moss-[0-9a-f-]+-ref[1-4]\.(png|jpg|webp)$/.test(uploaded.name) || uploaded.subfolder !== '') invalid('Invalid uploaded reference identifier.');
  if (!uploaded.name.startsWith(`moss-${id}-ref${index}.`)) invalid('Reference does not belong to this run and ordinal.');
  return uploaded.name;
}
export function compileMode(params, id, uploaded = []) {
  runId(id);
  const mode = params.mode || 't2i';
  if (mode === 't2i') { if (uploaded.length) invalid('t2i takes no references.'); return { graph: compileGraph(params, id), outputNode: '12' }; }
  if (mode === 'edit') {
    if (uploaded.length < 1 || uploaded.length > 4) invalid('Edit requires one to four uploads.');
    const multi = uploaded.length > 1; const graph = structuredClone(templates[multi ? 'edit-multi' : 'edit-single']);
    const editNode = multi ? '4' : '3', outputNode = multi ? '5' : '4';
    const edit = graph[editNode].inputs;
    const style = STYLES[params.style];
    const entries = params.loras ?? [];
    if (!style || typeof params.lora_strength !== 'number' || !Number.isFinite(params.lora_strength) || params.lora_strength < 0 || params.lora_strength > 2 || (params.style === 'none' && params.lora_strength !== 0)) invalid('Invalid Edit style.');
    const styled = params.style !== 'none' && params.lora_strength !== 0;
    let modelSource = '1';
    if (styled) {
      graph['1'].class_type = 'MossDrawEditStyleLoader';
      Object.assign(graph['1'].inputs, { style_lora: style.file, strength: params.lora_strength });
    }
    let inserted = 0;
    for (const entry of entries) {
      if (entry.strength === 0) continue;
      const key = String(100 + inserted);
      graph[key] = { class_type: 'LoraLoaderModelOnly', inputs: { model: [modelSource, 0], lora_name: entry.file, strength_model: entry.strength } };
      modelSource = key; inserted += 1;
    }
    if (modelSource !== '1') edit.model = [modelSource, 0];
    const prefix = [styled && style.trigger ? style.trigger : '', loraPrefix(entries)].filter(Boolean).join('\n');
    Object.assign(edit, { prompt: (prefix ? `${prefix}\n` : '') + params.prompt, negative_prompt: params.negative, width: params.width, height: params.height, seed: params.seed, steps: params.steps, cfg: params.cfg, inference_shift: params.shift });
    uploaded.forEach((u, i) => {
      const key = i === 0 ? '2' : i === 1 ? '3' : String(i + 4);
      if (!graph[key]) graph[key] = structuredClone(graph['2']);
      graph[key].inputs.image = uploadPath(u, id, i + 1); edit[`reference_${i + 1}`] = [key, 0];
    });
    graph[outputNode].inputs.filename_prefix = `moss_draw/${id}/native`;
    return { graph, outputNode };
  }
  if (mode === 'inpaint') {
    if (uploaded.length !== 1) invalid('Inpaint requires one upload.');
    const graph = structuredClone(templates.inpaint);
    const entries = params.loras ?? [];
    let modelSource = '4';
    let inserted = 0;
    for (const entry of entries) {
      if (entry.strength === 0) continue;
      const key = String(100 + inserted);
      graph[key] = { class_type: 'LoraLoaderModelOnly', inputs: { model: [modelSource, 0], lora_name: entry.file, strength_model: entry.strength } };
      modelSource = key; inserted += 1;
    }
    graph['40'].inputs.model = [modelSource, 0];
    const prefix = loraPrefix(entries);
    graph['10'].inputs.image = uploadPath(uploaded[0], id, 1); graph['19'].inputs.value = (prefix ? `${prefix}\n` : '') + params.prompt; graph['21'].inputs.text = params.negative;
    Object.assign(graph['40'].inputs, { seed: params.seed, steps: params.steps, cfg: params.cfg });
    graph['60'].inputs.filename_prefix = `moss_draw/${id}/native`; graph['62'].inputs.filename_prefix = `moss_draw/${id}/effective-mask`;
    return { graph, outputNode: '60', maskNode: '62' };
  }
  if (mode !== 'characters' || uploaded.length) invalid('Invalid mode compilation.');
  const graph = structuredClone(templates.characters);
  graph['1'].inputs.unet_name = MODELS[params.model];
  const entries = params.loras ?? [];
  let modelSource = '1';
  let inserted = 0;
  for (const entry of entries) {
    if (entry.strength === 0) continue;
    const key = String(100 + inserted);
    graph[key] = { class_type: 'LoraLoaderModelOnly', inputs: { model: [modelSource, 0], lora_name: entry.file, strength_model: entry.strength } };
    modelSource = key; inserted += 1;
  }
  graph['10'].inputs.model = [modelSource, 0];
  for (const node of ['6', '7', '8']) graph[node].inputs.character_count = params.characters.length;
  for (let i = 1; i <= 10; i++) {
    const character = params.characters[i - 1]; graph['6'].inputs[`character${i}_enable`] = Boolean(character);
    graph['7'].inputs[`character${i}_lora_clip_strength`] = 0;
    if (!character) { delete graph['6'].inputs[`character${i}`]; if (i === 2) delete graph['5']; continue; }
    const style = STYLES[character.style]; graph[String(i + 3)].inputs.value = (style.trigger ? `${style.trigger}\n` : '') + character.prompt;
    graph['7'].inputs[`character${i}_lora`] = style.file || 'None'; graph['7'].inputs[`character${i}_lora_strength`] = character.lora_strength;
    for (const key of ['x', 'y']) graph['8'].inputs[`character${i}_${key}`] = character[key];
  }
  const prefix = loraPrefix(entries);
  Object.assign(graph['10'].inputs, { prompt: (prefix ? `${prefix}\n` : '') + params.prompt, negative_prompt: params.negative, width: params.width, height: params.height, seed: params.seed, steps: params.steps, cfg: params.cfg, autosave: false });
  graph['11'].inputs.filename_prefix = `moss_draw/${id}/native`;
  return { graph, outputNode: '11' };
}
