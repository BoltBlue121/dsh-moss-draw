/** Independent perspective blockout math; no image reconstruction or external dependencies. */
export const DEFAULT_CAMERA = Object.freeze({ orbit: 0, pitch: 0, roll: 0, distance: 5, fov: 50, pan_x: 0, pan_y: 0, pan_z: 0 });

const DEGREES = Math.PI / 180;
const NEAR_PLANE = 0.01;
const MAX_WORLD = 1000;
const MAX_PIXELS = 4_500_000;
const CAMERA_RANGES = {
  orbit: [-180, 180], pitch: [-85, 85], roll: [-180, 180], distance: [0.1, 100],
  fov: [10, 120], pan_x: [-100, 100], pan_y: [-100, 100], pan_z: [-100, 100],
};
const BODY_KEYS = ['x', 'y', 'z', 'width', 'height', 'depth', 'yaw'];
const BODY_DEFAULTS = { z: 0, depth: 0, yaw: 0 };
// Each z face: top-left, top-right, bottom-right, bottom-left before yaw.
const CORNER_SIGNS = [
  [-1, 1, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1],
  [-1, 1, 1], [1, 1, 1], [1, -1, 1], [-1, -1, 1],
];
const EDGES = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];

function invalid(message) {
  const error = new TypeError(message);
  error.code = 'INVALID_INPUT';
  throw error;
}
function record(value, label, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    invalid(`${label} must be a plain object.`);
  }
  if (keys) for (const key of Reflect.ownKeys(value)) {
    if (!keys.includes(key)) invalid(`Unknown ${label} field: ${String(key)}.`);
  }
  return value;
}
function number(value, label, min, max, exclusiveMin = false) {
  if (typeof value !== 'number' || !Number.isFinite(value)
    || (exclusiveMin ? value <= min : value < min) || value > max) {
    invalid(`${label} must be a finite number ${exclusiveMin ? '>' : '>='} ${min} and <= ${max}.`);
  }
  return value;
}
function dimensions(canvas) {
  record(canvas, 'canvas'); // A document canvas may also contain its opaque reference.
  const { width, height } = canvas;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width * height > MAX_PIXELS) invalid('Canvas must have positive integer dimensions and at most 4500000 pixels.');
  return { width, height };
}
function boxCoordinates(box) {
  if (!Array.isArray(box) || box.length !== 4) invalid('Box must be [left, top, right, bottom].');
  for (const coordinate of box) number(coordinate, 'Box coordinate', -Number.MAX_VALUE, Number.MAX_VALUE);
  const [left, top, right, bottom] = box;
  if (left >= right || top >= bottom) invalid('Box must have positive width and height.');
  return [left, top, right, bottom];
}

/** Missing camera fields default; explicitly invalid/undefined fields never coerce or clamp. */
export function validateCamera(camera) {
  record(camera, 'camera', Object.keys(CAMERA_RANGES));
  const result = {};
  for (const [key, [min, max]] of Object.entries(CAMERA_RANGES)) {
    result[key] = number(Object.hasOwn(camera, key) ? camera[key] : DEFAULT_CAMERA[key], key, min, max);
  }
  return result;
}

/** Center-based world geometry. Only z, depth and yaw may be omitted. */
export function validateBody(body) {
  record(body, 'body', BODY_KEYS);
  const result = {};
  for (const key of BODY_KEYS) {
    const value = Object.hasOwn(body, key) ? body[key] : BODY_DEFAULTS[key];
    const size = key === 'width' || key === 'height';
    const min = size || key === 'depth' ? 0 : key === 'yaw' ? -180 : -MAX_WORLD;
    result[key] = number(value, key, min, key === 'yaw' ? 180 : MAX_WORLD, size);
  }
  return result;
}

