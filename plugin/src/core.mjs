import { randomUUID, randomBytes } from 'node:crypto';
import path from 'node:path';
import { catalog, MODELS, STYLES, DEFAULTS, LIMITS, MOSS_SAMPLERS, MOSS_SCHEDULERS, T2I_EXTRA_CANVAS, fault, strictObject, text, number, strings, runId, parseLoras, loraPrefix } from './catalog.mjs';
import { createStore, atomicWrite, hash } from './store.mjs';
import { createComfy, matches, safeOutput, validatePng } from './comfy.mjs';
import { compileMode, normalizeMode, validateAssets, extension } from './modes.mjs';
export { catalog } from './catalog.mjs';

const INPUT_KEYS = ['request_id', 'prompt', 'negative', 'style', 'model', 'width', 'height', 'steps', 'cfg', 'shift', 'seed', 'sampler', 'scheduler', 'lora_strength', 'loras', 'brief', 'checks', 'parent_run_id'];
const chosen = (input, key, fallback) => Object.hasOwn(input, key) ? input[key] : fallback;
// The caller may pick any sampler/scheduler the worker's KSampler really has.
// Listing every accepted value keeps the error actionable instead of "invalid".
const enumChoice = (value, allowed, name) => {
  if (typeof value !== 'string' || !allowed.includes(value)) throw fault('INVALID_INPUT', `Unsupported ${name} ${JSON.stringify(value)}. Use one of: ${allowed.join(', ')}`);
  return value;
};
export function normalizeInput(input, assets = []) {
  const checked = validateAssets(assets);
  if (input?.mode !== undefined && input.mode !== 't2i') return normalizeMode(input, checked);
  if (checked.length) throw fault('INVALID_INPUT', 't2i does not accept image references.');
  strictObject(input, [...INPUT_KEYS, 'mode']);
  const request_id = text(input.request_id, 'request_id', 128, true);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(request_id)) throw fault('INVALID_INPUT', 'Invalid request_id.');
  const model = chosen(input, 'model', DEFAULTS.model);
  const style = chosen(input, 'style', DEFAULTS.style);
  if (typeof model !== 'string' || typeof style !== 'string' || !Object.hasOwn(MODELS, model) || !Object.hasOwn(STYLES, style)) throw fault('INVALID_INPUT', 'Unknown model or style.');
  if (!STYLES[style].models.includes(model)) throw fault('MODEL_STYLE_MISMATCH', 'This style does not support the selected t2i model.');
  const width = number(chosen(input, 'width', DEFAULTS.width), 'width', 256, T2I_EXTRA_CANVAS.width, true);
  const height = number(chosen(input, 'height', DEFAULTS.height), 'height', 256, 2048, true);
  const extraCanvas = width === T2I_EXTRA_CANVAS.width && height === T2I_EXTRA_CANVAS.height;
  if (width % 16 || height % 16 || (!extraCanvas && (width > LIMITS.dimension_max || width * height > LIMITS.pixels))) throw fault('INVALID_INPUT', 'Use 16-aligned sides up to 2048 and 2.1 MP, or exactly 2560x1440 for t2i.');
  const lora_strength = number(chosen(input, 'lora_strength', style === 'none' ? 0 : 1), 'lora_strength', 0, 2);
  if (style === 'none' && lora_strength !== 0) throw fault('INVALID_INPUT', 'style none requires zero LoRA strength.');
  const loras = parseLoras(chosen(input, 'loras', undefined));
  return Object.freeze({
    request_id, backend: 'moss', mode: 't2i', prompt: text(input.prompt, 'prompt', LIMITS.prompt_chars, true),
    negative: text(chosen(input, 'negative', ''), 'negative', LIMITS.negative_chars), model, style, width, height,
    steps: number(chosen(input, 'steps', 50), 'steps', 1, 100, true),
    cfg: number(chosen(input, 'cfg', 3), 'cfg', 0, 20),
    shift: number(chosen(input, 'shift', 5), 'shift', 0, 20),
    seed: number(chosen(input, 'seed', randomBytes(6).readUIntBE(0, 6)), 'seed', 0, Number.MAX_SAFE_INTEGER, true),
    sampler: enumChoice(chosen(input, 'sampler', DEFAULTS.sampler), MOSS_SAMPLERS, 'sampler'),
    scheduler: enumChoice(chosen(input, 'scheduler', DEFAULTS.scheduler), MOSS_SCHEDULERS, 'scheduler'),
    slg: '22', batch_size: 1, lora_strength, ...(loras.length ? { loras } : {}),
    brief: text(chosen(input, 'brief', ''), 'brief', LIMITS.brief_chars),
    checks: Object.freeze(strings(chosen(input, 'checks', []), 'checks', 12, 160)),
    parent_run_id: Object.hasOwn(input, 'parent_run_id') ? runId(input.parent_run_id) : null,
  });
}
export function compileGraph(params, id) {
  runId(id);
  strictObject(params, [...INPUT_KEYS, 'sampler', 'scheduler', 'slg', 'batch_size', 'mode', 'backend']);
  if ((params.mode !== undefined && params.mode !== 't2i') || (params.backend !== undefined && params.backend !== 'moss')) throw fault('INVALID_INPUT', 'Invalid t2i compiler mode.');
  for (const [key, expected] of [['slg', '22'], ['batch_size', 1]]) {
    if (params[key] !== expected) throw fault('INVALID_INPUT', `Unsupported ${key}.`);
  }
  params = normalizeInput(Object.fromEntries(INPUT_KEYS.filter(k => Object.hasOwn(params, k) && !(k === 'parent_run_id' && params[k] === null)).map(k => [k, params[k]])));
  const style = STYLES[params.style];
  const entries = params.loras ?? [];
  const node = (class_type, inputs) => ({ class_type, inputs });
  const graph = {
    '1': node('UNETLoader', { unet_name: MODELS[params.model], weight_dtype: 'default' }),
    '2': node('CLIPLoader', { clip_name: 'qwen3.5_9b_w4a8_gptq.safetensors', type: 'moss_image', device: 'default' }),
    '3': node('VAELoader', { vae_name: 'flux2-vae_small.safetensors' }),
  };
  let modelSource = '1';
  if (style.file) {
    graph['4'] = node('LoraLoaderModelOnly', { model: ['1', 0], lora_name: style.file, strength_model: params.lora_strength });
    modelSource = '4';
  }
  let inserted = 0;
  for (const entry of entries) {
    if (entry.strength === 0) continue;
    const key = String(100 + inserted);
    graph[key] = node('LoraLoaderModelOnly', { model: [modelSource, 0], lora_name: entry.file, strength_model: entry.strength });
    modelSource = key; inserted += 1;
  }
  const prefix = [style.trigger, loraPrefix(entries)].filter(Boolean).join('\n');
  Object.assign(graph, {
    '5': node('ModelSamplingAuraFlow', { model: [modelSource, 0], shift: params.shift }),
    '6': node('SkipLayerGuidanceDiTSimple', { model: ['5', 0], double_layers: '', single_layers: '22', start_percent: 0, end_percent: 1 }),
    '7': node('CLIPTextEncode', { clip: ['2', 0], text: (prefix ? `${prefix}\n` : '') + params.prompt }),
    '8': node('CLIPTextEncode', { clip: ['2', 0], text: params.negative }),
    '9': node('EmptyFlux2LatentImage', { width: params.width, height: params.height, batch_size: 1 }),
    '10': node('KSampler', { model: ['6', 0], positive: ['7', 0], negative: ['8', 0], latent_image: ['9', 0], seed: params.seed, steps: params.steps, cfg: params.cfg, sampler_name: params.sampler, scheduler: params.scheduler, denoise: 1 }),
    '11': node('VAEDecode', { samples: ['10', 0], vae: ['3', 0] }),
    '12': node('SaveImage', { images: ['11', 0], filename_prefix: `moss_draw/${id}/native` }),
  });
  return graph;
}
const now = () => new Date().toISOString();
const terminal = r => r.status === 'failed' || r.status === 'succeeded';
const safeMessages = Object.freeze({
  NETWORK_UNKNOWN: 'Worker reply unavailable; query this run, never resubmit it.',
  REDIRECT_BLOCKED: 'Worker redirect blocked; ask maintenance to inspect.',
  HTTP_ERROR: 'Worker HTTP error; ask maintenance to inspect.',
  INVALID_RESPONSE: 'Worker state unavailable; query this run later.',
  RESPONSE_TOO_LARGE: 'Worker response exceeds the byte limit; ask maintenance to inspect.',
  RECONCILE_AMBIGUOUS: 'Conflicting worker markers; ask maintenance to reconcile, never resubmit.',
  INVALID_ARTIFACT: 'PNG validation failed; ask maintenance to inspect.',
  UNSAFE_OUTPUT: 'Unsafe worker output; ask maintenance to inspect.',
});
const errorInfo = e => Object.hasOwn(safeMessages, e?.code)
  ? { code: e.code, message: safeMessages[e.code] }
  : { code: 'LOCAL_ERROR', message: 'Local operation failed; ask maintenance to inspect.' };
