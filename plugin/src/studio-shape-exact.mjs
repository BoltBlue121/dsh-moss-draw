/** Bounded exact grid arithmetic and deterministic plain-data evidence. No document writes. */
import { parseStudioGridRing, assertStudioRingSimple } from './studio-geometry.mjs';

export const STUDIO_SHAPE_GRID = 1024;
export const STUDIO_SHAPE_EXACT_VERSION = 1;
export const STUDIO_SHAPE_ERROR_CODES = Object.freeze([
  'STUDIO_INVALID_INPUT', 'STUDIO_SHAPE_RANGE', 'STUDIO_SHAPE_BUDGET',
  'STUDIO_SHAPE_QUANTIZE_DEGENERATE', 'STUDIO_SHAPE_QUANTIZE_INVALID',
]);
const [INVALID, RANGE, BUDGET, DEGENERATE, QUANTIZE_INVALID] = STUDIO_SHAPE_ERROR_CODES;
const brands = new WeakSet();
const LIMIT = 16777216n;
const abs = n => n < 0n ? -n : n;
const sign = n => n < 0n ? -1 : n > 0n ? 1 : 0;

function fail(code, reason, path = 'shape') {
  const error = new TypeError(`Studio shape exact: ${reason}`);
  error.code = code;
  error.path = path;
  error.reason = reason;
  throw error;
}
function pathOf(path) {
  if (typeof path !== 'string' || !path.length || path.length > 160 || /[\x00-\x1f\x7f-\x9f]/.test(path)) {
    fail(INVALID, 'path', 'path');
  }
  return path;
}
function bits(n, limit = 16384, path = 'shape') {
  if (abs(n).toString(2).length > limit && n !== 0n) fail(BUDGET, 'bit_budget', path);
  return n;
}
function gcd(a, b) {
  a = abs(a); b = abs(b);
  while (b !== 0n) { const next = a % b; a = b; b = next; }
  return a;
}
// Internal construction permits bounded reducible temporaries, unlike the public raw entrance.
function rational(n, d) {
  bits(n, 32770); bits(d, 32770);
  if (d < 0n) { n = -n; d = -d; }
  if (n === 0n) d = 1n;
  else { const g = gcd(n, d); n /= g; d /= g; }
  bits(n); bits(d);
  const result = Object.freeze({ n, d });
  brands.add(result);
  return result;
}
function branded(value) {
  if (!brands.has(value)) fail(INVALID, 'brand');
  return value;
}
export function studioRational(n, d = 1n) {
  if (typeof n !== 'bigint' || typeof d !== 'bigint') fail(INVALID, 'type');
  if (d === 0n) fail(INVALID, 'zero_denominator');
  bits(n); bits(d);
  return rational(n, d);
}
function add(a, b, subtract) {
  branded(a); branded(b);
  const g = gcd(a.d, b.d), ad = a.d / g, bd = b.d / g;
  const left = bits(a.n * bd, 32770), right = bits(b.n * ad, 32770);
  const n = bits(subtract ? left - right : left + right, 32770);
  // Cancel the shared denominator factor before constructing the result.
  const h = gcd(n, g);
  return rational(n / h, bits(ad * (b.d / h), 32770));
}
export function studioRatAdd(a, b) { return add(a, b, false); }
export function studioRatSub(a, b) { return add(a, b, true); }
export function studioRatMul(a, b) {
  branded(a); branded(b);
  const g = gcd(a.n, b.d), h = gcd(b.n, a.d);
  return rational(bits((a.n / g) * (b.n / h), 32770), bits((a.d / h) * (b.d / g), 32770));
}
export function studioRatDiv(a, b) {
  branded(a); branded(b);
  if (b.n === 0n) fail(INVALID, 'divide_by_zero');
  const g = gcd(a.n, b.n), h = gcd(a.d, b.d);
  return rational(bits((a.n / g) * (b.d / h), 32770), bits((a.d / h) * (b.n / g), 32770));
}
export function studioRatNeg(a) { branded(a); return rational(-a.n, a.d); }
export function studioRatCmp(a, b) {
  branded(a); branded(b);
  const g = gcd(a.d, b.d);
  const left = bits(a.n * (b.d / g), 32770), right = bits(b.n * (a.d / g), 32770);
  return left < right ? -1 : left > right ? 1 : 0;
}
export function studioRatSign(a) { branded(a); return sign(a.n); }
export function studioRoundHalfEven(r) {
  branded(r);
  const { n, d } = r, a = abs(n), q = a / d, rem = a % d;
  const twice = bits(2n * rem, 32770);
  const rounded = twice > d || (twice === d && (q & 1n) === 1n) ? q + 1n : q;
  return bits(n < 0n ? -rounded : rounded);
}
function isqrt(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  while (true) {
    const y = (x + n / x) / 2n;
    if (y >= x) return x;
    x = y;
  }
}
export function studioRoundHalfEvenSqrt(r, N) {
  branded(r);
  if (typeof N !== 'bigint') fail(INVALID, 'type');
  if (r.n < 0n || N < 0n) fail(RANGE, 'negative_radical');
  bits(N, 128);
  if (N === 0n || r.n === 0n) return 0n;
  const n2 = bits(r.n * r.n, 33028), Q = bits(n2 * N, 33028);
  const k = isqrt(Q) / r.d;
  const lhs = bits(4n * Q, 33028);
  const d2 = bits(r.d * r.d, 33028), mid = bits(2n * k + 1n, 33028);
  const mid2 = bits(mid * mid, 33028), rhs = bits(d2 * mid2, 33028);
  return bits(lhs > rhs || (lhs === rhs && (k & 1n) === 1n) ? k + 1n : k);
}

