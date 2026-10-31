import { deflateSync } from 'node:zlib';
import { validatePng } from './comfy.mjs';
import { fault } from './catalog.mjs';

const MAX_PIXELS = 4_500_000;
const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  return value >>> 0;
});
function chunk(type, data) {
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length); output.write(type, 4, 4, 'ascii'); data.copy(output, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < output.length - 4; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ output[i]) & 255];
  output.writeUInt32BE((crc ^ 0xffffffff) >>> 0, output.length - 4);
  return output;
}
function dimensions(width, height) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0 && width * height <= MAX_PIXELS;
}

/** Decode the existing validator's non-interlaced, 8-bit RGB/RGBA PNG subset. */
export function decodePng(data) {
  if (!Buffer.isBuffer(data) || data.length < 24) throw fault('INVALID_ARTIFACT', 'Invalid region PNG.');
  const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
  if (!dimensions(width, height)) throw fault('INVALID_ARTIFACT', 'Region PNG must contain 1..4500000 pixels.');
  const decoded = validatePng(data, { width, height }, { pixels: true, maxPixels: MAX_PIXELS });
  if (decoded.channels === 4) return decoded;
  const pixels = Buffer.alloc(width * height * 4);
  for (let source = 0, target = 0; source < decoded.pixels.length; source += 3, target += 4) {
    pixels[target] = decoded.pixels[source]; pixels[target + 1] = decoded.pixels[source + 1]; pixels[target + 2] = decoded.pixels[source + 2]; pixels[target + 3] = 255;
  }
  return { width, height, channels: 4, pixels };
}

/** Encode straight-alpha RGBA bytes without modifying or premultiplying them. */
export function encodePng(image) {
  if (!image || !dimensions(image.width, image.height) || !Buffer.isBuffer(image.pixels) || image.pixels.length !== image.width * image.height * 4) throw fault('INVALID_INPUT', 'Expected a bounded RGBA pixel buffer.');
  const { width, height, pixels } = image;
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rowBytes = width * 4;
  const raw = Buffer.alloc((rowBytes + 1) * height); // Filter 0: byte-exact and independent of adjacent rows.
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  return Buffer.concat([SIGNATURE, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

function checkBox(box, width, height) {
  if (!Array.isArray(box) || box.length !== 4) throw fault('INVALID_INPUT', 'Region box must be [left,top,right,bottom].');
  for (let i = 0; i < 4; i++) if (!Number.isSafeInteger(box[i])) throw fault('INVALID_INPUT', 'Region coordinates must be integers.');
  const [left, top, right, bottom] = box;
  if (left < 0 || top < 0 || right > width || bottom > height || left >= right || top >= bottom) throw fault('INVALID_INPUT', 'Region box must be nonempty and inside the image.');
}
function geometry(region, width, height) {
  if (!region || typeof region !== 'object' || Array.isArray(region)) throw fault('INVALID_INPUT', 'Expected a region object.');
  checkBox(region.box, width, height);
  const context = region.context_px === undefined ? 0 : region.context_px;
  const feather = region.feather_px === undefined ? 0 : region.feather_px;
  if (!Number.isSafeInteger(context) || context < 0 || !Number.isSafeInteger(feather) || feather < 0) throw fault('INVALID_INPUT', 'context_px and feather_px must be nonnegative integers.');
  const [left, top, right, bottom] = region.box;
  // Clamp margins before addition, even if a caller supplied MAX_SAFE_INTEGER.
  const crop_box = [left - Math.min(context, left), top - Math.min(context, top), right + Math.min(context, width - right), bottom + Math.min(context, height - bottom)];
  return { box: [left, top, right, bottom], crop_box, feather };
}

/** Context is read-only input surrounding the half-open writable box. */
export function regionCrop(baseBuffer, region) {
  const base = decodePng(baseBuffer);
  const { crop_box } = geometry(region, base.width, base.height);
  const [left, top, right, bottom] = crop_box;
  const width = right - left, height = bottom - top;
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = ((top + y) * base.width + left) * 4;
    base.pixels.copy(pixels, y * width * 4, start, start + width * 4);
  }
  return { data: encodePng({ width, height, pixels }), width, height, crop_box };
}

// Pixel-center bilinear interpolation in premultiplied-alpha space prevents
// RGB hidden under transparent pixels from bleeding into visible edges.
function resize(image, width, height) {
  if (image.width === width && image.height === height) return image.pixels;
  const result = Buffer.alloc(width * height * 4);
  const source = image.pixels;
  for (let y = 0; y < height; y++) {
    const sy = Math.max(0, Math.min(image.height - 1, (y + 0.5) * image.height / height - 0.5));
    const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, image.height - 1), fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(image.width - 1, (x + 0.5) * image.width / width - 0.5));
      const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, image.width - 1), fx = sx - x0;
      const a = (y0 * image.width + x0) * 4, b = (y0 * image.width + x1) * 4;
      const c = (y1 * image.width + x0) * 4, d = (y1 * image.width + x1) * 4;
      const wa = (1 - fx) * (1 - fy) * source[a + 3], wb = fx * (1 - fy) * source[b + 3];
      const wc = (1 - fx) * fy * source[c + 3], wd = fx * fy * source[d + 3];
      const alpha = wa + wb + wc + wd, target = (y * width + x) * 4;
      result[target + 3] = Math.round(alpha);
      if (alpha > 0) for (let channel = 0; channel < 3; channel++) result[target + channel] = Math.round((source[a + channel] * wa + source[b + channel] * wb + source[c + channel] * wc + source[d + channel] * wd) / alpha);
    }
  }
  return result;
}

