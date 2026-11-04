/** Pure canvas-pixel geometry. Predicates use doubles, not robust exact arithmetic. */
export const STUDIO_RING_MAX_POINTS = 1024;
export const STUDIO_AREA_EPSILON = 1e-6;

const COORDINATE_LIMIT = 16384;
// The v2 shape lattice is exactly 1/1024 px; 128 points per ring is the v2 cap.
const GRID_SCALE = 1024;
const GRID_RING_MAX_POINTS = 128;

function invalid(path, reason) {
  const error = new TypeError(`${path}: ${reason}`);
  error.code = 'STUDIO_INVALID_INPUT';
  error.path = path;
  throw error;
}

function checkedPath(path) {
  if (typeof path !== 'string' || !path.length) invalid('path', 'must be a nonempty string');
  return path;
}

// Read own data descriptors, never caller array iteration methods or accessor slots.
function dataArray(value, path, min, max) {
  if (!Array.isArray(value)) invalid(path, 'must be a dense data array');
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value)
      || length.value < min || length.value > max) {
    invalid(path, `must contain ${min} to ${max} entries`);
  }
  if (Reflect.ownKeys(value).length !== length.value + 1) {
    invalid(path, 'must not contain holes or extra properties');
  }
  const copy = [];
  for (let i = 0; i < length.value; i++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(i));
    if (!entry || !entry.enumerable || !Object.hasOwn(entry, 'value')) {
      invalid(`${path}[${i}]`, 'must be an own enumerable data entry');
    }
    copy.push(entry.value);
  }
  return copy;
}

function readPoint(value, path) {
  const point = dataArray(value, path, 2, 2);
  for (let i = 0; i < 2; i++) {
    if (typeof point[i] !== 'number' || !Number.isFinite(point[i])
        || Math.abs(point[i]) > COORDINATE_LIMIT) {
      invalid(`${path}[${i}]`, 'must be a finite coordinate in [-16384, 16384]');
    }
  }
  return point;
}

function readLimits(options, path) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    invalid(`${path}.options`, 'must be a plain min/max data object');
  }
  let min = 3;
  let max = STUDIO_RING_MAX_POINTS;
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'min' && key !== 'max') invalid(`${path}.options`, 'unknown option');
    const entry = Object.getOwnPropertyDescriptor(options, key);
    if (!entry || !entry.enumerable || !Object.hasOwn(entry, 'value')
        || !Number.isSafeInteger(entry.value) || entry.value < 3
        || entry.value > STUDIO_RING_MAX_POINTS) {
      invalid(`${path}.options.${key}`, 'must be an integer from 3 through 1024');
    }
    if (key === 'min') min = entry.value;
    else max = entry.value;
  }
  if (min > max) invalid(`${path}.options`, 'min must not exceed max');
  return { min, max };
}

function samePoint(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(a, b, p) {
  return cross(a, b, p) === 0
    && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
    && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}

function segmentsMeet(a, b, c, d) {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0])
      || Math.max(c[0], d[0]) < Math.min(a[0], b[0])
      || Math.max(a[1], b[1]) < Math.min(c[1], d[1])
      || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false;
  const abC = cross(a, b, c), abD = cross(a, b, d);
  const cdA = cross(c, d, a), cdB = cross(c, d, b);
  if (abC === 0 && onSegment(a, b, c) || abD === 0 && onSegment(a, b, d)
      || cdA === 0 && onSegment(c, d, a) || cdB === 0 && onSegment(c, d, b)) return true;
  return (abC > 0 && abD < 0 || abC < 0 && abD > 0)
    && (cdA > 0 && cdB < 0 || cdA < 0 && cdB > 0);
}

function signedArea(points) {
  // Translate every triangle to the first vertex; compensate summation as well.
  let twiceArea = 0, correction = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const term = cross(points[0], points[i], points[i + 1]) - correction;
    const next = twiceArea + term;
    correction = (next - twiceArea) - term;
    twiceArea = next;
  }
  return twiceArea / 2;
}

function isConvex(points, strict = false) {
  let sign = 0;
  for (let i = 0; i < points.length; i++) {
    const turn = Math.sign(cross(points[i], points[(i + 1) % points.length],
      points[(i + 2) % points.length]));
    if (turn === 0) {
      if (strict) return false;
    } else {
      if (sign !== 0 && turn !== sign) return false;
      sign = turn;
    }
  }
  return sign !== 0;
}

