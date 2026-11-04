/**
 * Independent pinhole-camera/blockout geometry for the public Studio document.
 * Field/behavior provenance: xiang6150592/-moss-prompt-editor, 701eecd800891716b1cb1da39a50dd9bc80e579a.
 * No original implementation is incorporated. Browser-only ESM; deliberately no domain import.
 * Coordinates: x right, y down, z into the image; degrees; vertical FOV.
 * These cuboids are composition aids, not reconstructed scene geometry.
 */
export const STUDIO_CAMERA_DEFAULTS = Object.freeze({
  enabled: false, orbit: 0, pitch: 0, roll: 0, distance: 1, fov: 50, pan_x: 0, pan_y: 0, pan_z: 0,
});
export const STUDIO_CUBE_EDGES = Object.freeze([
  [0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3],
  [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7],
].map(Object.freeze));

const RAD = Math.PI / 180;
const NEAR = 0.0001;
const MAX_BYTES = 512 * 1024;
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const center = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
const focal = (height, fov = 50) => height / (2 * Math.tan(fov * RAD / 2));
const copy = (value) => JSON.parse(JSON.stringify(value));

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function finite(value, name = 'geometry') {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('STUDIO_INVALID_INPUT', `${name} must be finite.`);
  return value;
}
function numeric(value) {
  if (!Number.isFinite(value)) fail('STUDIO_CAMERA_NUMERIC', 'Camera calculation is not finite.');
  return value;
}
function cameraOf(layout) {
  if (layout.camera !== undefined) {
    if (!layout.camera || typeof layout.camera !== 'object' || Array.isArray(layout.camera)) {
      fail('STUDIO_INVALID_INPUT', 'camera must be an object.');
    }
    for (const key of Object.keys(layout.camera)) {
      if (!Object.hasOwn(STUDIO_CAMERA_DEFAULTS, key)) fail('STUDIO_INVALID_INPUT', `Unknown camera field: ${key}`);
    }
  }
  const camera = { ...STUDIO_CAMERA_DEFAULTS, ...layout.camera };
  if (typeof camera.enabled !== 'boolean') fail('STUDIO_INVALID_INPUT', 'camera.enabled must be boolean.');
  for (const key of Object.keys(STUDIO_CAMERA_DEFAULTS)) if (key !== 'enabled') finite(camera[key], `camera.${key}`);
  if (camera.distance <= 0 || camera.fov <= 0 || camera.fov >= 180) fail('STUDIO_INVALID_INPUT', 'Invalid camera distance/FOV.');
  return camera;
}
function guard(layout) {
  if (!layout || !Array.isArray(layout.items) || layout.items.length > 128) fail('STUDIO_INVALID_INPUT', 'Expected a validated Studio layout.');
  if (finite(layout.width, 'width') <= 0 || finite(layout.height, 'height') <= 0) fail('STUDIO_INVALID_INPUT', 'Canvas dimensions must be positive.');
  const ids = new Set();
  for (const item of layout.items) {
    if (typeof item.id !== 'string' || ids.has(item.id)) fail('STUDIO_INVALID_INPUT', 'Item ids must be unique strings.');
    ids.add(item.id);
    if (!Array.isArray(item.bbox) || item.bbox.length !== 4) fail('STUDIO_INVALID_INPUT', 'Expected an xyxy bbox.');
    item.bbox.forEach((value) => finite(value, 'bbox'));
    if (item.bbox[2] <= item.bbox[0] || item.bbox[3] <= item.bbox[1]) fail('STUDIO_INVALID_INPUT', 'Bbox must have positive area.');
    numeric(area(item.bbox));
    if (item.body) {
      for (const key of ['z', 'thickness', 'yaw']) finite(item.body[key], `body.${key}`);
      if (item.body.z <= 0 || item.body.thickness < 0 || !['world', 'screen', 'backdrop'].includes(item.body.anchor)) {
        fail('STUDIO_INVALID_INPUT', 'Invalid body geometry/anchor.');
      }
    }
  }
  return cameraOf(layout);
}
function finish(layout) {
  guard(layout);
  if (new TextEncoder().encode(JSON.stringify(layout)).length > MAX_BYTES) fail('STUDIO_INVALID_INPUT', 'Layout exceeds 512 KiB.');
  return layout;
}

export function studioCameraMoved(layout) {
  const camera = cameraOf(layout);
  return camera.enabled && Object.keys(STUDIO_CAMERA_DEFAULTS).some((key) => key !== 'enabled' && camera[key] !== STUDIO_CAMERA_DEFAULTS[key]);
}

export function studioCameraFrame(layout) {
  const camera = guard(layout);
  const bodies = new Map(layout.items.map((item) => [item.id, studioBody(item, layout)]));
  const pivot = pivotDepth(layout, bodies);
  const frame = cameraFrame(camera.enabled ? camera : STUDIO_CAMERA_DEFAULTS, pivot, layout);
  return {
    position: [...frame.position],
    right: [...frame.right],
    down: [...frame.down],
    forward: [...frame.forward],
    focal: frame.f,
    pivot,
  };
}

/** Inference is intentionally simple and deterministic; explicit body data is never clamped. */
export function studioBody(item, layout) {
  if(item.role==='panel'||item.bubble||item.sketch)return {z:1,thickness:0,yaw:0,anchor:'screen'};
  if (item.body) return { ...item.body };
  const [x1, y1, x2, y2] = item.bbox;
  const covering = item.label !== 'character' && x1 <= layout.width * 0.05 && y1 <= layout.height * 0.05
    && x2 >= layout.width * 0.95 && y2 >= layout.height * 0.95;
  const depth = { fg: 0.6, mg: 1, bg: 2.5 };
  return {
    z: depth[item.depth] ?? clamp(numeric(layout.height / (2 * (y2 - y1))), 0.15, 12),
    thickness: item.label === 'character' ? 0.25 : 0.2,
    yaw: 0, anchor: item.label === 'text' ? 'screen' : covering ? 'backdrop' : 'world',
  };
}

export function estimateStudioBodies(layout, { onlyMissing = true } = {}) {
  guard(layout);
  const result = copy(layout);
  for (const item of result.items) {
    if (item.locked || (onlyMissing && item.body)) continue;
    const { body: _body, ...withoutBody } = item;
    item.body = studioBody(withoutBody, result);
  }
  return finish(result);
}

