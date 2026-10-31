import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { validatePng } from '../src/comfy.mjs';

const pixels = await import('../src/region-pixels.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url === new URL('../src/region-pixels.mjs', import.meta.url).href) return {};
  throw error;
});
function api(name) {
  assert.equal(typeof pixels[name], 'function', `${name} must implement the region pixel contract`);
  return pixels[name];
}
// Independent fixtures exercise real PNG parsing, not the production encoder.
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  const result = Buffer.alloc(body.length + 8);
  result.writeUInt32BE(data.length); body.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function fixture(width, height, values, channels = 4, filters = [0]) {
  const data = Buffer.from(values);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = channels === 3 ? 2 : 6;
  const rowBytes = width * channels;
  const raw = Buffer.alloc((rowBytes + 1) * height);
  for (let y = 0; y < height; y++) {
    const filter = filters[y % filters.length]; raw[y * (rowBytes + 1)] = filter;
    for (let x = 0; x < rowBytes; x++) {
      const i = y * rowBytes + x;
      const a = x >= channels ? data[i - channels] : 0;
      const b = y ? data[i - rowBytes] : 0;
      const c = y && x >= channels ? data[i - rowBytes - channels] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth][filter];
      raw[y * (rowBytes + 1) + x + 1] = (data[i] - predictor) & 255;
    }
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function solid(width, height, rgba) {
  return fixture(width, height, Buffer.alloc(width * height * 4).fill(Buffer.from(rgba)));
}
function at(image, x, y) {
  return [...image.pixels.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
}
const region = (box, options = {}) => ({ id: 'subject', box, context_px: 0, feather_px: 0, ...options });
const decode = data => api('decodePng')(data);
const crop = (data, box) => api('regionCrop')(data, box);
const composite = (...args) => api('regionComposite')(...args);
const overlay = (...args) => api('regionOverlay')(...args);

// Break caught: RGB buffers incorrectly exposed as RGBA / missing opaque alpha.
test('RGB decoding expands to RGBA without changing color bytes', () => {
  assert.deepEqual(decode(fixture(2, 1, [13, 29, 47, 101, 203, 255], 3)), {
    width: 2, height: 1, channels: 4, pixels: Buffer.from([13, 29, 47, 255, 101, 203, 255, 255]),
  });
});

test('RGBA roundtrip preserves every byte including RGB hidden under zero alpha', () => {
  const original = Buffer.from([3, 7, 11, 0, 20, 30, 40, 1, 250, 150, 50, 128, 17, 19, 23, 255]);
  const before = Buffer.from(original);
  const encoded = api('encodePng')({ width: 2, height: 2, pixels: original });
  assert(Buffer.isBuffer(encoded));
  assert.deepEqual(validatePng(encoded, { width: 2, height: 2 }, { pixels: true }).pixels, before);
  assert.deepEqual(decode(encoded).pixels, before);
  assert.deepEqual(original, before);
});

test('all five PNG scanline filters decode accurately', () => {
  const original = Buffer.from(Array.from({ length: 3 * 5 * 4 }, (_, i) => (i * 67 + 13) % 256));
  assert.deepEqual(decode(fixture(3, 5, original, 4, [0, 1, 2, 3, 4])).pixels, original);
});

test('invalid and damaged PNG inputs fail closed', () => {
  const valid = solid(2, 2, [1, 2, 3, 255]);
  const damaged = Buffer.from(valid); damaged[29] ^= 1;
  for (const bytes of [null, new Uint8Array(valid), Buffer.from('not png'), valid.subarray(0, 40), damaged, Buffer.concat([valid, Buffer.from([0])])]) {
    assert.throws(() => decode(bytes), { code: 'INVALID_ARTIFACT' });
  }
  assert.throws(() => decode(fixture(0, 1, [])), { code: 'INVALID_ARTIFACT' });
});

test('encoder rejects malformed dimensions and pixel lengths before allocation', () => {
  const encode = api('encodePng');
  for (const input of [null, {}, { width: 0, height: 2, pixels: Buffer.alloc(0) }, { width: 1.5, height: 2, pixels: Buffer.alloc(12) }, { width: 2, height: 2, pixels: Buffer.alloc(15) }, { width: 1, height: 1, pixels: [1, 2, 3, 4] }, { width: Infinity, height: 1, pixels: Buffer.alloc(0) }]) {
    assert.throws(() => encode(input), { code: 'INVALID_INPUT' });
  }
});

test('4.5MP is accepted while larger decode and encode inputs are rejected', () => {
  const encode = api('encodePng');
  const large = Buffer.alloc(3000 * 1500 * 4); large[0] = 29; large[large.length - 1] = 203;
  const decoded = decode(encode({ width: 3000, height: 1500, pixels: large }));
  assert.equal(decoded.width, 3000); assert.equal(decoded.height, 1500);
  assert.deepEqual(decoded.pixels, large);
  assert.throws(() => encode({ width: 3001, height: 1500, pixels: Buffer.alloc(0) }), { code: 'INVALID_INPUT' });
  assert.throws(() => decode(solid(3001, 1500, [0, 0, 0, 0])), { code: 'INVALID_ARTIFACT' });
});

test('empty, out-of-bounds, fractional and malformed half-open boxes are rejected by every region entry point', () => {
  const base = solid(4, 4, [3, 4, 5, 255]);
  const invalidBoxes = [[0, 0, 0, 1], [1, 2, 3, 2], [-1, 0, 2, 2], [0, 0, 5, 4], [0, 0, 4, 5], [0.5, 0, 3, 3], [0, 0, Infinity, 4], ['0', 0, 2, 2], [0, 0, 2], null];
  for (const box of invalidBoxes) {
    assert.throws(() => crop(base, region(box)), { code: 'INVALID_INPUT' });
    assert.throws(() => composite(base, base, region(box), [0, 0, 4, 4]), { code: 'INVALID_INPUT' });
    assert.throws(() => overlay(base, [region(box)]), { code: 'INVALID_INPUT' });
  }
});

test('zero context and feather are valid and omitted margins default to zero', () => {
  const base = solid(4, 4, [3, 4, 5, 255]);
  assert.deepEqual(crop(base, region([1, 1, 3, 3])).crop_box, [1, 1, 3, 3]);
  assert.deepEqual(crop(base, { id: 'subject', box: [1, 1, 3, 3] }).crop_box, [1, 1, 3, 3]);
  const result = composite(base, solid(2, 2, [10, 20, 30, 40]), region([1, 1, 3, 3]), [1, 1, 3, 3]);
  assert.deepEqual(at(decode(result.data), 1, 1), [10, 20, 30, 40]);
});

test('invalid context and feather values are rejected rather than coerced', () => {
  const base = solid(4, 4, [0, 0, 0, 255]);
  for (const key of ['context_px', 'feather_px']) for (const value of [-1, 0.5, NaN, Infinity, '1', null, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => crop(base, region([1, 1, 3, 3], { [key]: value })), { code: 'INVALID_INPUT' });
  }
});

test('context crop clips at canvas edges and returns exact original RGBA rows', () => {
  const values = Buffer.from(Array.from({ length: 4 * 3 * 4 }, (_, i) => i));
  const base = fixture(4, 3, values);
  const result = crop(base, region([0, 1, 2, 3], { context_px: 1 }));
  assert.deepEqual(result.crop_box, [0, 0, 3, 3]);
  assert.equal(result.width, 3); assert.equal(result.height, 3);
  assert.deepEqual(decode(result.data).pixels, Buffer.concat([values.subarray(0, 12), values.subarray(16, 28), values.subarray(32, 44)]));
  assert.deepEqual(crop(base, region([3, 2, 4, 3], { context_px: 100 })).crop_box, [0, 0, 4, 3]);
});

test('composite rejects crop geometry that does not correspond to the requested region', () => {
  const base = solid(6, 6, [0, 0, 0, 255]);
  const r = region([2, 2, 4, 4], { context_px: 1 });
  for (const box of [[2, 2, 4, 4], [0, 0, 6, 6], [1, 1, 5, 5.5], [1, 1, 5], { left: 1, top: 1, right: 5, bottom: 5 }, null]) {
    assert.throws(() => composite(base, base, r, box), { code: 'INVALID_INPUT' });
  }
});

test('patch resizing maps crop coordinates instead of stretching into only the writable box', () => {
  const base = solid(5, 3, [9, 8, 7, 255]);
  const patch = fixture(3, 1, [10, 20, 30, 255, 100, 110, 120, 255, 200, 210, 220, 255]);
  const r = region([2, 1, 3, 2], { context_px: 1 });
  const result = composite(base, patch, r, [1, 0, 4, 3]);
  assert.deepEqual(at(decode(result.data), 2, 1), [100, 110, 120, 255]);
  assert.deepEqual(at(decode(result.data), 1, 1), [9, 8, 7, 255]);
});

test('bilinear resize uses premultiplied alpha without a hidden-color fringe', () => {
  const base = solid(3, 1, [0, 0, 0, 0]);
  const patch = fixture(2, 1, [255, 0, 0, 255, 0, 0, 255, 0]);
  const result = composite(base, patch, region([0, 0, 3, 1]), [0, 0, 3, 1]);
  assert.deepEqual(at(decode(result.data), 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(at(decode(result.data), 1, 0), [255, 0, 0, 128]);
  assert.deepEqual(at(decode(result.data), 2, 0), [0, 0, 0, 0]);
});

test('downscaling interpolates the patch center and preserves resulting alpha', () => {
  const patch = fixture(2, 2, [200, 0, 0, 255, 200, 0, 0, 255, 0, 0, 200, 0, 0, 0, 200, 0]);
  const result = composite(solid(1, 1, [0, 0, 0, 255]), patch, region([0, 0, 1, 1]), [0, 0, 1, 1]);
  assert.deepEqual(decode(result.data).pixels, Buffer.from([200, 0, 0, 128]));
});

test('context never enlarges the write mask and every outside RGBA byte is unchanged', () => {
  const original = Buffer.from(Array.from({ length: 7 * 6 * 4 }, (_, i) => (i * 31 + 11) % 256));
  const base = fixture(7, 6, original); const before = Buffer.from(base);
  const r = region([2, 2, 5, 4], { context_px: 100 });
  const result = composite(base, solid(1, 1, [223, 37, 13, 99]), r, [0, 0, 7, 6]);
  const decoded = decode(result.data); const mask = decode(result.mask);
  assert(Buffer.isBuffer(result.mask)); assert.equal(result.width, 7); assert.equal(result.height, 6);
  assert.equal(mask.width, 7); assert.equal(mask.height, 6); assert.equal(result.outside_changed_pixels, 0);
  for (let y = 0; y < 6; y++) for (let x = 0; x < 7; x++) {
    const inside = x >= 2 && x < 5 && y >= 2 && y < 4;
    assert.deepEqual(at(mask, x, y), inside ? [255, 255, 255, 255] : [0, 0, 0, 255]);
    if (inside) assert.deepEqual(at(decoded, x, y), [223, 37, 13, 99]);
    else assert.deepEqual(at(decoded, x, y), [...original.subarray((y * 7 + x) * 4, (y * 7 + x) * 4 + 4)]);
  }
  assert.deepEqual(base, before);
});

test('feather has finite inward support and returned mask records actual blend weights', () => {
  const r = region([1, 1, 6, 6], { context_px: 1, feather_px: 2 });
  const result = composite(solid(7, 7, [0, 0, 0, 255]), solid(7, 7, [255, 255, 255, 255]), r, [0, 0, 7, 7]);
  const image = decode(result.data); const mask = decode(result.mask);
  assert.deepEqual(Array.from({ length: 7 }, (_, x) => at(mask, x, 3)[0]), [0, 85, 170, 255, 170, 85, 0]);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 7; x++) assert.deepEqual(at(image, x, y), at(mask, x, y));
});

test('soft replacement blends alpha in premultiplied space and hard replacement preserves transparent RGB', () => {
  const base = solid(3, 3, [0, 0, 255, 0]);
  const r = region([0, 0, 3, 3], { feather_px: 1 });
  const soft = decode(composite(base, solid(3, 3, [255, 0, 0, 255]), r, [0, 0, 3, 3]).data);
  assert.deepEqual(at(soft, 0, 0), [255, 0, 0, 128]);
  assert.deepEqual(at(soft, 1, 1), [255, 0, 0, 255]);
  const hard = decode(composite(base, solid(3, 3, [17, 19, 23, 0]), region([0, 0, 3, 3]), [0, 0, 3, 3]).data);
  assert.deepEqual(at(hard, 1, 1), [17, 19, 23, 0]);
});

test('overlapping regions apply sequentially with later hard-mask pixels replacing earlier ones', () => {
  const base = solid(4, 2, [0, 0, 0, 255]);
  const first = composite(base, solid(1, 1, [255, 0, 0, 255]), region([0, 0, 3, 2]), [0, 0, 3, 2]);
  const second = composite(first.data, solid(1, 1, [0, 255, 0, 255]), region([2, 0, 4, 2]), [2, 0, 4, 2]);
  assert.deepEqual(at(decode(second.data), 1, 0), [255, 0, 0, 255]);
  assert.deepEqual(at(decode(second.data), 2, 0), [0, 255, 0, 255]);
  assert.deepEqual(at(decode(crop(first.data, region([2, 0, 4, 2])).data), 0, 0), [255, 0, 0, 255]);
});

test('overlay draws distinct numbered previews without mutating the original or future crops', () => {
  const base = solid(64, 32, [11, 19, 31, 127]); const before = Buffer.from(base);
  const a = region([2, 2, 26, 30]); const b = region([34, 2, 58, 30]);
  const beforeCrop = crop(base, a).data;
  const forward = decode(overlay(base, [a, b])); const backward = decode(overlay(base, [b, a]));
  assert.notDeepEqual(forward.pixels, decode(base).pixels);
  // Swapping order changes numeral 1/2, not simply a global border.
  let changedInsideFirst = false;
  for (let y = 4; y < 20; y++) for (let x = 4; x < 20; x++) if (JSON.stringify(at(forward, x, y)) !== JSON.stringify(at(backward, x, y))) changedInsideFirst = true;
  assert(changedInsideFirst, 'the preview must carry ordinal labels');
  assert.deepEqual(at(forward, 63, 31), [11, 19, 31, 127]);
  assert.deepEqual(base, before); assert.deepEqual(crop(base, a).data, beforeCrop);
  assert.deepEqual(decode(overlay(base, [])).pixels, decode(base).pixels);
});

test('region and patch inputs are not mutated by crop, composite or overlay', () => {
  const base = solid(4, 4, [1, 2, 3, 4]); const patch = solid(1, 1, [50, 60, 70, 80]);
  const before = Buffer.from(patch);
  const r = Object.freeze({ id: 'r1', box: Object.freeze([1, 1, 3, 3]), context_px: 1, feather_px: 0 });
  const cropped = crop(base, r);
  composite(base, patch, r, Object.freeze(cropped.crop_box)); overlay(base, Object.freeze([r]));
  assert.deepEqual(patch, before);
});