// Error codes are diagnostic metadata, never arbitrary worker/local messages.
const localSourceCodes = new Set(['INVALID_INPUT', 'MODEL_STYLE_MISMATCH', 'INVALID_CONFIG', 'ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EBUSY', 'EROFS', 'EMFILE', 'ENFILE', 'EEXIST', 'ENOTDIR', 'EISDIR']);
const sourceCode = e => localSourceCodes.has(e?.code) ? e.code : errorInfo(e).code;
function rememberInitialError(record) {
  if (!record.initial_error && record.error) record.initial_error = {
    ...record.error, ...(record.submission_phase ? { phase: record.submission_phase } : {}),
  };
}
const summaryKeys = ['backend', 'mode', 'model', 'model_variant', 'style', 'width', 'height', 'steps', 'cfg', 'shift', 'seed', 'lora_strength', 'loras', 'sampler', 'scheduler', 'slg', 'batch_size', 'reference_max_edge'];

export function createService({ dataRoot, comfyUrl, fetchImpl = fetch, adapter, externalParentExists }) {
  if (adapter && (typeof adapter.normalize !== 'function' || typeof adapter.compile !== 'function')) throw fault('INVALID_CONFIG', 'Invalid trusted backend adapter.');
  const maxPixels = adapter?.maxPixels ?? LIMITS.pixels;
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 4500000) throw fault('INVALID_CONFIG', 'Invalid trusted backend pixel limit.');
  const store = createStore(dataRoot);
  const comfy = createComfy(comfyUrl, fetchImpl);
  const locked = (operation, signal) => store.locked(async () => {
    try { return await operation(); }
    catch (e) {
      if (e?.name === 'AbortError') throw e;
      if (['INVALID_INPUT', 'MODEL_STYLE_MISMATCH', 'REQUEST_CONFLICT', 'RUN_NOT_FOUND', 'STORE_CORRUPT'].includes(e.code)) throw e;
      throw fault('LOCAL_ERROR', 'Local operation failed; ask maintenance to inspect.');
    }
  }, signal);
  async function compact(record, full = false) {
    const p = record.params;
    const savedReview = await store.review(record.run_id);
    const review = !savedReview || full ? savedReview : {
      observations: savedReview.observations.slice(0, 3).map(s => s.slice(0, 160)),
      issues: savedReview.issues.slice(0, 3), next_change: savedReview.next_change.slice(0, 240), updated_at: savedReview.updated_at,
    };
    return {
      run_id: record.run_id, status: record.status,
      ...(record.pipeline_run_id ? { pipeline_run_id: record.pipeline_run_id } : {}),
      params: { ...Object.fromEntries(summaryKeys.filter(k => Object.hasOwn(p, k)).map(k => [k, p[k]])), backend: p.backend || 'moss', mode: p.mode || 't2i' },
      context: {
        brief: full ? p.brief : p.brief.slice(0, 300), prompt_excerpt: p.prompt.slice(0, 500),
        checks: full ? [...p.checks] : p.checks.slice(0, 6), parent_run_id: p.parent_run_id, review,
        ...(full ? { prompt: p.prompt, negative: p.negative } : {}),
        ...(p.characters ? { characters: p.characters.map(c => ({ ...c, prompt: full ? c.prompt : c.prompt.slice(0, 160) })) } : {}),
      },
      created_at: record.created_at, updated_at: record.updated_at,
      ...(record.prompt_id ? { prompt_id: record.prompt_id } : {}),
      ...(record.artifact ? { artifact: { ...record.artifact } } : {}),
      ...(record.effective_mask ? { effective_mask: { ...record.effective_mask } } : {}),
      ...(record.mask_error ? { mask_error: { ...record.mask_error } } : {}),
      ...(record.submission_phase ? { submission_phase: record.submission_phase } : {}),
      ...(record.initial_error ? { initial_error: { ...record.initial_error } } : {}),
      ...(record.error ? { error: { ...record.error } } : {}),
    };
  }
  async function save(record) { record.updated_at = now(); await store.write(record); return compact(record); }
  async function collectMask(record, signal) {
    try {
      const mask = safeOutput(record.effective_mask_receipt);
      if (mask.subfolder !== `moss_draw/${record.run_id}` || !/^effective-mask_\d+_\.png$/.test(mask.filename)) throw fault('UNSAFE_OUTPUT', 'Unsafe effective mask output.');
      const bytes = await comfy.image(mask, signal);
      const dimensions = validatePng(bytes, record.params, { maxPixels: record.max_pixels ?? LIMITS.pixels });
      const file = path.join(store.directory(record.run_id), 'effective-mask.png'); await atomicWrite(file, bytes);
      record.effective_mask = { path: file, sha256: hash(bytes), ...dimensions }; delete record.mask_error;
    } catch (e) { signal?.throwIfAborted(); record.mask_error = errorInfo(e); }
  }
  async function reconcile(record, signal) {
    signal?.throwIfAborted();
    // 0.1.0 treated Windows relative separators as an unsafe path. Re-check
    // collection failures with GET only; actual worker execution failure stays final.
    const retryCollection = record.status === 'failed' && record.error?.code === 'UNSAFE_OUTPUT' && record.prompt_id;
    if (terminal(record) && !retryCollection) {
      if (record.status === 'succeeded' && !record.effective_mask && record.effective_mask_receipt) { await collectMask(record, signal); return save(record); }
      return compact(record);
    }
    if (retryCollection) record.status = 'unknown';
    // GET observations may change the latest error, but must not erase why a
    // submission became uncertain. Missing phases in legacy/claim-only records
    // are not proof that a POST never started, nor permission to retry it.
    rememberInitialError(record);
    let downloadingArtifact = false;
    try {
      // History and queue are independent evidence sources. A large global
      // history must not hide the queue marker that lets us query one prompt.
      const [historyResult, queueResult] = await Promise.allSettled([
        comfy.history(record.prompt_id, signal).then(history => {
          if (!history || typeof history !== 'object' || Array.isArray(history)) throw fault('INVALID_RESPONSE', 'Invalid history.');
          return history;
        }),
        comfy.queue(signal).then(queue => {
          if (!Array.isArray(queue?.queue_running) || !Array.isArray(queue?.queue_pending)) throw fault('INVALID_RESPONSE', 'Invalid queue.');
          return queue;
        }),
      ]);
      const history = historyResult.status === 'fulfilled' ? historyResult.value : {};
      const queue = queueResult.status === 'fulfilled' ? queueResult.value : { queue_running: [], queue_pending: [] };
      const histories = Object.values(history).filter(h => matches(h?.prompt, record));
      const running = queue.queue_running.filter(q => matches(q, record));
      const pending = queue.queue_pending.filter(q => matches(q, record));
      const ids = new Set([...histories.map(h => h.prompt[1]), ...running.map(q => q[1]), ...pending.map(q => q[1])]);
      if (ids.size > 1 || (record.prompt_id && ids.size && !ids.has(record.prompt_id))) throw fault('RECONCILE_AMBIGUOUS', 'Conflicting worker markers; ask maintenance to reconcile, never resubmit.');
      if (!ids.size) {
        if (historyResult.status === 'rejected') throw historyResult.reason;
        if (queueResult.status === 'rejected') throw queueResult.reason;
        record.status = 'unknown';
        record.error = { code: 'NOT_FOUND_YET', message: 'No matching worker record; keep this run ID and query later, never resubmit automatically.' };
        return save(record);
      }
      const identifiedFromQueue = !record.prompt_id;
      record.prompt_id = [...ids][0]; delete record.error;
      let historyEntry = histories.find(h => h.prompt[1] === record.prompt_id);
      if (!historyEntry && identifiedFromQueue) {
        record.status = running.length ? 'running' : 'queued';
        // Keep the recovered ID even if the targeted read fails or we crash.
        record.updated_at = now(); await store.write(record);
        const targeted = await comfy.history(record.prompt_id, signal);
        if (!targeted || typeof targeted !== 'object' || Array.isArray(targeted)) throw fault('INVALID_RESPONSE', 'Invalid targeted history.');
        const candidates = Object.values(targeted).filter(h => matches(h?.prompt, record));
        if (candidates.some(h => h.prompt[1] !== record.prompt_id)) throw fault('RECONCILE_AMBIGUOUS', 'Conflicting worker markers.');
        historyEntry = candidates.find(h => h.prompt[1] === record.prompt_id);
      }
      if (historyEntry?.status?.status_str === 'error' || historyEntry?.status?.messages?.some(m => ['execution_error', 'execution_interrupted'].includes(m?.[0]))) {
        record.status = 'failed'; record.error = { code: 'EXECUTION_FAILED', message: 'Worker execution failed; ask maintenance to inspect.' };
      } else if (historyEntry?.status?.status_str === 'success' && historyEntry.status.completed === true) {
        const images = historyEntry.outputs?.[record.output_node || '12']?.images;
        if (!Array.isArray(images) || images.length !== 1) throw fault('INVALID_ARTIFACT', 'Expected exactly one native output.');
        const image = safeOutput(images[0]);
        if (image.subfolder !== `moss_draw/${record.run_id}` || !/^native_\d+_\.png$/.test(image.filename)) throw fault('UNSAFE_OUTPUT', 'Native output does not belong to this run marker.');
        downloadingArtifact = true;
        const bytes = await comfy.image(image, signal);
        const dimensions = validatePng(bytes, record.params, { maxPixels: record.max_pixels ?? LIMITS.pixels });
        const file = path.join(store.directory(record.run_id), 'image.png');
        await atomicWrite(file, bytes);
        record.artifact = { path: file, sha256: hash(bytes), ...dimensions };
        record.status = 'succeeded';
        if (record.mask_node) {
          try {
            const maskImages = historyEntry.outputs?.[record.mask_node]?.images;
            if (!Array.isArray(maskImages) || maskImages.length !== 1) throw fault('INVALID_ARTIFACT', 'Missing effective mask output.');
            const mask = safeOutput(maskImages[0]);
            if (mask.subfolder !== `moss_draw/${record.run_id}` || !/^effective-mask_\d+_\.png$/.test(mask.filename)) throw fault('UNSAFE_OUTPUT', 'Unsafe effective mask output.');
            record.effective_mask_receipt = mask;
            await collectMask(record, signal);
          } catch (e) { record.mask_error = errorInfo(e); }
        }
      } else record.status = running.length ? 'running' : 'queued';
      return save(record);
    } catch (e) {
      signal?.throwIfAborted();
      if (['INVALID_ARTIFACT', 'UNSAFE_OUTPUT'].includes(e.code) || (downloadingArtifact && e.code === 'RESPONSE_TOO_LARGE')) record.status = 'failed';
      record.error = errorInfo(e);
      return save(record);
    }
  }
  return Object.freeze({
    catalog,
    generate(input, assets = [], { signal, pipelineRunId } = {}) {
      signal?.throwIfAborted();
      if (pipelineRunId !== undefined) runId(pipelineRunId);
      // Validate and copy before entering the async queue; caller mutation cannot
      // alter either the hash, image bytes or graph while awaiting another call.
      let params, safeAssets;
      try {
        safeAssets = validateAssets(assets, maxPixels);
        params = adapter ? adapter.normalize(input, safeAssets) : normalizeInput(input, safeAssets.map(({ data, mediaType, width, height }) => ({ data, mediaType, width, height })));
      } catch (e) { return Promise.reject(e); }
      const outputMaxPixels = !adapter && params.mode === 't2i' ? Math.max(maxPixels, params.width * params.height) : maxPixels;
      const assetMeta = safeAssets.map(({ mediaType, width, height, sha256 }) => ({ mediaType, width, height, sha256 }));
      const hashParams = { ...params, seed: Object.hasOwn(input, 'seed') ? params.seed : 'system-chosen', ...(assetMeta.length ? { assets: assetMeta } : {}) };
      // Preserve the pre-mode t2i hash contract across upgrades.
      if (params.backend === 'moss' && params.mode === 't2i') { delete hashParams.backend; delete hashParams.mode; }
      const input_hash = hash(JSON.stringify(hashParams));
      return locked(async () => {
        signal?.throwIfAborted();
        if (params.parent_run_id && !(externalParentExists && await externalParentExists(params.parent_run_id))) await store.read(params.parent_run_id);
        if (pipelineRunId && !(externalParentExists && await externalParentExists(pipelineRunId))) throw fault('RUN_NOT_FOUND', 'Pipeline parent not found.');
        const id = randomUUID(); const at = now();
        const proposed = { schemaVersion: 1, run_id: id, request_id: params.request_id, input_hash, params, ...(pipelineRunId ? { pipeline_run_id: pipelineRunId } : {}), max_pixels: outputMaxPixels, assets: assetMeta, uploaded: [], client_id: `moss-draw-${id}`, status: 'submitting', submission_phase: 'preparing', created_at: at, updated_at: at };
        const claim = await store.claim(params.request_id, proposed);
        if (!claim.owner) {
          if (claim.value.input_hash !== input_hash || claim.value.pipeline_run_id && claim.value.pipeline_run_id !== pipelineRunId) throw fault('REQUEST_CONFLICT', 'request_id already belongs to different input; do not reuse it.');
          let previous;
          try { previous = await store.read(claim.value.run_id); }
          catch (e) {
            if (e.code !== 'RUN_NOT_FOUND') throw e;
            // Crash (or another process) between claim and run persistence. This
            // permanent reservation must never be retried as a fresh submission.
            previous = { ...claim.value, status: 'unknown' };
          }
          return compact(previous);
        }
        let promptStarted = false;
        try {
          await store.write(proposed); // Claim + preparing precede ALL remote writes.
          for (let i = 0; i < safeAssets.length; i++) {
            const asset = safeAssets[i];
            await atomicWrite(path.join(store.directory(id), `ref${i + 1}.${extension(asset.mediaType)}`), asset.data);
          }
          if (safeAssets.length) {
            proposed.submission_phase = 'uploading'; await store.write(proposed);
          }
          for (let i = 0; i < safeAssets.length; i++) {
            signal?.throwIfAborted();
            const receipt = await comfy.upload(safeAssets[i], id, i + 1);
            proposed.uploaded.push(receipt); await store.write(proposed);
          }
          const { graph, outputNode, maskNode } = (adapter?.compile ?? compileMode)(params, id, proposed.uploaded);
          proposed.output_node = outputNode;
          if (maskNode) proposed.mask_node = maskNode;
          await store.writeGraph(id, graph);
          proposed.submission_phase = 'compiled';
          await store.write(proposed); // Full graph receipt is durable before POST.
          signal?.throwIfAborted();
          // A crash from this durable marker onward is ambiguous. Failure to
          // write it must never reach POST; keep the in-memory phase compiled
          // until persistence succeeds so a known local failure is accurate.
          await store.write({ ...proposed, submission_phase: 'submit_started' });
          proposed.submission_phase = 'submit_started';
          signal?.throwIfAborted();
          promptStarted = true;
          proposed.prompt_id = await comfy.submit(graph, id);
          proposed.status = 'queued';
        } catch (e) {
          if (!promptStarted && signal?.aborted && e === signal.reason) {
            proposed.status='failed';proposed.error={code:'CANCELLED_BEFORE_SUBMIT',message:'Cancelled before prompt submission; no GPU job was submitted.'};
            await save(proposed);throw e;
          }
          if (!promptStarted) {
            proposed.status = 'failed';
            proposed.error = {
              code: 'PRE_SUBMIT_FAILED', message: 'Failed before prompt submission; no GPU job was submitted. Keep this request ID; ask maintenance to inspect, never retry automatically.',
              source_code: sourceCode(e), phase: proposed.submission_phase,
            };
          } else {
            proposed.status = e?.code === 'HTTP_ERROR' && [400, 401, 403, 404, 422].includes(e.status) ? 'failed' : 'unknown';
            proposed.error = errorInfo(e);
            rememberInitialError(proposed);
            proposed.initial_error.source_code = sourceCode(e);
          }
        }
        return save(proposed);
      }, signal);
    },
    run(input, { signal } = {}) {
      return locked(async () => { signal?.throwIfAborted(); strictObject(input, ['run_id']); return reconcile(await store.read(runId(input.run_id)), signal); }, signal);
    },
    context(input = {}) {
      return locked(async () => {
        strictObject(input, ['limit', 'run_id']);
        const limit = number(chosen(input, 'limit', 3), 'limit', 1, 3, true);
        const full = Object.hasOwn(input, 'run_id');
        const ids = full ? [runId(input.run_id)] : await store.recent(limit, record => !record.pipeline_run_id);
        const runs = [];
        for (const id of ids) runs.push(await compact(await store.read(id), full));
        return { schemaVersion: 1, catalog: catalog(), runs };
      });
    },
    review(input) {
      return locked(async () => {
        strictObject(input, ['run_id', 'observations', 'issues', 'next_change']);
        const id = runId(input.run_id);
        const review = {
          observations: strings(input.observations, 'observations', 12, 500),
          issues: strings(input.issues, 'issues', 12, 160),
          next_change: text(input.next_change, 'next_change', 500), updated_at: now(),
        };
        await store.read(id);
        await store.writeReview(id, review);
        return { run_id: id, review };
      });
    },
  });
}