function clipBox(raw, layout) {
  return [clamp(raw[0], 0, layout.width), clamp(raw[1], 0, layout.height),
    clamp(raw[2], 0, layout.width), clamp(raw[3], 0, layout.height)];
}
function onCanvas(raw, layout) {
  const bbox = clipBox(raw, layout);
  const width = bbox[2] - bbox[0], height = bbox[3] - bbox[1];
  return width >= 6 && height >= 6 && width * height / area(raw) >= 0.03;
}
function pivotDepth(layout, bodies) {
  const world = layout.items.filter((item) => !item.hidden && bodies.get(item.id).anchor === 'world');
  const visible = world.filter((item) => onCanvas(item.bbox, layout));
  const characters = visible.filter((item) => item.label === 'character');
  const candidates = characters.length ? characters : visible.length ? visible : world;
  let largest;
  for (const item of candidates) if (!largest || area(item.bbox) > area(largest.bbox)) largest = item;
  return largest ? bodies.get(largest.id).z : 1;
}
function cameraFrame(camera, pivot, layout) {
  const o = camera.orbit * RAD, p = camera.pitch * RAD, r = camera.roll * RAD;
  const so = Math.sin(o), co = Math.cos(o), sp = Math.sin(p), cp = Math.cos(p);
  const forward = [-so * cp, sp, co * cp];
  const unrolledRight = [co, 0, so], unrolledDown = [so * sp, cp, -co * sp];
  const right = unrolledRight.map((v, i) => v * Math.cos(r) + unrolledDown[i] * Math.sin(r));
  const down = unrolledDown.map((v, i) => v * Math.cos(r) - unrolledRight[i] * Math.sin(r));
  const target = [camera.pan_x * pivot, camera.pan_y * pivot, (1 + camera.pan_z) * pivot];
  const position = target.map((v, i) => numeric(v - forward[i] * camera.distance * pivot));
  return { right, down, forward, position, f: numeric(focal(layout.height, camera.fov)) };
}
function cube(item, body, layout) {
  const f = focal(layout.height), [cx, cy] = center(item.bbox);
  const middle = [(cx - layout.width / 2) * body.z / f, (cy - layout.height / 2) * body.z / f, body.z];
  const hw = (item.bbox[2] - item.bbox[0]) * body.z / (2 * f);
  const hh = (item.bbox[3] - item.bbox[1]) * body.z / (2 * f);
  const hz = hw * body.thickness, c = Math.cos(body.yaw * RAD), s = Math.sin(body.yaw * RAD);
  const points = [];
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? hw : -hw, y = i & 2 ? hh : -hh, z = i & 4 ? hz : -hz;
    points.push([numeric(middle[0] + x * c + z * s), numeric(middle[1] + y), numeric(middle[2] - x * s + z * c)]);
  }
  return { middle, points };
}
/** Shared world proxy geometry for the read-only observer; same cube used by output projection. */
export function studioWorldCube(item, body, layout) {
  return cube(item, body, layout);
}

function cameraPoint(point, frame) {
  const relative = point.map((value, i) => numeric(value - frame.position[i]));
  return [numeric(dot(relative, frame.right)), numeric(dot(relative, frame.down)), numeric(dot(relative, frame.forward))];
}
function pixel(point, frame, layout) {
  return { x: numeric(layout.width / 2 + frame.f * point[0] / point[2]),
    y: numeric(layout.height / 2 + frame.f * point[1] / point[2]) };
}
function bounds(points) {
  if (!points.length) return null;
  return [Math.min(...points.map((p) => p.x)), Math.min(...points.map((p) => p.y)),
    Math.max(...points.map((p) => p.x)), Math.max(...points.map((p) => p.y))];
}
function projectCube(points, frame, layout) {
  const local = points.map((point) => cameraPoint(point, frame));
  const corners = local.map((point) => point[2] >= NEAR ? pixel(point, frame, layout) : null);
  const outline = corners.filter(Boolean);
  for (const [i, j] of STUDIO_CUBE_EDGES) {
    const a = local[i], b = local[j];
    if ((a[2] < NEAR) === (b[2] < NEAR)) continue;
    const t = (NEAR - a[2]) / (b[2] - a[2]);
    outline.push(pixel([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR], frame, layout));
  }
  return { corners, bounds: bounds(outline), partial: corners.some((point) => point === null) };
}
function landmarks(frame, layout) {
  const { right: r, down: d, forward: f, f: scale } = frame;
  const cx = layout.width / 2, cy = layout.height / 2;
  let horizon = null;
  if (Math.abs(d[1]) > 1e-8) {
    horizon = { a: { x: 0, y: numeric(cy - (-cx * r[1] + scale * f[1]) / d[1]) },
      b: { x: layout.width, y: numeric(cy - (cx * r[1] + scale * f[1]) / d[1]) } };
  } else if (Math.abs(r[1]) > 1e-8) {
    horizon = { a: { x: numeric(cx - (-cy * d[1] + scale * f[1]) / r[1]), y: 0 },
      b: { x: numeric(cx - (cy * d[1] + scale * f[1]) / r[1]), y: layout.height } };
  }
  const vp = f[2] > 1e-8 ? { x: numeric(cx + scale * r[2] / f[2]), y: numeric(cy + scale * d[2] / f[2]) } : null;
  return { horizon, vp };
}
function projectedOrder(layout, records) {
  const bands = { backdrop: [], world: [], screen: [] };
  for (const item of layout.items) bands[records[item.id].anchor].push(item.id);
  // Stable adjacent sorting: small depth noise cannot flip the user's layer order.
  for (let pass = 0; pass < bands.world.length; pass++) {
    let changed = false;
    for (let i = 0; i + 1 < bands.world.length; i++) {
      const a = records[bands.world[i]].depth, b = records[bands.world[i + 1]].depth;
      if (a > 0 && b > 0 && b - a > Math.max(a, b) * 0.12) {
        [bands.world[i], bands.world[i + 1]] = [bands.world[i + 1], bands.world[i]];
        changed = true;
      }
    }
    if (!changed) break;
  }
  return [...bands.backdrop, ...bands.world, ...bands.screen];
}