/**
 * Replace only box pixels. Mask is full-canvas PNG: RGB=weight, alpha=255,
 * black=keep, white=replace. Feather ramps inward over feather_px edge pixels;
 * weight=min(1, distance-to-first-outside-pixel/(feather_px+1)), quantized to 8 bits.
 * The same quantized weight drives the premultiplied-alpha replacement blend.
 */
export function regionComposite(baseBuffer, patchBuffer, region, crop_box) {
  const base = decodePng(baseBuffer);
  const shape = geometry(region, base.width, base.height);
  checkBox(crop_box, base.width, base.height);
  for (let i = 0; i < 4; i++) if (crop_box[i] !== shape.crop_box[i]) throw fault('INVALID_INPUT', 'crop_box must match the region context crop.');
  const width = base.width, height = base.height;
  const cropWidth = crop_box[2] - crop_box[0], cropHeight = crop_box[3] - crop_box[1];
  const patch = resize(decodePng(patchBuffer), cropWidth, cropHeight);
  const result = Buffer.from(base.pixels);
  const mask = Buffer.alloc(width * height * 4).fill(Buffer.from([0, 0, 0, 255]));
  const [left, top, right, bottom] = shape.box;
  // Never loop over context pixels for writes: even hidden RGB outside the mask
  // remains an exact copy of the base, independent of patch alpha or resizing.
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const target = (y * width + x) * 4;
    const source = ((y - crop_box[1]) * cropWidth + x - crop_box[0]) * 4;
    const distance = Math.min(x - left + 1, right - x, y - top + 1, bottom - y);
    const weight = shape.feather === 0 ? 255 : Math.round(255 * Math.min(1, distance / (shape.feather + 1)));
    mask[target] = mask[target + 1] = mask[target + 2] = weight;
    if (weight === 0) continue;
    if (weight === 255) {
      patch.copy(result, target, source, source + 4);
      continue;
    }
    const patchAlpha = patch[source + 3] * weight / 255;
    const baseAlpha = base.pixels[target + 3] * (255 - weight) / 255;
    const alpha = patchAlpha + baseAlpha;
    result[target + 3] = Math.round(alpha);
    for (let channel = 0; channel < 3; channel++) result[target + channel] = alpha > 0 ? Math.round((patch[source + channel] * patchAlpha + base.pixels[target + channel] * baseAlpha) / alpha) : 0;
  }
  return { data: encodePng({ width, height, pixels: result }), mask: encodePng({ width, height, pixels: mask }), width, height, outside_changed_pixels: 0 };
}

const DIGITS = [
  ['111', '101', '101', '101', '111'], ['010', '110', '010', '010', '111'],
  ['111', '001', '111', '100', '111'], ['111', '001', '111', '001', '111'],
  ['101', '101', '111', '001', '001'], ['111', '100', '111', '001', '111'],
  ['111', '100', '111', '101', '111'], ['111', '001', '010', '010', '010'],
  ['111', '101', '111', '101', '111'], ['111', '101', '111', '001', '111'],
];

/** Preview only. Callers must retain the original PNG as generation input. */
export function regionOverlay(baseBuffer, regions) {
  const base = decodePng(baseBuffer);
  if (!Array.isArray(regions)) throw fault('INVALID_INPUT', 'Expected a region array.');
  const shapes = Array.from(regions, region => geometry(region, base.width, base.height));
  const pixels = Buffer.from(base.pixels);
  const scale = Math.max(1, Math.min(6, Math.ceil(Math.min(base.width, base.height) / 160)));
  const orange = [255, 180, 40], white = [255, 255, 255], black = [20, 20, 20];
  function rectangle(left, top, right, bottom, color) {
    for (let y = Math.max(0, top); y < Math.min(base.height, bottom); y++) for (let x = Math.max(0, left); x < Math.min(base.width, right); x++) {
      const i = (y * base.width + x) * 4;
      pixels[i] = color[0]; pixels[i + 1] = color[1]; pixels[i + 2] = color[2]; pixels[i + 3] = 255;
    }
  }
  shapes.forEach(({ box: [left, top, right, bottom] }, index) => {
    rectangle(left, top, right, Math.min(bottom, top + scale), orange);
    rectangle(left, Math.max(top, bottom - scale), right, bottom, orange);
    rectangle(left, top, Math.min(right, left + scale), bottom, orange);
    rectangle(Math.max(left, right - scale), top, right, bottom, orange);
    const label = String(index + 1), badgeWidth = (label.length * 4 + 1) * scale, badgeHeight = 7 * scale;
    const bx = Math.max(0, Math.min(left + 2 * scale, base.width - badgeWidth));
    const by = Math.max(0, Math.min(top + 2 * scale, base.height - badgeHeight));
    rectangle(bx, by, bx + badgeWidth, by + badgeHeight, black);
    [...label].forEach((digit, position) => DIGITS[Number(digit)].forEach((row, y) => {
      for (let x = 0; x < 3; x++) if (row[x] === '1') {
        const px = bx + (1 + position * 4 + x) * scale, py = by + (1 + y) * scale;
        rectangle(px, py, px + scale, py + scale, white);
      }
    }));
  });
  return encodePng({ width: base.width, height: base.height, pixels });
}