function ownData(value, key, path) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(INVALID, 'structure', path);
  return descriptor.value;
}
// Check count before reading indices or starting quadratic geometry work.
function dataArray(value, min, max, path, countReason = 'point_budget') {
  if (!Array.isArray(value)) fail(INVALID, 'structure', path);
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < min) {
    fail(INVALID, 'structure', path);
  }
  if (length.value > max) fail(BUDGET, countReason, path);
  if (Reflect.ownKeys(value).length !== length.value + 1) fail(INVALID, 'structure', path);
  const copy = [];
  for (let i = 0; i < length.value; i++) copy.push(ownData(value, String(i), path));
  return copy;
}
function pointPair(value, path) {
  // Pair size is structure, not a point-count resource budget.
  if (!Array.isArray(value)) fail(INVALID, 'structure', path);
  const d = Object.getOwnPropertyDescriptor(value, 'length');
  if (!d || d.value !== 2) fail(INVALID, 'structure', path);
  return dataArray(value, 2, 2, path);
}
function latticePoints(value, path) {
  return dataArray(value, 3, 128, path).map(point => pointPair(point, path).map(v => {
    if (typeof v !== 'bigint') fail(INVALID, 'type', path);
    if (v < -LIMIT || v > LIMIT) fail(RANGE, 'coordinate_range', path);
    return v;
  }));
}
function ratPoints(value, path) {
  return dataArray(value, 3, 256, path).map(point => pointPair(point, path).map(v => {
    branded(v);
    if (abs(v.n) > LIMIT * v.d) fail(RANGE, 'coordinate_range', path);
    return v;
  }));
}
function twiceArea(points) {
  let sum = 0n;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}