/** All returned coordinates are finite. Raw bounds include near-plane edge intersections. */
export function projectStudioLayout(layout, projectedItems) {
  const camera = guard(layout), moved = studioCameraMoved(layout);
  const bodies = new Map(layout.items.map((item) => [item.id, studioBody(item, layout)]));
  const pivot = pivotDepth(layout, bodies);
  const base = cameraFrame(STUDIO_CAMERA_DEFAULTS, pivot, layout);
  const frame = moved ? cameraFrame(camera, pivot, layout) : base;
  const items = Object.create(null), checks = [];
  for (const item of layout.items) {
    if (projectedItems?.has(item.id)) {
      items[item.id] = projectedItems.get(item.id);
      continue;
    }
    const body = bodies.get(item.id);
    let raw = [...item.bbox], corners = null, depth = null, partial = false, inFront = true;
    if (body.anchor === 'world') {
      const geometry = cube(item, body, layout);
      depth = cameraPoint(geometry.middle, frame)[2];
      const baseline = projectCube(geometry.points, base, layout);
      const original = baseline.bounds;
      const usable = original && original[2] - original[0] > 1e-8 && original[3] - original[1] > 1e-8;
      if (!usable && moved && !item.hidden) fail('STUDIO_CAMERA_DEGENERATE', `Item ${item.id} has a singular baseline cube projection (edge-on/near-plane).`);
      if (usable) {
        const sx = (item.bbox[2] - item.bbox[0]) / (original[2] - original[0]);
        const sy = (item.bbox[3] - item.bbox[1]) / (original[3] - original[1]);
        const mapped = (point) => point === null ? null : {
          x: numeric(item.bbox[0] + (point.x - original[0]) * sx),
          y: numeric(item.bbox[1] + (point.y - original[1]) * sy),
        };
        const projected = moved ? projectCube(geometry.points, frame, layout) : baseline;
        corners = projected.corners.map(mapped);
        partial = projected.partial;
        if (moved) {
          inFront = Boolean(projected.bounds);
          if (projected.bounds) {
            const [x1, y1, x2, y2] = projected.bounds;
            const a = mapped({ x: x1, y: y1 }), b = mapped({ x: x2, y: y2 });
            raw = [a.x, a.y, b.x, b.y];
          }
        }
      }
    }
    const bbox = clipBox(raw, layout);
    partial ||= bbox.some((v, i) => v !== raw[i]);
    const visible = !item.hidden && inFront && onCanvas(raw, layout);
    numeric(area(raw));
    items[item.id] = { id: item.id, anchor: body.anchor, raw, bbox, visible, partial, corners, depth };
  }
  return { items, order: moved ? projectedOrder(layout, items) : layout.items.map((item) => item.id),
    ...landmarks(frame, layout), checks };
}

/** Camera operations are global view changes; rebase never rewrites/reorders a locked item. */
export function rebaseStudioCamera(layout) {
  const projected = projectStudioLayout(layout), result = copy(layout);
  const byId = new Map(result.items.map((item) => [item.id, item]));
  for (const [index, original] of layout.items.entries()) {
    const view = projected.items[original.id], item = byId.get(original.id);
    if (!original.hidden && view.visible) item.bbox = [...view.bbox];
    else if (!original.hidden) item.hidden = true;
    if (original.locked && (JSON.stringify(item) !== JSON.stringify(original) || projected.order[index] !== original.id)) {
      fail('STUDIO_LOCKED', 'Rebase would change locked content or its layer position.');
    }
  }
  result.items = projected.order.map((id) => byId.get(id));
  result.camera = { ...STUDIO_CAMERA_DEFAULTS, enabled: true };
  return finish(result);
}

function resolveIds(layout, ids) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) fail('STUDIO_INVALID_INPUT', 'Expected an array of item ids.');
  const known = new Set(layout.items.map((item) => item.id));
  for (const id of ids) if (!known.has(id)) fail('STUDIO_ITEM_NOT_FOUND', `Unknown item id: ${id}`);
  return new Set(ids);
}
function unionFor(projected, ids) {
  const selected = ids.map((id) => projected.items[id]);
  if (selected.some((item) => !(item.depth > NEAR))) return null;
  const points = selected.flatMap((item) => [{ x: item.raw[0], y: item.raw[1] }, { x: item.raw[2], y: item.raw[3] }]);
  return bounds(points);
}
function inverse2(a, b, c, d, x, y) {
  const det = a * d - b * c;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10 * Math.max(1, Math.abs(a * d), Math.abs(b * c))) return null;
  const result = [(d * x - b * y) / det, (a * y - c * x) / det];
  return result.every(Number.isFinite) ? result : null;
}
function inverse3(m, rhs) {
  const [a, b, c, d, e, f, g, h, k] = m;
  const A = e * k - f * h, B = -(d * k - f * g), C = d * h - e * g;
  const D = -(b * k - c * h), E = a * k - c * g, F = -(a * h - b * g);
  const G = b * f - c * e, H = -(a * f - c * d), K = a * e - b * d;
  const det = a * A + b * B + c * C;
  const scale = Math.max(1, Math.abs(a * e * k), Math.abs(b * f * g), Math.abs(c * d * h));
  if (!Number.isFinite(det) || Math.abs(det) < 1e-11 * scale) return null;
  const [x, y, z] = rhs;
  const result = [(A * x + D * y + G * z) / det, (B * x + E * y + H * z) / det, (C * x + F * y + K * z) / det];
  return result.every(Number.isFinite) ? result : null;
}
function defaultSubject(layout, projected) {
  const world = layout.items.filter((item) => !item.hidden && studioBody(item, layout).anchor === 'world');
  const inFront = world.filter((item) => {
    const view = projected.items[item.id];
    return view && view.depth > NEAR && Array.isArray(view.corners) && !view.corners.some((point) => point === null);
  });
  const visible = inFront.filter((item) => projected.items[item.id].visible);
  const characters = visible.filter((item) => item.label === 'character');
  const candidates = characters.length ? characters : visible.length ? visible : inFront;
  let largest = null, bestArea = -Infinity;
  for (const item of candidates) {
    const currentArea = area(projected.items[item.id].raw);
    if (currentArea > bestArea) { largest = item; bestArea = currentArea; }
  }
  return largest;
}
function framingMetrics(projected, ids) {
  const selected = ids.map((id) => projected.items[id]);
  if (!selected.length || selected.some((item) => !item || !(item.depth > NEAR)
    || !Array.isArray(item.corners) || item.corners.some((point) => point === null))) {
    return null;
  }
  const raw = bounds(selected.flatMap((item) => [{ x: item.raw[0], y: item.raw[1] }, { x: item.raw[2], y: item.raw[3] }]));
  if (!raw) return null;
  const [cx, cy] = center(raw), size = Math.sqrt(Math.max(0, area(raw)));
  if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(size) || size <= 1e-8) return null;
  return { cx, cy, size };
}