/** Validate an open simple ring without repairing, clamping, or reordering it. */
export function validateStudioRing(value, path = 'ring', options = {}) {
  checkedPath(path);
  const { min, max } = readLimits(options, path);
  const entries = dataArray(value, path, min, max);
  const points = entries.map((point, i) => readPoint(point, `${path}[${i}]`));
  const count = points.length;
  if (samePoint(points[0], points[count - 1])) invalid(path, 'duplicated closing vertex');
  for (let i = 1; i < count; i++) {
    if (samePoint(points[i - 1], points[i])) invalid(`${path}[${i}]`, 'adjacent duplicate vertex');
  }
  // An entirely collinear ring is degenerate, even though its wrap-around reverses.
  if (points.every(point => cross(points[0], points[1], point) === 0)) {
    invalid(path, 'degenerate ring');
  }
  for (let i = 0; i < count; i++) {
    const a = points[(i + count - 1) % count], b = points[i], c = points[(i + 1) % count];
    if (cross(a, b, c) === 0
        && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) {
      invalid(`${path}[${i}]`, 'adjacent edges reverse along the same line');
    }
  }
  // Adjacent edges share their intended endpoint; all other contacts are invalid.
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (j === i + 1 || i === 0 && j === count - 1) continue;
      if (segmentsMeet(points[i], points[(i + 1) % count], points[j], points[(j + 1) % count])) {
        invalid(path, `nonadjacent edges ${i} and ${j} intersect, touch, or overlap`);
      }
    }
  }
  if (Math.abs(signedArea(points)) <= STUDIO_AREA_EPSILON) invalid(path, 'degenerate ring area');
  return points;
}

/** Exactly four corners, with a nonzero turn of one sign at every corner. */
export function validateStudioQuad(value, path = 'quad') {
  const points = validateStudioRing(value, path, { min: 4, max: 4 });
  if (!isConvex(points, true)) invalid(path, 'quad must have strictly convex corners');
  return points;
}

export function studioRingSignedArea(ring) {
  return signedArea(validateStudioRing(ring));
}

/** Positive signed area is clockwise on a y-down canvas. */
export function studioRingOrientation(ring) {
  return signedArea(validateStudioRing(ring)) > 0 ? 'cw' : 'ccw';
}

export function orientStudioRing(ring, orientation) {
  if (orientation !== 'cw' && orientation !== 'ccw') invalid('orientation', 'must be cw or ccw');
  const points = validateStudioRing(ring);
  if ((signedArea(points) > 0 ? 'cw' : 'ccw') === orientation) return points;
  return [points[0], ...points.slice(1).reverse()];
}

export function studioRingBounds(ring) {
  const points = validateStudioRing(ring);
  let minX = points[0][0], minY = points[0][1], maxX = minX, maxY = minY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}

export function studioPointInRing(ring, point) {
  const points = validateStudioRing(ring), query = readPoint(point, 'point');
  let winding = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (onSegment(a, b, query)) return 'boundary';
    const turn = cross(a, b, query);
    if (a[1] <= query[1] && b[1] > query[1] && turn > 0) winding++;
    else if (a[1] > query[1] && b[1] <= query[1] && turn < 0) winding--;
  }
  return winding === 0 ? 'outside' : 'inside';
}

export function studioRingIsConvex(ring) {
  return isConvex(validateStudioRing(ring));
}

function readGridOptions(options, path) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    invalid(`${path}.options`, 'must be a plain max data object');
  }
  let max = GRID_RING_MAX_POINTS;
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'max') invalid(`${path}.options`, 'unknown option');
    const entry = Object.getOwnPropertyDescriptor(options, key);
    if (!entry || !entry.enumerable || !Object.hasOwn(entry, 'value')
      || !Number.isSafeInteger(entry.value) || entry.value < 3 || entry.value > GRID_RING_MAX_POINTS) {
      invalid(`${path}.options.max`, `must be an integer from 3 through ${GRID_RING_MAX_POINTS}`);
    }
    max = entry.value;
  }
  return max;
}

/**
 * One coordinate of the 1/1024 px lattice. -0 is not a lattice member (it would
 * serialize differently while comparing equal), and off-lattice values keep their
 * original value: only the nearest lattice value is reported, never substituted.
 */