/** Half-open pixel boundaries, not pixel centers. Uses the default z=0 framing scale. */
export function bodyFromBox(box, canvas, options = {}) {
  const { width, height } = dimensions(canvas);
  const [left, top, right, bottom] = boxCoordinates(box);
  record(options, 'body options', ['z', 'depth', 'yaw']);
  const worldPerPixel = 2 * DEFAULT_CAMERA.distance * Math.tan(DEFAULT_CAMERA.fov * DEGREES / 2) / height;
  return validateBody({
    x: (left / 2 + right / 2 - width / 2) * worldPerPixel,
    y: (height / 2 - top / 2 - bottom / 2) * worldPerPixel,
    width: (right - left) * worldPerPixel,
    height: (bottom - top) * worldPerPixel,
    ...options,
  });
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Camera starts on +z looking at its pan target, world y-up, screen y-down.
 * +orbit moves the camera toward +x; +pitch raises it; +roll turns the image clockwise.
 * FOV is vertical. Corner depth is forward distance from the eye (not world z).
 * A corner below the near plane has [null, null, depth]; no fake clipped coordinates.
 */
export function projectBody(body, camera, canvas) {
  const geometry = validateBody(body);
  const view = validateCamera(camera);
  const { width, height } = dimensions(canvas);
  const orbit = view.orbit * DEGREES, pitch = view.pitch * DEGREES, roll = view.roll * DEGREES;
  const so = Math.sin(orbit), co = Math.cos(orbit), sp = Math.sin(pitch), cp = Math.cos(pitch);
  const right = [co, 0, -so];
  const up = [-so * sp, cp, -co * sp];
  const backward = [so * cp, sp, co * cp];
  const sr = Math.sin(roll), cr = Math.cos(roll);
  const sy = Math.sin(geometry.yaw * DEGREES), cy = Math.cos(geometry.yaw * DEGREES);
  const focalLength = height / (2 * Math.tan(view.fov * DEGREES / 2));
  const corners = CORNER_SIGNS.map(([signX, signY, signZ]) => {
    const x = signX * geometry.width / 2, y = signY * geometry.height / 2, z = signZ * geometry.depth / 2;
    const relative = [
      geometry.x + cy * x + sy * z - view.pan_x,
      geometry.y + y - view.pan_y,
      geometry.z - sy * x + cy * z - view.pan_z,
    ];
    const depth = view.distance - dot(relative, backward);
    if (depth < NEAR_PLANE) return [null, null, depth];
    const screenRight = dot(relative, right), screenUp = dot(relative, up);
    return [
      width / 2 + focalLength * (cr * screenRight + sr * screenUp) / depth,
      height / 2 + focalLength * (sr * screenRight - cr * screenUp) / depth,
      depth,
    ];
  });
  const edges = EDGES.map((edge) => [...edge]);
  const visibleCount = corners.filter(([x]) => x !== null).length;
  if (visibleCount !== 8) {
    return {
      corners, edges, box: null, visible: visibleCount > 0, clipped: true,
      reason: corners.every((corner) => corner[2] <= 0) ? 'behind-camera' : 'near-plane',
    };
  }
  const xs = corners.map((corner) => corner[0]), ys = corners.map((corner) => corner[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  // Only floating-point noise counts as zero area; no rounding to pixels or viewport clamping.
  const epsilon = 32 * Number.EPSILON * Math.max(width, height, ...box.map(Math.abs));
  const deltas = corners.map(([x, y]) => [x - corners[0][0], y - corners[0][1]]);
  const longest = deltas.reduce((a, b) => Math.hypot(...a) >= Math.hypot(...b) ? a : b);
  const span = Math.hypot(...longest);
  // A line can have a nonempty axis-aligned bbox after roll. Test its actual area too.
  const area = Math.max(...deltas.map(([x, y]) => Math.abs(longest[0] * y - longest[1] * x)));
  if (span <= epsilon || area <= epsilon * span) {
    return { corners, edges, box: null, visible: false, clipped: false, reason: 'degenerate' };
  }
  return { corners, edges, box, visible: true, clipped: false, reason: null };
}

/** Project ghosts only. Preserve metadata, never write the region's stored execution box. */
export function projectLayout(regions, camera, canvas) {
  const view = validateCamera(camera);
  const size = dimensions(canvas);
  if (!Array.isArray(regions)) invalid('Regions must be an array.');
  const ids = new Set();
  const projected = Array.from(regions, (region) => {
    record(region, 'region');
    if (typeof region.id !== 'string' || !region.id.trim() || ids.has(region.id)) invalid('Region ids must be nonempty and unique.');
    ids.add(region.id);
    boxCoordinates(region.box);
    const body = Object.hasOwn(region, 'body') ? validateBody(region.body) : bodyFromBox(region.box, size);
    return { ...structuredClone(region), ...projectBody(body, view, size) };
  });
  // Accept only floating-point boundary noise; do not alter or clamp the returned bbox.
  const epsilon = 32 * Number.EPSILON * Math.max(size.width, size.height);
  const valid = projected.length > 0 && projected.every(({ box, visible, clipped }) => visible && !clipped && box
    && box[0] >= -epsilon && box[1] >= -epsilon && box[2] <= size.width + epsilon && box[3] <= size.height + epsilon
    && box[0] < box[2] && box[1] < box[3]);
  return { regions: projected, valid };
}

/** A short geometric description, not a promise to recover or preserve real image geometry. */
export function cameraDescription(camera) {
  const view = validateCamera(camera);
  const short = (value) => Number(value.toFixed(2));
  return `Perspective blockout camera: orbit ${short(view.orbit)} deg, pitch ${short(view.pitch)} deg, roll ${short(view.roll)} deg clockwise; `
    + `distance ${short(view.distance)}, vertical FOV ${short(view.fov)} deg; target (${short(view.pan_x)}, ${short(view.pan_y)}, ${short(view.pan_z)}). `
    + 'Blockout guidance only, not image 3D reconstruction or guaranteed view consistency.';
}