function rationalArea(points) {
  let sum = studioRational(0n);
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const term = studioRatSub(studioRatMul(a[0], b[1]), studioRatMul(b[0], a[1]));
    sum = studioRatAdd(sum, term);
  }
  return sum;
}
export function studioLatticeRing(ring, path = 'ring') {
  pathOf(path);
  // Do not let the legacy geometry classify a resource failure as invalid input.
  const entries = dataArray(ring, 3, 128, path);
  const px = assertStudioRingSimple(parseStudioGridRing(entries, path), path);
  const points = px.map(([x, y]) => [BigInt(x * 1024), BigInt(y * 1024)]);
  return { points, twice_area: twiceArea(points) };
}
export function studioRingFromLattice(points, path = 'ring') {
  pathOf(path);
  const lattice = latticePoints(points, path);
  return assertStudioRingSimple(lattice.map(([x, y]) => [Number(x) / 1024, Number(y) / 1024]), path);
}
export function studioTwiceAreaRational(points) { return rationalArea(ratPoints(points, 'ring')); }
function record(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(INVALID, 'structure', path);
}
function quantizePath(options) {
  record(options, 'options');
  let path = 'ring';
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'path') fail(INVALID, 'structure', 'options');
    path = ownData(options, key, 'options');
  }
  return pathOf(path);
}
const same = (a, b) => a[0] === b[0] && a[1] === b[1];
export function quantizeStudioPolygon(ratInput, options = {}) {
  const path = quantizePath(options), points = ratPoints(ratInput, path);
  const twice_area_exact = rationalArea(points);
  if (twice_area_exact.n === 0n) fail(DEGENERATE, 'zero_area', path);
  let max_component_shift = studioRational(0n);
  const rounded = points.map(point => point.map(v => {
    const k = studioRoundHalfEven(v);
    if (k < -LIMIT || k > LIMIT) fail(RANGE, 'coordinate_range', path);
    let shift = studioRatSub(studioRational(k), v);
    if (shift.n < 0n) shift = studioRatNeg(shift);
    if (studioRatCmp(shift, max_component_shift) > 0) max_component_shift = shift;
    return k;
  }));
  const lattice = [], merged_vertices = [], indices = [];
  for (let i = 0; i < rounded.length; i++) {
    if (lattice.length && same(lattice[lattice.length - 1], rounded[i])) merged_vertices.push(i);
    else { lattice.push(rounded[i]); indices.push(i); }
  }
  if (lattice.length > 1 && same(lattice[0], lattice[lattice.length - 1])) {
    lattice.pop(); merged_vertices.push(indices.pop());
  }
  merged_vertices.sort((a, b) => a - b);
  if (lattice.length < 3) fail(DEGENERATE, 'too_few_vertices', path);
  const twice_area_grid = twiceArea(lattice);
  if (twice_area_grid === 0n) fail(DEGENERATE, 'zero_area', path);
  if (lattice.length > 128) fail(BUDGET, 'point_budget', path);
  if (sign(twice_area_grid) !== sign(twice_area_exact.n)) fail(QUANTIZE_INVALID, 'orientation_flip', path);
  let ring;
  try { ring = studioRingFromLattice(lattice, path); }
  catch (error) {
    if (error.code === INVALID) fail(QUANTIZE_INVALID, 'topology', path);
    throw error;
  }
  return { ring, lattice, twice_area_exact, twice_area_grid, merged_vertices, max_component_shift };
}
function pieceKey(prefix, points, coordinate) {
  const tokens = [prefix];
  let length = prefix.length;
  for (let i = 0; i < points.length; i++) {
    const token = `${i ? ';' : ''}${coordinate(points[i][0])},${coordinate(points[i][1])}`;
    length += token.length;
    if (length > 65536) fail(BUDGET, 'piece_key_budget');
    tokens.push(token);
  }
  return tokens.join('');
}
export function studioShapePieceKey(lattice) {
  const points = latticePoints(lattice, 'ring');
  studioRingFromLattice(points);
  return pieceKey('g1:', points, v => v.toString());
}
export function studioRationalPieceKey(points) {
  return pieceKey('r1:', ratPoints(points, 'ring'), v => `${v.n}/${v.d}`);
}

export function studioShapeReportJSON(report) {
  const stack = new Set(), tokens = [], encoder = new TextEncoder();
  let nodes = 0, bytes = 0;
  function token(text) {
    bytes += encoder.encode(text).length;
    if (bytes > 1048576) fail(BUDGET, 'output_budget', 'report');
    tokens.push(text);
  }
  function string(value) {
    if (value.length > 65536) fail(BUDGET, 'string_budget', 'report');
    token(JSON.stringify(value));
  }
  function visit(value, depth, approximate = false) {
    if (depth > 16) fail(BUDGET, 'depth_budget', 'report');
    if (++nodes > 65536) fail(BUDGET, 'node_budget', 'report');
    if (brands.has(value)) { string(`${value.n}/${value.d}`); return; }
    if (typeof value === 'bigint') { bits(value); string(value.toString()); return; }
    if (typeof value === 'string') { string(value); return; }
    if (value === null || typeof value === 'boolean') { token(JSON.stringify(value)); return; }
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (!Number.isSafeInteger(value) && !approximate)) fail(INVALID, 'unsupported_number', 'report');
      token(JSON.stringify(value === 0 ? 0 : value)); return;
    }
    if (typeof value !== 'object') fail(INVALID, 'type', 'report');
    if (stack.has(value)) fail(INVALID, 'structure', 'report');
    stack.add(value);
    if (Array.isArray(value)) {
      const entries = dataArray(value, 0, 65536, 'report', 'node_budget');
      token('[');
      for (let i = 0; i < entries.length; i++) {
        if (i) token(',');
        visit(entries[i], depth + 1);
      }
      token(']');
    } else {
      record(value, 'report');
      const keys = Reflect.ownKeys(value);
      if (nodes + keys.length > 65536) fail(BUDGET, 'node_budget', 'report');
      const entries = [];
      for (const key of keys) {
        if (typeof key !== 'string' || key === 'toJSON') fail(INVALID, 'structure', 'report');
        if (key.length > 4096) fail(BUDGET, 'key_budget', 'report');
        entries.push([key, ownData(value, key, 'report')]);
      }
      entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
      token('{');
      for (let i = 0; i < entries.length; i++) {
        const [key, child] = entries[i];
        if (i) token(',');
        token(JSON.stringify(key)); token(':');
        visit(child, depth + 1, key.endsWith('_approx'));
      }
      token('}');
    }
    stack.delete(value);
  }
  visit(report, 0);
  return tokens.join('');
}