export function captureStudioFraming(layout, ids = []) {
  guard(layout);
  const wanted = resolveIds(layout, ids);
  let projected;
  try {
    projected = projectStudioLayout(layout);
  } catch (error) {
    if (['STUDIO_CAMERA_DEGENERATE', 'STUDIO_CAMERA_NUMERIC'].includes(error.code)) {
      fail('STUDIO_FOLLOW_UNAVAILABLE', error.message);
    }
    throw error;
  }
  let targetIds;
  if (wanted.size) {
    targetIds = layout.items
      .filter((item) => wanted.has(item.id) && !item.hidden && studioBody(item, layout).anchor === 'world')
      .map((item) => item.id);
  } else {
    const subject = defaultSubject(layout, projected);
    targetIds = subject ? [subject.id] : [];
  }
  if (!targetIds.length) fail('STUDIO_FOLLOW_UNAVAILABLE', 'No valid in-front world subject to capture framing.');
  const metrics = framingMetrics(projected, targetIds);
  if (!metrics) fail('STUDIO_FOLLOW_UNAVAILABLE', 'Target crosses the near plane or has singular framing.');
  return { ids: [...targetIds], cx: metrics.cx, cy: metrics.cy, size: metrics.size };
}

export function followStudioCamera(layout, patch = {}, goal, { keepSize = true } = {}) {
  guard(layout);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('STUDIO_INVALID_INPUT', 'Expected a camera patch object.');
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(STUDIO_CAMERA_DEFAULTS, key)) fail('STUDIO_INVALID_INPUT', `Unknown camera field: ${key}`);
  }
  if (typeof keepSize !== 'boolean') fail('STUDIO_INVALID_INPUT', 'keepSize must be boolean.');
  if (!goal || typeof goal !== 'object' || Array.isArray(goal)) fail('STUDIO_INVALID_INPUT', 'Expected a framing goal.');
  const cxGoal = finite(goal.cx, 'goal.cx'), cyGoal = finite(goal.cy, 'goal.cy'), sizeGoal = finite(goal.size, 'goal.size');
  if (sizeGoal <= 0) fail('STUDIO_INVALID_INPUT', 'goal.size must be positive.');
  const wanted = resolveIds(layout, goal.ids);
  if (!wanted.size) fail('STUDIO_INVALID_INPUT', 'goal.ids must be a non-empty array of item ids.');
  const targets = layout.items.filter((item) => wanted.has(item.id));
  if (targets.some((item) => item.hidden || studioBody(item, layout).anchor !== 'world')) {
    fail('STUDIO_FOLLOW_UNAVAILABLE', 'Framing goal includes hidden or non-world items.');
  }
  const targetIds = targets.map((item) => item.id);
  const startCamera = cameraOf({ camera: { ...layout.camera, ...patch, enabled: true } });
  if (Math.abs(startCamera.orbit) > 180 || Math.abs(startCamera.pitch) > 85 || Math.abs(startCamera.roll) > 180
    || startCamera.distance < 0.01 || startCamera.distance > 100 || startCamera.fov < 10 || startCamera.fov > 120
    || Math.abs(startCamera.pan_x) > 100 || Math.abs(startCamera.pan_y) > 100 || Math.abs(startCamera.pan_z) > 100) {
    fail('STUDIO_INVALID_INPUT', 'Camera parameters out of domain bounds.');
  }
  const sizeTol = Math.max(0.05, sizeGoal * 0.0001);
  const probe = copy(layout);
  const evaluate = (pan_x, pan_y, distance) => {
    if (!Number.isFinite(pan_x) || !Number.isFinite(pan_y) || !Number.isFinite(distance)
      || Math.abs(pan_x) > 100 || Math.abs(pan_y) > 100 || distance < 0.01 || distance > 100) {
      return null;
    }
    probe.camera = { ...startCamera, enabled: true, pan_x, pan_y, distance };
    try {
      const projected = projectStudioLayout(probe);
      const m = framingMetrics(projected, targetIds);
      if (!m) return null;
      const ex = cxGoal - m.cx, ey = cyGoal - m.cy, es = keepSize ? sizeGoal - m.size : 0;
      const centerErr = Math.hypot(ex, ey), sizeErr = Math.abs(es);
      const loss = Math.hypot(ex, ey, es / Math.max(1, sizeGoal) * 256);
      return { cx: m.cx, cy: m.cy, size: m.size, ex, ey, es, centerErr, sizeErr, loss };
    } catch (error) {
      if (['STUDIO_CAMERA_DEGENERATE', 'STUDIO_CAMERA_NUMERIC'].includes(error.code)) return null;
      throw error;
    }
  };
  const bodies = new Map(layout.items.map((item) => [item.id, studioBody(item, layout)]));
  const pivot = pivotDepth(layout, bodies), subject = [0, 0, 0];
  const f0 = focal(layout.height);
  const rawAreas = [];
  for (const item of targets) {
    const [x, y] = center(item.bbox), z = bodies.get(item.id).z;
    subject[0] += (x - layout.width / 2) * z / (f0 * pivot * targets.length);
    subject[1] += (y - layout.height / 2) * z / (f0 * pivot * targets.length);
    subject[2] += z / (pivot * targets.length);
    rawAreas.push(area(item.bbox));
  }
  const orient = cameraFrame({ ...startCamera, distance: 1, pan_x: 0, pan_y: 0, pan_z: 0 }, pivot, layout);
  const targetPanZ = 1 + startCamera.pan_z;
  const dz = subject[2] - targetPanZ;
  const scaleFactor = orient.f / f0;
  const approxSubjSize = Math.sqrt(Math.max(1e-8, rawAreas.reduce((a, b) => a + b, 0))) * subject[2] * scaleFactor;
  const approxDepth = Math.max(0.05, approxSubjSize / Math.max(1, sizeGoal));
  const gx = (cxGoal - layout.width / 2) / orient.f, gy = (cyGoal - layout.height / 2) / orient.f;
  const rayDir = [
    orient.right[0] * gx + orient.down[0] * gy + orient.forward[0],
    orient.right[1] * gx + orient.down[1] * gy + orient.forward[1],
    orient.right[2] * gx + orient.down[2] * gy + orient.forward[2],
  ];
  const candidateSeeds = [];
  if (keepSize) {
    for (const dEst of [approxDepth, subject[2], 0.5, 1, 2, 4, 8, 16, 32, 64]) {
      const wantOffset = [
        subject[0] - dEst * rayDir[0],
        subject[1] - dEst * rayDir[1],
        dz - dEst * rayDir[2],
      ];
      if (Math.abs(orient.forward[2]) > 1e-3) {
        const distEst = -wantOffset[2] / orient.forward[2];
        if (distEst >= 0.01 && distEst <= 100) {
          const pxEst = wantOffset[0] + orient.forward[0] * distEst;
          const pyEst = wantOffset[1] + orient.forward[1] * distEst;
          if (Math.abs(pxEst) <= 100 && Math.abs(pyEst) <= 100) {
            candidateSeeds.push([pxEst, pyEst, distEst]);
          }
        }
      }
      // Also find closest domain-valid distance along the camera forward axis that satisfies pan_x, pan_y, pan_z bounds
      let lower = 0.01, upper = 100;
      for (let axis = 0; axis < 2; axis++) {
        const dir = orient.forward[axis];
        if (Math.abs(dir) < 1e-14) {
          if (Math.abs(wantOffset[axis]) > 100) { lower = 1; upper = 0; }
        } else {
          const a = (-100 - wantOffset[axis]) / dir, b = (100 - wantOffset[axis]) / dir;
          lower = Math.max(lower, Math.min(a, b)); upper = Math.min(upper, Math.max(a, b));
        }
      }
      if (lower <= upper) {
        const dClamped = clamp(Math.abs(orient.forward[2]) > 1e-6 ? -wantOffset[2] / orient.forward[2] : dEst, lower, upper);
        const pxDirect = clamp(wantOffset[0] + orient.forward[0] * dClamped, -100, 100);
        const pyDirect = clamp(wantOffset[1] + orient.forward[1] * dClamped, -100, 100);
        candidateSeeds.push([pxDirect, pyDirect, dClamped]);
      }
    }
  } else {
    const distFixed = startCamera.distance;
    const dEst = Math.max(0.05, dz + orient.forward[2] * distFixed);
    const pxEst = subject[0] + orient.forward[0] * distFixed - dEst * rayDir[0];
    const pyEst = subject[1] + orient.forward[1] * distFixed - dEst * rayDir[1];
    candidateSeeds.push([clamp(pxEst, -100, 100), clamp(pyEst, -100, 100), distFixed]);
  }
  const panSeeds = [
    [startCamera.pan_x, startCamera.pan_y],
    [subject[0], subject[1]],
    [0, 0],
    [-1.5, 0], [1.5, 0], [0, -1.5], [0, 1.5],
  ];
  if (Math.abs(orient.forward[2]) > 1e-6) {
    const tRay = dz / orient.forward[2];
    panSeeds.splice(2, 0, [
      subject[0] - orient.forward[0] * tRay,
      subject[1] - orient.forward[1] * tRay,
    ]);
  }
  const uniquePanSeeds = panSeeds
    .map(([px, py]) => [clamp(px, -100, 100), clamp(py, -100, 100)])
    .filter(([px, py], idx, arr) => arr.findIndex(([qx, qy]) => Math.hypot(px - qx, py - qy) < 1e-9) === idx);

  for (const [seedPanX, seedPanY] of uniquePanSeeds) {
    if (keepSize) {
      const baseDepth = dot(
        [subject[0] - seedPanX, subject[1] - seedPanY, subject[2] - targetPanZ],
        orient.forward,
      );
      const minFront = Math.max(0.01, -baseDepth + 0.05);
      const geomDist = Math.max(minFront, approxDepth - baseDepth);
      for (const d of [
        clamp(startCamera.distance, 0.01, 100),
        clamp(geomDist, 0.01, 100),
        clamp(-baseDepth + subject[2], 0.01, 100),
        clamp(minFront + 0.25, 0.01, 100),
        clamp(minFront + 1, 0.01, 100),
        clamp(minFront + 4, 0.01, 100),
        clamp(subject[2], 0.01, 100),
        0.5, 1, 2, 4, 8, 16, 32, 64, 96,
      ]) {
        candidateSeeds.push([seedPanX, seedPanY, d]);
      }
    } else {
      candidateSeeds.push([seedPanX, seedPanY, startCamera.distance]);
    }
  }
  const seenSeeds = new Set();
  for (const [seedPanX, seedPanY, seedDist] of candidateSeeds) {
    const key = `${seedPanX.toFixed(6)},${seedPanY.toFixed(6)},${seedDist.toFixed(6)}`;
    if (seenSeeds.has(key)) continue;
    seenSeeds.add(key);
    {
      let pan_x = seedPanX, pan_y = seedPanY, distance = seedDist;
      let current = evaluate(pan_x, pan_y, distance);
      if (!current) continue;
      for (let iteration = 0; iteration < 28; iteration++) {
        if (current.centerErr <= 0.05 && (!keepSize || current.sizeErr <= sizeTol)) {
          const out = copy(layout);
          out.camera = { ...startCamera, enabled: true, pan_x, pan_y, distance };
          return finish(out);
        }
        const hPan = Math.max(1e-5, Math.abs(pan_x) * 1e-5, Math.abs(pan_y) * 1e-5);
        const stepX = pan_x + hPan <= 100 ? hPan : -hPan;
        const px = evaluate(pan_x + stepX, pan_y, distance);
        const stepY = pan_y + hPan <= 100 ? hPan : -hPan;
        const py = evaluate(pan_x, pan_y + stepY, distance);
        if (!px || !py) break;
        let delta = null;
        if (keepSize) {
          const hDist = Math.max(1e-5, distance * 1e-4);
          const stepD = distance + hDist <= 100 ? hDist : -hDist;
          const pd = evaluate(pan_x, pan_y, distance + stepD);
          if (!pd) break;
          delta = inverse3([
            (px.cx - current.cx) / stepX, (py.cx - current.cx) / stepY, (pd.cx - current.cx) / stepD,
            (px.cy - current.cy) / stepX, (py.cy - current.cy) / stepY, (pd.cy - current.cy) / stepD,
            (px.size - current.size) / stepX, (py.size - current.size) / stepY, (pd.size - current.size) / stepD,
          ], [current.ex, current.ey, current.es]);
        }
        if (!delta) {
          const d2 = inverse2(
            (px.cx - current.cx) / stepX, (py.cx - current.cx) / stepY,
            (px.cy - current.cy) / stepX, (py.cy - current.cy) / stepY,
            current.ex, current.ey,
          );
          if (d2) {
            let dDist = 0;
            if (keepSize) {
              const hDist = Math.max(1e-5, distance * 1e-4);
              const stepD = distance + hDist <= 100 ? hDist : -hDist;
              const pd = evaluate(pan_x, pan_y, distance + stepD);
              const dsdd = pd ? (pd.size - current.size) / stepD : 0;
              if (Math.abs(dsdd) > 1e-8) dDist = current.es / dsdd;
            }
            delta = [d2[0], d2[1], dDist];
          }
        }
        if (!delta) break;
        let accepted = false;
        for (let factor = 1; factor >= 1 / 128; factor /= 2) {
          const nextPanX = clamp(pan_x + delta[0] * factor, -100, 100);
          const nextPanY = clamp(pan_y + delta[1] * factor, -100, 100);
          const nextDist = keepSize ? clamp(distance + delta[2] * factor, 0.01, 100) : distance;
          if (nextPanX === pan_x && nextPanY === pan_y && nextDist === distance) continue;
          const cand = evaluate(nextPanX, nextPanY, nextDist);
          if (cand && (cand.loss < current.loss || (cand.centerErr <= 0.05 && (!keepSize || cand.sizeErr <= sizeTol)))) {
            pan_x = nextPanX; pan_y = nextPanY; distance = nextDist; current = cand;
            accepted = true;
            break;
          }
        }
        if (!accepted) break;
      }
      if (current && current.centerErr <= 0.05 && (!keepSize || current.sizeErr <= sizeTol)) {
        const out = copy(layout);
        out.camera = { ...startCamera, enabled: true, pan_x, pan_y, distance };
        return finish(out);
      }
    }
  }
  fail('STUDIO_FOLLOW_UNAVAILABLE', 'Could not solve camera framing within domain bounds.');
}

