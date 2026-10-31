import { inflateSync } from 'node:zlib';
import { fault, LIMITS, runId } from './catalog.mjs';

const PROMPT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_COMPONENT = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,199}$/;
// One image GET is one logical download: a first plain GET, then at most a few
// byte-range continuations of the same fixed-length entity. The 30 minute wall
// clock and the attempt cap keep a slow origin (about 4 KB/s in the field,
// so ~720 KB per 180 s attempt) from looping forever while still allowing a
// ~5 MB PNG to finish; neither limit alone may be exceeded.
const DOWNLOAD_ATTEMPT_MS = 180000;
const DOWNLOAD_TOTAL_MS = 30 * 60 * 1000;
const DOWNLOAD_ATTEMPTS = 10;
const INTERRUPTED_NAMES = ['AbortError', 'TimeoutError', 'TypeError'];
const INTERRUPTED_CODES = ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'UND_ERR_CLOSED'];
function interrupted(error) {
  return INTERRUPTED_NAMES.includes(error?.name) || INTERRUPTED_CODES.includes(error?.code);
}
// Only a strong entity tag or an exact Last-Modified can prove that the rest of
// a partial body belongs to the bytes already received.
function strongTag(etag) {
  return typeof etag === 'string' && etag.length > 0 && !/^W\//i.test(etag) ? etag : null;
}
function rangeValidator({ etag, lastModified }) {
  return etag || lastModified || null;
}
function sameEntity(entity, response) {
  const etag = strongTag(response.headers.get('etag'));
  if (entity.etag) return etag === entity.etag;
  const lastModified = response.headers.get('last-modified');
  return Boolean(entity.lastModified && lastModified === entity.lastModified);
}
export function safeOutput(image) {
  // ComfyUI on Windows reports relative subfolders with backslashes.
  // Normalize separators before checking components; never resolve '..'.
  if (image && typeof image.subfolder === 'string') image = { ...image, subfolder: image.subfolder.replaceAll('\\', '/') };
  if (!image || image.type !== 'output' || typeof image.filename !== 'string' || !SAFE_COMPONENT.test(image.filename) || !image.filename.endsWith('.png') || typeof image.subfolder !== 'string' || image.subfolder.length > 500 || (image.subfolder !== '' && image.subfolder.split('/').some(p => !SAFE_COMPONENT.test(p)))) throw fault('UNSAFE_OUTPUT', 'Unsafe worker output; ask maintenance to inspect.');
  return { filename: image.filename, subfolder: image.subfolder, type: 'output' };
}
async function boundedBody(response, max) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > max) { await response.body?.cancel(); throw fault('RESPONSE_TOO_LARGE', 'Worker response exceeds the byte limit.'); }
  if (!response.body) throw fault('INVALID_RESPONSE', 'Empty worker response.');
  const parts = []; let size = 0;
  for await (const part of response.body) {
    size += part.length;
    if (size > max) throw fault('RESPONSE_TOO_LARGE', 'Worker response exceeds the byte limit.');
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}
export function createComfy(comfyUrl, fetchImpl = fetch) {
  let base;
  try { base = new URL(comfyUrl); } catch { throw fault('INVALID_CONFIG', 'Invalid trusted Comfy origin.'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw fault('INVALID_CONFIG', 'Comfy URL must be an HTTP(S) origin without credentials or path.');
  if (typeof fetchImpl !== 'function') throw fault('INVALID_CONFIG', 'fetchImpl must be a function.');
  async function openResponse(target, init, signal) {
    let response;
    try { response = await fetchImpl(target, init); }
    catch (e) {
      signal?.throwIfAborted();
      if (/redirect/i.test(String(e.cause?.message || e.message))) throw fault('REDIRECT_BLOCKED', 'Worker redirect blocked; ask maintenance to inspect.');
      throw fault('NETWORK_UNKNOWN', 'Worker reply unavailable; query this run, never resubmit it.');
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) { await response.body?.cancel(); throw fault('REDIRECT_BLOCKED', 'Worker redirect blocked; ask maintenance to inspect.'); }
    return response;
  }
  // GET one image. A dropped body is not a lost generation: keep the bytes that
  // already arrived and continue the same fixed-length entity with Range, but
  // only when the origin proved a total length and a range validator. Anything
  // unproven (no validator, changed ETag, 200 instead of 206, wrong range)
  // stays NETWORK_UNKNOWN and is never stitched.
  async function download(endpoint, signal) {
    const target = new URL(endpoint, base).href;
    const deadline = Date.now() + DOWNLOAD_TOTAL_MS;
    let entity = null;
    for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      const remaining = Math.min(DOWNLOAD_ATTEMPT_MS, deadline - Date.now());
      if (remaining <= 0) break;
      const resuming = Boolean(entity && entity.size > 0);
      if (resuming && (!Number.isSafeInteger(entity.total) || !rangeValidator(entity))) throw fault('NETWORK_UNKNOWN', 'Worker reply unavailable; query this run, never resubmit it.');
      const headers = resuming ? { Range: `bytes=${entity.size}-${entity.total - 1}`, 'If-Range': rangeValidator(entity) } : undefined;
      let response;
      try {
        response = await openResponse(target, {
          method: 'GET', redirect: 'error', headers, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(remaining)]) : AbortSignal.timeout(remaining),
        }, signal);
      } catch (e) {
        signal?.throwIfAborted();
        // Continue only an already proven partial entity, never blindly retry
        // an initial failed request (including effective-mask collection).
        if (!resuming || e.code !== 'NETWORK_UNKNOWN') throw e;
        continue;
      }
      try {
        if (!response.ok) {
          await response.body?.cancel();
          const error = fault('HTTP_ERROR', 'Worker HTTP error; ask maintenance to inspect.');
          error.status = response.status;
          throw error;
        }
        const declared = response.headers.get('content-length');
        const length = declared === null ? null : Number(declared);
        if (length !== null && (!Number.isSafeInteger(length) || length < 0)) throw fault('INVALID_RESPONSE', 'Invalid worker content length.');
        if (!resuming) {
          if (response.status !== 200) throw fault('INVALID_RESPONSE', 'Unexpected partial worker reply.');
          if (length !== null && length > LIMITS.png_bytes) { await response.body?.cancel(); throw fault('RESPONSE_TOO_LARGE', 'Worker response exceeds the byte limit.'); }
          entity = { buffer: Buffer.alloc(length ?? LIMITS.png_bytes), size: 0, total: length, etag: strongTag(response.headers.get('etag')), lastModified: response.headers.get('last-modified') };
        } else {
          if (response.status !== 206) throw fault('NETWORK_UNKNOWN', 'Worker range reply was not partial; query this run instead of stitching it.');
          if (response.headers.get('content-range') !== `bytes ${entity.size}-${entity.total - 1}/${entity.total}`) throw fault('NETWORK_UNKNOWN', 'Worker range receipt does not match the received bytes; query this run.');
          if (length === null || length !== entity.total - entity.size) throw fault('NETWORK_UNKNOWN', 'Worker range length does not match; query this run.');
          if (!sameEntity(entity, response)) throw fault('NETWORK_UNKNOWN', 'Worker entity changed during the download; query this run.');
        }
        if (!response.body) throw fault('INVALID_RESPONSE', 'Empty worker response.');
        for await (const part of response.body) {
          entity.size += part.length;
          if (entity.size > LIMITS.png_bytes) throw fault('RESPONSE_TOO_LARGE', 'Worker response exceeds the byte limit.');
          if (Number.isSafeInteger(entity.total) && entity.size > entity.total) throw fault('NETWORK_UNKNOWN', 'Worker sent more bytes than its declared length; query this run.');
          entity.buffer.set(part, entity.size - part.length);
        }
      } catch (e) {
        if (response.body && !response.body.locked) await response.body.cancel().catch(() => {});
        signal?.throwIfAborted();
        if (!interrupted(e)) throw e;
        continue; // resume from entity.size on the next attempt
      }
      if (!Number.isSafeInteger(entity.total) || entity.size === entity.total) return entity.buffer.subarray(0, entity.size);
      // A cleanly ended body that is shorter than its declared length is still
      // an interrupted transfer; keep its bytes and continue by range.
    }
    throw fault('NETWORK_UNKNOWN', 'Worker reply unavailable; query this run, never resubmit it.');
  }
  async function request(endpoint, body, binary = false, signal) {
    // Endpoint is assembled solely by the methods below, never caller input.
    if (binary) return download(endpoint, signal);
    const response = await openResponse(new URL(endpoint, base).href, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
      ...(body ? body instanceof FormData ? { body } : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    }, signal);
    if (!response.ok) {
      await response.body?.cancel();
      const error = fault('HTTP_ERROR', 'Worker HTTP error; ask maintenance to inspect.');
      error.status = response.status;
      throw error;
    }
    let bytes;
    try { bytes = await boundedBody(response, LIMITS.json_bytes); }
    catch (error) {
      signal?.throwIfAborted();
      if (interrupted(error)) throw fault('NETWORK_UNKNOWN', 'Worker response body was interrupted; query this run, never resubmit it.');
      throw error;
    }
    try { return JSON.parse(bytes.toString('utf8')); }
    catch { throw fault('INVALID_RESPONSE', 'Worker returned invalid JSON; query this run.'); }
  }
  return {
    async upload(asset, id, index) {
      runId(id);
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[asset.mediaType];
      if (!ext || !Number.isSafeInteger(index) || index < 1 || index > 4) throw fault('INVALID_INPUT', 'Invalid upload asset.');
      const name = `moss-${id}-ref${index}.${ext}`;
      const form = new FormData();
      form.append('image', new Blob([asset.data], { type: asset.mediaType }), name);
      form.append('type', 'input'); form.append('overwrite', 'false');
      const reply = await request('/upload/image', form);
      if (reply?.name !== name || reply.subfolder !== '' || reply.type !== 'input') throw fault('INVALID_RESPONSE', 'Upload receipt does not match the deterministic reference.');
      return { name, subfolder: '', type: 'input' };
    },
    async submit(graph, id) {
      runId(id);
      const reply = await request('/prompt', { prompt: graph, client_id: `moss-draw-${id}`, extra_data: { moss_run_id: id } });
      if (!reply || typeof reply.prompt_id !== 'string' || !PROMPT_ID.test(reply.prompt_id) || (reply.node_errors && Object.keys(reply.node_errors).length)) throw fault('INVALID_RESPONSE', 'No unambiguous worker receipt; query this run.');
      return reply.prompt_id;
    },
    history(id, signal) {
      if (id !== undefined && (typeof id !== 'string' || !PROMPT_ID.test(id))) throw fault('INVALID_RESPONSE', 'Invalid worker prompt identifier.');
      return request(id ? `/history/${id}` : '/history?max_items=1000', null, false, signal);
    },
    queue: signal => request('/queue', null, false, signal),
    image: (image, signal) => request(`/view?${new URLSearchParams(safeOutput(image))}`, null, true, signal),
  };
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  return c >>> 0;
});
function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = (c >>> 8) ^ crcTable[(c ^ byte) & 255];
  return (c ^ 0xffffffff) >>> 0;
}
// Native Comfy SaveImage uses non-interlaced 8-bit RGB/RGBA. Reject incomplete
// streams (including header-only impostors), bad CRCs and decompression bombs.
export function validatePng(bytes, expected, { pixels = false, maxPixels = LIMITS.pixels } = {}) {
  const bad = () => { throw fault('INVALID_ARTIFACT', 'PNG validation failed; ask maintenance to inspect.'); };
  if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 4500000) bad();
  if (!Buffer.isBuffer(bytes) || bytes.length > LIMITS.png_bytes || bytes.length < 57 || !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) bad();
  let offset = 8; let width; let height; let channels; let end = false; let seenData = false; let dataEnded = false;
  const compressed = [];
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) bad();
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) bad();
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (!/^[A-Za-z]{4}$/.test(type) || crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) bad();
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) bad(); // One reference is one image, never an APNG batch.
    if (offset === 8 && type !== 'IHDR') bad();
    if (type === 'IHDR') {
      if (offset !== 8 || length !== 13) bad();
      width = data.readUInt32BE(); height = data.readUInt32BE(4);
      if (width !== expected.width || height !== expected.height || width * height > maxPixels || data[8] !== 8 || ![2, 6].includes(data[9]) || data[10] || data[11] || data[12]) bad();
      channels = data[9] === 2 ? 3 : 4;
    } else if (type === 'IDAT') {
      if (dataEnded) bad();
      seenData = true; compressed.push(data);
    } else if (type === 'IEND') {
      if (length || !seenData || offset + 12 !== bytes.length) bad();
      end = true;
    } else {
      if (seenData) dataEnded = true;
      if (type[0] === type[0].toUpperCase() && type !== 'PLTE') bad();
    }
    offset += length + 12;
  }
  if (!end || !channels) bad();
  const stride = width * channels + 1;
  let raw;
  try { raw = inflateSync(Buffer.concat(compressed), { maxOutputLength: stride * height }); }
  catch { bad(); }
  if (raw.length !== stride * height) bad();
  for (let row = 0; row < height; row++) if (raw[row * stride] > 4) bad();
  if (!pixels) return { width, height };
  const decoded = Buffer.alloc(width * height * channels);
  const rowBytes = width * channels;
  for (let y = 0; y < height; y++) for (let x = 0; x < rowBytes; x++) {
    const i = y * rowBytes + x;
    const a = x >= channels ? decoded[i - channels] : 0;
    const b = y ? decoded[i - rowBytes] : 0;
    const c = y && x >= channels ? decoded[i - rowBytes - channels] : 0;
    const filter = raw[y * stride];
    let predictor = 0;
    if (filter === 1) predictor = a;
    else if (filter === 2) predictor = b;
    else if (filter === 3) predictor = Math.floor((a + b) / 2);
    else if (filter === 4) {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    decoded[i] = (raw[y * stride + x + 1] + predictor) & 255;
  }
  return { width, height, channels, pixels: decoded };
}

export function matches(tuple, record) {
  return Array.isArray(tuple) && typeof tuple[1] === 'string' && PROMPT_ID.test(tuple[1]) && tuple[3]?.client_id === record.client_id && tuple[3]?.moss_run_id === record.run_id && tuple[2]?.[record.output_node || '12']?.inputs?.filename_prefix === `moss_draw/${record.run_id}/native`;
}
