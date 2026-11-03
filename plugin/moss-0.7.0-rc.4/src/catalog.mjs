// Exact style versions were tested on Base/SFT t2i. RS/Edit combinations
// are selectable but their visual quality remains experimental.
const STYLE_MODELS = Object.freeze(['base', 'sft']);
export const T2I_EXTRA_CANVAS = Object.freeze({ width: 2560, height: 1440 });
export const MODELS = Object.freeze({
  base: 'moss_image_base_int8_convrot.safetensors',
  sft: 'moss_image_sft_int8_convrot.safetensors',
});
export const STYLES = Object.freeze({
  kieed: Object.freeze({ file: 'kieed_style_moss_uma_v1.safetensors', trigger: '', models: STYLE_MODELS }),
  modare: Object.freeze({ file: 'modare_style_moss_uma_v1.safetensors', trigger: '', models: STYLE_MODELS }),
  fymrie: Object.freeze({ file: 'FymriE_moss_style_step_800-comfy.safetensors', trigger: 'artist:FymriE', models: STYLE_MODELS }),
  dlss5: Object.freeze({ file: 'DLSS5_moss_v1.0.safetensors', trigger: '@DLSS5', models: STYLE_MODELS }),
  none: Object.freeze({ file: null, trigger: '', models: STYLE_MODELS }),
});
export const LORA_MAX = 4;
const LORA_FILE = /^[^\0\r\n\\]{1,240}\.safetensors$/i;
// Arbitrary caller-supplied LoRAs stacked after the built-in style. The file
// name is relative to the worker's ComfyUI loras/ directory; nothing is
// downloaded, copied or resolved locally.
export function parseLoras(value) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > LORA_MAX) throw fault('INVALID_INPUT', `Invalid loras: use an array of at most ${LORA_MAX} entries.`);
  const seen = new Set();
  return Object.freeze(value.map((item, index) => {
    strictObject(item, ['file', 'strength', 'trigger']);
    const file = text(item.file, `loras[${index}].file`, 240, true);
    if (!LORA_FILE.test(file) || file.startsWith('/') || file.includes('..')) throw fault('INVALID_INPUT', `Invalid loras[${index}].file: use a loras-relative .safetensors name.`);
    if (seen.has(file.toLowerCase())) throw fault('INVALID_INPUT', `Duplicate loras[${index}].file.`);
    seen.add(file.toLowerCase());
    return Object.freeze({
      file,
      strength: number(item.strength === undefined ? 1 : item.strength, `loras[${index}].strength`, 0, 2),
      trigger: text(item.trigger === undefined ? '' : item.trigger, `loras[${index}].trigger`, 500),
    });
  }));
}
export function loraPrefix(list) {
  return list.filter(item => item.strength !== 0 && item.trigger.trim()).map(item => item.trigger).join('\n');
}
export const LIMITS = Object.freeze({
  dimension_min: 256, dimension_max: 2048, dimension_multiple: 16, pixels: 2100000,
  prompt_chars: 12000, negative_chars: 3000, brief_chars: 1000,
  checks_count: 12, check_chars: 160, context_runs: 3,
  png_bytes: 32 * 1024 * 1024, json_bytes: 8 * 1024 * 1024,
});
export const DEFAULTS = Object.freeze({
  model: 'base', style: 'fymrie', width: 1024, height: 1536,
  steps: 50, cfg: 4, shift: 5, sampler: 'euler', scheduler: 'sgm_uniform',
  slg: '22', lora_strength: 1, batch_size: 1,
});
// Authoritative KSampler enums read from the worker's /object_info/KSampler.
// Frozen here so t2i validation never depends on a live worker; a newer worker
// only adds names, and an unknown name is rejected here rather than by a 400.
export const MOSS_SAMPLERS = Object.freeze(['euler', 'euler_cfg_pp', 'euler_ancestral', 'euler_ancestral_cfg_pp', 'heun', 'heunpp2', 'exp_heun_2_x0', 'exp_heun_2_x0_sde', 'dpm_2', 'dpm_2_ancestral', 'lms', 'dpm_fast', 'dpm_adaptive', 'dpmpp_2s_ancestral', 'dpmpp_2s_ancestral_cfg_pp', 'dpmpp_sde', 'dpmpp_sde_gpu', 'dpmpp_2m', 'dpmpp_2m_cfg_pp', 'dpmpp_2m_sde', 'dpmpp_2m_sde_gpu', 'dpmpp_2m_sde_heun', 'dpmpp_2m_sde_heun_gpu', 'dpmpp_3m_sde', 'dpmpp_3m_sde_gpu', 'ddpm', 'lcm', 'ipndm', 'ipndm_v', 'deis', 'cfgpp_ud10_ab', 'res_multistep', 'res_multistep_cfg_pp', 'res_multistep_ancestral', 'res_multistep_ancestral_cfg_pp', 'gradient_estimation', 'gradient_estimation_cfg_pp', 'er_sde', 'seeds_2', 'seeds_3', 'sa_solver', 'sa_solver_pece', 'ddim', 'uni_pc', 'uni_pc_bh2']);
export const MOSS_SCHEDULERS = Object.freeze(['simple', 'sgm_uniform', 'karras', 'exponential', 'ddim_uniform', 'beta', 'normal', 'linear_quadratic', 'kl_optimal']);
export function catalog() {
  return {
    schemaVersion: 1,
    models: Object.keys(MODELS),
    samplers: [...MOSS_SAMPLERS], schedulers: [...MOSS_SCHEDULERS],
    styles: Object.entries(STYLES).map(([id, s]) => ({ id, models: [...s.models], characters_models: [...s.models], trigger: s.trigger })),
    loras: {
      max: LORA_MAX, fields: ['file', 'strength', 'trigger'], default_strength: 1,
      strength_range: [0, 2], trigger_chars: 500,
      file: 'Path relative to the worker ComfyUI loras/ directory, ending .safetensors.',
      stacking: 'The built-in style LoRA (when style is not none) runs first, then loras in listed order.',
      modes: ['moss t2i', 'moss edit', 'moss inpaint', 'moss characters', 'moss regions per region', 'k2 t2i'],
    },
    defaults: { ...DEFAULTS }, limits: { ...LIMITS },
    modes: [
      { id: 't2i', references: [0, 0], output: 'native', steps: 50, cfg: 4, sampler: 'euler', scheduler: 'sgm_uniform', caller_selectable: ['steps', 'cfg', 'shift', 'sampler', 'scheduler'], extra_sizes: [[T2I_EXTRA_CANVAS.width, T2I_EXTRA_CANVAS.height]], max_pixels: T2I_EXTRA_CANVAS.width * T2I_EXTRA_CANVAS.height },
      { id: 'edit', references: [1, 4], model: 'full-sft-edit', style: 'none', styles: ['none', 'fymrie', 'kieed', 'modare', 'dlss5'], style_loader: 'MossDrawEditStyleLoader', style_gpu_validated: false, style_note: 'Nonzero style requires the companion loader; cross-SFT style/edit quality and identity fidelity remain experimental.', steps: 30, cfg: 4, shift: 5, sampler: null, scheduler: 'MOSSImageScheduler' },
      { id: 'inpaint', references: [1, 1], mask: 'RGBA alpha: 0 edit, 255 keep; expanded/blurred effective mask', model: 'sft', style: 'none', steps: 25, cfg: 4, sampler: 'er_sde', scheduler: 'simple' },
      { id: 'characters', references: [0, 0], character_count: [1, 2], model: 'sft', steps: 50, cfg: 4, sampler: 'euler', scheduler: 'simple', style_gpu_validated: false, style_note: 'Base/SFT style selection is supported; multi-character visual quality needs per-run review.' },
      { id: 'regions', actions: ['draft', 'execute'], references: [2, 4], canvas_reference_index: 0, canvas_format: 'PNG', canvas_pixels_max: 4500000, character_reference_index_min: 1, character_pixels_max: 2100000, region_count: [1, 4], box_coordinates: 'half-open original pixels', default_style: 'fymrie', styles: ['none', 'fymrie', 'kieed', 'modare', 'dlss5'], style_gpu_validated: false, draft_inference_calls: 0, run_advances_authorized_stages: true, view_advances: false, overlap: 'later regions overwrite earlier regions', full_qwen_preserves_outside: false, guide_topic: 'regions' },
    ],
  };
}
export function fault(code, message) {
  return Object.assign(new Error(message), { code });
}
export function strictObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw fault('INVALID_INPUT', 'Expected a plain object.');
  if (Reflect.ownKeys(value).some(k => typeof k !== 'string' || !keys.includes(k))) throw fault('INVALID_INPUT', 'Unsupported input field.');
  return value;
}
export function text(value, name, max, nonempty = false) {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()) || value.includes('\0')) throw fault('INVALID_INPUT', `Invalid ${name}.`);
  return value;
}
export function number(value, name, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw fault('INVALID_INPUT', `Invalid ${name}.`);
  return value;
}
export function strings(value, name, count, chars) {
  if (!Array.isArray(value) || value.length > count) throw fault('INVALID_INPUT', `Invalid ${name}.`);
  return value.map(v => text(v, name, chars, true));
}
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function runId(value) {
  if (typeof value !== 'string' || !UUID.test(value)) throw fault('INVALID_INPUT', 'Invalid run_id.');
  return value;
}