/** Bounded deterministic pan/distance search, never resets the user's viewing angles. */
export function frameStudioCamera(layout, ids = []) {
  const camera = guard(layout), wanted = resolveIds(layout, ids);
  const targets = layout.items.filter((item) => !item.hidden && studioBody(item, layout).anchor === 'world'
    && (!wanted.size || wanted.has(item.id))).map((item) => item.id);
  if (!targets.length) fail('STUDIO_FRAME_UNAVAILABLE', 'No nonhidden world items to frame.');
  let best = null, bestScore = Infinity;
  const result = copy(layout);
  // Include the current distance as well as a fixed reproducible grid. A behind-camera
  // starting pan says nothing about other legal pans: retry target-centered and grid seeds.
  const distances = [...new Set([clamp(camera.distance, 0.2, 5), ...Array.from({ length: 25 }, (_, i) => (i + 1) / 5)])];
  const bodies = new Map(layout.items.map((item) => [item.id, studioBody(item, layout)]));
  const pivot = pivotDepth(layout, bodies), subject = [0, 0];
  for (const item of layout.items) if (targets.includes(item.id)) {
    const [x, y] = center(item.bbox), z = bodies.get(item.id).z;
    subject[0] += (x - layout.width / 2) * z / (focal(layout.height) * pivot * targets.length);
    subject[1] += (y - layout.height / 2) * z / (focal(layout.height) * pivot * targets.length);
  }
  const seeds = [[camera.pan_x, camera.pan_y], subject,
    ...[-3, 0, 3].flatMap((x) => [-3, 0, 3].map((y) => [x, y]))]
    .map((seed) => seed.map((value) => clamp(value, -3, 3)))
    .filter((seed, index, all) => all.findIndex((entry) => entry[0] === seed[0] && entry[1] === seed[1]) === index);
  for (const [pan_x, pan_y] of seeds) {
    for (const distance of distances) {
      result.camera = { ...camera, enabled: true, distance, pan_x, pan_y, pan_z: 0 };
      try {
        for (let iteration = 0; iteration < 12; iteration++) {
          const projected = projectStudioLayout(result), raw = unionFor(projected, targets);
          if (!raw) break;
          const [x, y] = center(raw), dx = layout.width / 2 - x, dy = layout.height / 2 - y;
          const span = Math.max((raw[2] - raw[0]) / layout.width, (raw[3] - raw[1]) / layout.height);
          const padded = raw[0] >= layout.width * 0.04 && raw[1] >= layout.height * 0.04
            && raw[2] <= layout.width * 0.96 && raw[3] <= layout.height * 0.96;
          if (padded && targets.every((id) => projected.items[id].visible && !projected.items[id].partial)) {
            const score = Math.abs(span - 0.72) + Math.hypot(dx / layout.width, dy / layout.height);
            if (score < bestScore) { bestScore = score; best = { ...result.camera }; }
          }
          if (Math.hypot(dx, dy) < 0.01) break;
          const step = 0.0001, originalX = result.camera.pan_x, originalY = result.camera.pan_y;
          result.camera.pan_x = originalX + step;
          const bx = unionFor(projectStudioLayout(result), targets);
          result.camera.pan_x = originalX; result.camera.pan_y = originalY + step;
          const by = unionFor(projectStudioLayout(result), targets);
          result.camera.pan_y = originalY;
          if (!bx || !by) break;
          const px = center(bx), py = center(by);
          const delta = inverse2((px[0] - x) / step, (py[0] - x) / step, (px[1] - y) / step, (py[1] - y) / step, dx, dy);
          if (!delta) break;
          result.camera.pan_x = clamp(originalX + clamp(delta[0], -1, 1), -3, 3);
          result.camera.pan_y = clamp(originalY + clamp(delta[1], -1, 1), -3, 3);
          if (result.camera.pan_x === originalX && result.camera.pan_y === originalY) break;
        }
      } catch (error) {
        if (!['STUDIO_CAMERA_DEGENERATE', 'STUDIO_CAMERA_NUMERIC'].includes(error.code)) throw error;
      }
    }
    // Existing-pan solutions remain preferred; extra seeds are recovery, not exhaustive optimization.
    if (best) break;
  }
  if (!best) fail('STUDIO_FRAME_UNAVAILABLE', 'No reliable frame within distance .2–5 and pan ±3.');
  result.camera = best;
  return finish(result);
}