function readGridCoordinate(coordinate, path) {
  if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)
    || Math.abs(coordinate) > COORDINATE_LIMIT) {
    invalid(path, 'must be a finite coordinate in [-16384, 16384]');
  }
  if (Object.is(coordinate, -0)) invalid(path, 'must not be negative zero');
  // Scaling by a power of two is exact here, so this integer test is exact too.
  const scaled = coordinate * GRID_SCALE;
  if (!Number.isInteger(scaled)) {
    const nearest = Math.round(scaled) / GRID_SCALE;
    invalid(path, `must be on the 1/1024 grid (nearest grid value ${nearest})`);
  }
  return coordinate;
}

function readGridPoint(value, path) {
  const point = dataArray(value, path, 2, 2);
  return point.map((coordinate, index) => readGridCoordinate(coordinate, `${path}[${index}]`));
}

/**
 * Linear-only v2 ring parse: structure, numeric bounds, -0 and lattice membership.
 * Returns detached pairs; winding, start vertex and magnitude are preserved.
 * Simplicity is a separate assertion so every caller can finish all linear checks first.
 */
export function parseStudioGridRing(value, path = 'ring', options = { max: GRID_RING_MAX_POINTS }) {
  checkedPath(path);
  const max = readGridOptions(options, path);
  const entries = dataArray(value, path, 3, max);
  return entries.map((point, index) => readGridPoint(point, `${path}[${index}]`));
}

// Scaled lattice coordinates are integers with |v| <= 2^24, so differences are
// <= 2^25, products <= 2^50 and cross sums <= 2^51: every below step is exact
// IEEE-754 integer arithmetic. Twice-area uses BigInt because the brief requires it.
function scaled(point) {
  return [point[0] * GRID_SCALE, point[1] * GRID_SCALE];
}

function crossInt(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegmentInt(a, b, p) {
  return crossInt(a, b, p) === 0
    && p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0])
    && p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}

function segmentsMeetInt(a, b, c, d) {
  if (Math.max(a[0], b[0]) < Math.min(c[0], d[0])
    || Math.max(c[0], d[0]) < Math.min(a[0], b[0])
    || Math.max(a[1], b[1]) < Math.min(c[1], d[1])
    || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) return false;
  const abC = crossInt(a, b, c), abD = crossInt(a, b, d);
  const cdA = crossInt(c, d, a), cdB = crossInt(c, d, b);
  if (abC === 0 && onSegmentInt(a, b, c) || abD === 0 && onSegmentInt(a, b, d)
    || cdA === 0 && onSegmentInt(c, d, a) || cdB === 0 && onSegmentInt(c, d, b)) return true;
  return (abC > 0 && abD < 0 || abC < 0 && abD > 0)
    && (cdA > 0 && cdB < 0 || cdA < 0 && cdB > 0);
}

function twiceAreaInt(points) {
  let sum = 0n;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
    sum += BigInt(x1) * BigInt(y2) - BigInt(x2) * BigInt(y1);
  }
  return sum;
}

/**
 * Grid topology guard for an already-parsed v2 ring. The lattice makes the
 * cross/segment predicates exact; area is a BigInt twice-area, so a legal
 * micro-triangle under the legacy EPS threshold is accepted (that is the point).
 * Input is re-read through parseStudioGridRing so a hostile array cannot lie.
 */
export function assertStudioRingSimple(parsedGridPoints, path = 'ring') {
  const points = parseStudioGridRing(parsedGridPoints, path);
  const lattice = points.map(scaled);
  const count = lattice.length;
  if (samePoint(lattice[0], lattice[count - 1])) invalid(path, 'duplicated closing vertex');
  for (let i = 1; i < count; i++) {
    if (samePoint(lattice[i - 1], lattice[i])) invalid(`${path}[${i}]`, 'adjacent duplicate vertex');
  }
  for (let i = 0; i < count; i++) {
    const a = lattice[(i + count - 1) % count], b = lattice[i], c = lattice[(i + 1) % count];
    if (crossInt(a, b, c) === 0
      && (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) < 0) {
      invalid(`${path}[${i}]`, 'adjacent edges reverse along the same line');
    }
  }
  for (let i = 0; i < count; i++) {
    for (let j = i + 1; j < count; j++) {
      if (j === i + 1 || i === 0 && j === count - 1) continue;
      if (segmentsMeetInt(lattice[i], lattice[(i + 1) % count],
        lattice[j], lattice[(j + 1) % count])) {
        invalid(path, `nonadjacent edges ${i} and ${j} intersect, touch, or overlap`);
      }
    }
  }
  if (twiceAreaInt(lattice) === 0n) invalid(path, 'degenerate ring area');
  return points;
}