/** Re-express the same physical camera after auto-pivot selection changes; no new Doc fields. */
function cameraAtPivot(camera, previousPivot, nextPivot, frame) {
  const normalizedPosition = frame.position.map((value) => value / nextPivot);
  const offset = [normalizedPosition[0], normalizedPosition[1], normalizedPosition[2] - 1];
  if (!offset.every(Number.isFinite)) fail('STUDIO_MOVE_UNAVAILABLE', 'Cannot represent the fixed camera at the new pivot.');
  // Camera target/distance are redundant: choose the closest distance that keeps all stored
  // fields inside the existing domain bounds, rather than silently clamping physical position.
  let lower = 0.01, upper = 100;
  for (let axis = 0; axis < 3; axis++) {
    const direction = frame.forward[axis];
    if (Math.abs(direction) < 1e-14) {
      if (Math.abs(offset[axis]) > 100) fail('STUDIO_MOVE_UNAVAILABLE', 'Fixed camera exceeds the editable pan range.');
    } else {
      const a = (-100 - offset[axis]) / direction, b = (100 - offset[axis]) / direction;
      lower = Math.max(lower, Math.min(a, b)); upper = Math.min(upper, Math.max(a, b));
    }
  }
  if (lower > upper) fail('STUDIO_MOVE_UNAVAILABLE', 'Fixed camera exceeds the editable distance/pan range.');
  const distance = clamp(camera.distance * previousPivot / nextPivot, lower, upper);
  const pans = offset.map((value, axis) => value + frame.forward[axis] * distance);
  if (!Number.isFinite(distance) || pans.some((value) => !Number.isFinite(value) || Math.abs(value) > 100)) {
    fail('STUDIO_MOVE_UNAVAILABLE', 'Cannot represent the fixed camera with finite editable parameters.');
  }
  return { ...camera, distance, pan_x: pans[0], pan_y: pans[1], pan_z: pans[2] };
}

function selectMovableMembers(layout, ids, { freeze = false, individual = false } = {}) {
  const selected = resolveIds(layout, ids);
  const lockedGroups = new Set(layout.items.filter((item) => item.locked && item.group).map((item) => item.group));
  const groups = new Set(layout.items.filter((item) => selected.has(item.id) && item.group).map((item) => item.group));
  let members = layout.items.filter((item) => freeze || selected.has(item.id) || (!individual && item.group && groups.has(item.group)));
  if (!freeze && members.some((item) => item.locked || (!individual && item.group && lockedGroups.has(item.group)))) {
    fail('STUDIO_LOCKED', 'A selected item/group is locked.');
  }
  members = members.filter((item) => studioBody(item, layout).anchor === 'world'
    && (!freeze || (!item.locked && !(item.group && lockedGroups.has(item.group)))));
  return { selected, members };
}

export function translateStudioItems(layout, ids, delta, { freeze = false, follow = false, individual = false } = {}) {
  guard(layout);
  if (!Array.isArray(delta) || delta.length !== 3) fail('STUDIO_INVALID_INPUT', 'Expected a 3D world translation [wx, wy, wz].');
  const wx = finite(delta[0], 'wx'), wy = finite(delta[1], 'wy'), wz = finite(delta[2], 'wz');
  if (typeof freeze !== 'boolean' || typeof follow !== 'boolean' || typeof individual !== 'boolean') {
    fail('STUDIO_INVALID_INPUT', 'Movement flags must be boolean.');
  }
  const { members } = selectMovableMembers(layout, ids, { freeze, individual });
  const result = copy(layout);
  if (!members.length || (wx === 0 && wy === 0 && wz === 0)) return result;

  let initialProjected = null, followActive = false, followGoal = null;
  if (follow) {
    try {
      initialProjected = projectStudioLayout(layout);
    } catch (error) {
      if (['STUDIO_CAMERA_DEGENERATE', 'STUDIO_CAMERA_NUMERIC'].includes(error.code)) {
        fail('STUDIO_FOLLOW_UNAVAILABLE', error.message);
      }
      throw error;
    }
    const defSubject = defaultSubject(layout, initialProjected);
    if (defSubject && members.some((item) => item.id === defSubject.id)) {
      followActive = true;
      const memberIds = members.map((item) => item.id);
      const metrics = framingMetrics(initialProjected, memberIds);
      if (!metrics) fail('STUDIO_FOLLOW_UNAVAILABLE', 'Moving subject crosses the near plane or has singular framing.');
      followGoal = { ids: memberIds, cx: metrics.cx, cy: metrics.cy, size: metrics.size };
    }
  }

  const moving = new Set(members.map((item) => item.id));
  for (const item of result.items) if (moving.has(item.id)) item.body = studioBody(item, layout);
  const bodies = new Map(result.items.map((item) => [item.id, studioBody(item, result)]));
  const originalPivot = pivotDepth(result, bodies), originalCamera = cameraOf(result);
  const originalCameraRecord = result.camera, movedCamera = studioCameraMoved(result);
  const baseFrame = cameraFrame(movedCamera ? originalCamera : STUDIO_CAMERA_DEFAULTS, originalPivot, result);
  const f = focal(layout.height);

  for (const item of result.items) if (moving.has(item.id)) {
    const z0 = item.body.z, z1 = numeric(z0 + wz);
    if (z1 <= 0 || z1 > 100) fail('STUDIO_MOVE_UNAVAILABLE', 'Translated world depth must stay within (0, 100].');
    const [cx0, cy0] = center(item.bbox);
    const w0 = item.bbox[2] - item.bbox[0], h0 = item.bbox[3] - item.bbox[1];
    const X0 = (cx0 - layout.width / 2) * z0 / f, Y0 = (cy0 - layout.height / 2) * z0 / f;
    const X1 = numeric(X0 + wx), Y1 = numeric(Y0 + wy);
    const scale = z0 / z1;
    const cx1 = numeric(layout.width / 2 + f * X1 / z1), cy1 = numeric(layout.height / 2 + f * Y1 / z1);
    const w1 = numeric(w0 * scale), h1 = numeric(h0 * scale);
    item.bbox = [numeric(cx1 - w1 / 2), numeric(cy1 - h1 / 2), numeric(cx1 + w1 / 2), numeric(cy1 + h1 / 2)];
    if (item.bbox.some((v) => !Number.isFinite(v) || Math.abs(v) > 16384)
      || item.bbox[2] <= item.bbox[0] || item.bbox[3] <= item.bbox[1]) {
      fail('STUDIO_MOVE_UNAVAILABLE', 'Translation exceeds the editable bbox range.');
    }
    item.body = { ...item.body, z: z1 };
    bodies.set(item.id, item.body);
  }

  const nextPivot = pivotDepth(result, bodies);
  if (!followActive) {
    if (movedCamera) {
      result.camera = nextPivot === originalPivot ? originalCameraRecord
        : cameraAtPivot(originalCamera, originalPivot, nextPivot, baseFrame);
    }
    return finish(result);
  }

  const translatedFrame = {
    ...baseFrame,
    position: [
      numeric(baseFrame.position[0] + wx),
      numeric(baseFrame.position[1] + wy),
      numeric(baseFrame.position[2] + wz),
    ],
  };
  const baseActiveCamera = movedCamera ? { ...originalCamera, enabled: true } : { ...STUDIO_CAMERA_DEFAULTS, enabled: true };
  result.camera = cameraAtPivot(baseActiveCamera, originalPivot, nextPivot, translatedFrame);

  try {
    const projected = projectStudioLayout(result);
    const metrics = framingMetrics(projected, followGoal.ids);
    const sizeTol = Math.max(0.05, followGoal.size * 0.0001);
    if (metrics && Math.hypot(followGoal.cx - metrics.cx, followGoal.cy - metrics.cy) <= 0.05
      && Math.abs(followGoal.size - metrics.size) <= sizeTol) {
      return finish(result);
    }
  } catch (error) {
    if (!['STUDIO_CAMERA_DEGENERATE', 'STUDIO_CAMERA_NUMERIC'].includes(error.code)) throw error;
  }

  return followStudioCamera(result, {}, followGoal, { keepSize: true });
}

/**
 * Translate one world plane using a finite-difference Jacobian. Group/freeze members receive
 * the SAME world XY displacement (different depths therefore need different bbox deltas).
 * freeze=true selects all movable worlds; locked items AND their groups stay untouched.
 */
export function moveStudioItems(layout, ids, dx, dy, { freeze = false, follow = false, individual = false, grabId = null } = {}) {
  guard(layout); finite(dx, 'dx'); finite(dy, 'dy');
  if (typeof freeze !== 'boolean' || typeof follow !== 'boolean' || typeof individual !== 'boolean') {
    fail('STUDIO_INVALID_INPUT', 'Movement flags must be boolean.');
  }
  const { selected, members } = selectMovableMembers(layout, ids, { freeze, individual });
  const result = copy(layout);
  if (!members.length || (dx === 0 && dy === 0)) return result;
  const moving = new Set(members.map((item) => item.id));
  // Freeze all affected inference before changing bbox; otherwise movement can alter depth/pivot.
  for (const item of result.items) if (moving.has(item.id)) item.body = studioBody(item, layout);
  const bodies = new Map(result.items.map((item) => [item.id, studioBody(item, result)]));
  const originalPivot = pivotDepth(result, bodies), originalCamera = cameraOf(result);
  const originalCameraRecord = result.camera, movedCamera = studioCameraMoved(result);
  const fixedFrame = movedCamera ? cameraFrame(originalCamera, originalPivot, result) : null;
  if (grabId !== null && !members.some(item => item.id === grabId)) fail('STUDIO_INVALID_INPUT', 'Drag reference must be a movable selected world item.');
  const reference = members.find(item => item.id === grabId) ?? members.find((item) => selected.has(item.id)) ?? members[0];
  const initial = projectStudioLayout(result).items[reference.id];
  if (!(initial.depth > NEAR) || initial.corners?.some((point) => point === null)) fail('STUDIO_MOVE_UNAVAILABLE', 'Cannot drag a behind/near-plane subject.');
  const origin = center(initial.raw), target = [origin[0] + dx, origin[1] + dy];
  const originals = new Map(result.items.map((item) => [item.id, [...item.bbox]]));
  const f = focal(layout.height);
  const apply = (wx, wy) => {
    for (const item of result.items) if (moving.has(item.id)) {
      const before = originals.get(item.id), sx = f * wx / item.body.z, sy = f * wy / item.body.z;
      item.bbox = [before[0] + sx, before[1] + sy, before[2] + sx, before[3] + sy];
      if (item.bbox.some((v) => !Number.isFinite(v) || Math.abs(v) > 16384)) fail('STUDIO_MOVE_UNAVAILABLE', 'Drag exceeds the editable bbox range.');
    }
    if (movedCamera) {
      const nextPivot = pivotDepth(result, bodies);
      result.camera = nextPivot === originalPivot ? originalCameraRecord
        : cameraAtPivot(originalCamera, originalPivot, nextPivot, fixedFrame);
    }
    const view = projectStudioLayout(result).items[reference.id];
    if (!(view.depth > NEAR) || view.corners?.some((point) => point === null)) fail('STUDIO_MOVE_UNAVAILABLE', 'Drag crosses the near plane.');
    return center(view.raw);
  };
  let wx = 0, wy = 0;
  try {
    for (let iteration = 0; iteration < 18; iteration++) {
      const p = apply(wx, wy), ex = target[0] - p[0], ey = target[1] - p[1];
      if (Math.hypot(ex, ey) < 0.005) {
        if (!follow) return finish(result);
        return translateStudioItems(layout, ids, [wx, wy, 0], { freeze, follow: true, individual });
      }
      const step = 0.00001 * Math.max(1, result.items.find((item) => item.id === reference.id).body.z);
      const px = apply(wx + step, wy), py = apply(wx, wy + step);
      const delta = inverse2((px[0] - p[0]) / step, (py[0] - p[0]) / step,
        (px[1] - p[1]) / step, (py[1] - p[1]) / step, ex, ey);
      if (!delta) break;
      // Backtracking avoids taking an unstable full Newton step across a camera singularity.
      let accepted = false;
      for (let factor = 1; factor >= 1 / 64; factor /= 2) {
        try {
          const next = apply(wx + delta[0] * factor, wy + delta[1] * factor);
          if (Math.hypot(target[0] - next[0], target[1] - next[1]) < Math.hypot(ex, ey)) {
            wx += delta[0] * factor; wy += delta[1] * factor; accepted = true; break;
          }
        } catch (error) {
          if (!['STUDIO_MOVE_UNAVAILABLE', 'STUDIO_CAMERA_DEGENERATE', 'STUDIO_CAMERA_NUMERIC'].includes(error.code)) throw error;
        }
      }
      if (!accepted) break;
    }
  } catch (error) {
    if (!['STUDIO_CAMERA_DEGENERATE', 'STUDIO_CAMERA_NUMERIC'].includes(error.code)) throw error;
  }
  fail('STUDIO_MOVE_UNAVAILABLE', 'Screen drag could not be inverted reliably on the fixed-depth plane.');
}

export function studioCameraText(layout) {
  const camera = cameraOf(layout);
  if (!camera.enabled) return '';
  const phrases = ['Camera composition guide'];
  if (Math.abs(camera.orbit) >= 5) phrases.push(`${Math.abs(camera.orbit).toFixed(0)} degree ${camera.orbit > 0 ? 'right' : 'left'} orbit`);
  if (Math.abs(camera.pitch) >= 5) phrases.push(camera.pitch > 0 ? 'high-angle view' : 'low-angle view');
  if (Math.abs(camera.roll) >= 5) phrases.push('tilted framing');
  if (camera.distance < 0.8) phrases.push('close framing');
  else if (camera.distance > 1.3) phrases.push('wide framing');
  if (camera.fov > 65) phrases.push('wide-angle perspective');
  else if (camera.fov < 35) phrases.push('narrow field of view');
  return `${phrases.join(', ')}.`.slice(0, 320);
}
