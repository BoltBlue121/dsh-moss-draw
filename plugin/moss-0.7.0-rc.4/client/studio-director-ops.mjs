/**
 * Pure Director operations and camera/top-view helpers.
 * Browser-safe ESM; reuses studio-camera and studio-domain without mutating inputs.
 */

import {
  STUDIO_CAMERA_DEFAULTS,
  studioBody,
  studioCameraFrame,
  projectStudioLayout,
  captureStudioFraming,
  followStudioCamera,
  frameStudioCamera,
  translateStudioItems,
  moveStudioItems,
} from '../src/studio-camera.mjs';
import { validateStudioDoc } from '../src/studio-domain.mjs';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const NEAR = 0.0001;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const copy = (value) => JSON.parse(JSON.stringify(value));
const center = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
const area = (b) => Math.max(0, (b[2] - b[0]) * (b[3] - b[1]));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function finite(value, name = 'parameter') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('STUDIO_INVALID_INPUT', `${name} must be a finite number.`);
  }
  return value;
}

function validateLayout(layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    fail('STUDIO_INVALID_INPUT', 'Expected a Studio layout object.');
  }
  const validated = validateStudioDoc({
    kind: 'layout',
    layout,
    caption: { caption: '' },
  });
  return validated.layout;
}

export const STUDIO_VIEW_PRESETS = Object.freeze([
  Object.freeze({ id: 'front', label: '平视正前', patch: Object.freeze({}) }),
  Object.freeze({ id: 'high-soft', label: '轻俯视 15°', patch: Object.freeze({ pitch: 15 }) }),
  Object.freeze({ id: 'high', label: '高机位俯视 40°', patch: Object.freeze({ pitch: 40 }) }),
  Object.freeze({ id: 'top-down', label: '鸟瞰顶视 78°', patch: Object.freeze({ pitch: 78, distance: 1.15 }) }),
  Object.freeze({ id: 'low', label: '低机位仰视 -30°', patch: Object.freeze({ pitch: -30 }) }),
  Object.freeze({ id: 'left-45', label: '左前侧 -45°', patch: Object.freeze({ orbit: -45 }) }),
  Object.freeze({ id: 'right-45', label: '右前侧 45°', patch: Object.freeze({ orbit: 45 }) }),
  Object.freeze({ id: 'right-90', label: '正侧面 90°', patch: Object.freeze({ orbit: 90 }) }),
  Object.freeze({ id: 'back-180', label: '背向反打 180°', patch: Object.freeze({ orbit: 180 }) }),
  Object.freeze({ id: 'dutch-15', label: '斜角滚转 15°', patch: Object.freeze({ roll: 15 }) }),
  Object.freeze({ id: 'wide-close', label: '广角贴近 85°', patch: Object.freeze({ fov: 85, distance: 0.55 }) }),
  Object.freeze({ id: 'tele-far', label: '长焦压缩 22°', patch: Object.freeze({ fov: 22, distance: 2.4 }) }),
  Object.freeze({ id: 'close-up', label: '近景推进 0.55x', patch: Object.freeze({ distance: 0.55 }) }),
]);

export function studioPresetPatch(presetOrId) {
  const preset = typeof presetOrId === 'string'
    ? STUDIO_VIEW_PRESETS.find((entry) => entry.id === presetOrId)
    : presetOrId;
  if (!preset || typeof preset !== 'object' || !preset.patch) {
    fail('STUDIO_INVALID_INPUT', 'Unknown camera preset.');
  }
  return { ...STUDIO_CAMERA_DEFAULTS, ...preset.patch, enabled: true };
}

function validateCameraPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    fail('STUDIO_INVALID_INPUT', 'Expected a camera patch object.');
  }
  for (const key of Object.keys(patch)) {
    if (!Object.hasOwn(STUDIO_CAMERA_DEFAULTS, key)) {
      fail('STUDIO_INVALID_INPUT', `Unknown camera field: ${key}`);
    }
    if (key === 'enabled') {
      if (typeof patch.enabled !== 'boolean') {
        fail('STUDIO_INVALID_INPUT', 'camera.enabled must be boolean.');
      }
    } else {
      finite(patch[key], `camera.${key}`);
    }
  }
}

export function applyStudioCameraChange(layout, patch = {}, { follow = null, keepSize = true, manual = false } = {}) {
  const baseLayout = validateLayout(layout);
  validateCameraPatch(patch);
  if (typeof keepSize !== 'boolean' || typeof manual !== 'boolean') {
    fail('STUDIO_INVALID_INPUT', 'keepSize and manual must be booleans.');
  }

  const nextCamera = {
    ...STUDIO_CAMERA_DEFAULTS,
    ...baseLayout.camera,
    ...patch,
    enabled: patch.enabled !== undefined ? patch.enabled : true,
  };
  const directLayout = validateLayout({
    ...copy(baseLayout),
    camera: nextCamera,
  });

  if (nextCamera.enabled === false) {
    return { layout: directLayout, follow: null };
  }

  if (!follow) {
    return { layout: directLayout, follow: null };
  }

  if (!follow || typeof follow !== 'object' || !Array.isArray(follow.ids) || !follow.ids.length) {
    return { layout: directLayout, follow: null, notice: '跟随目标无效，已自动解除跟随。' };
  }

  const hasExplicitPan = Object.hasOwn(patch, 'pan_x') || Object.hasOwn(patch, 'pan_y');
  const hasManualDistance = Object.hasOwn(patch, 'distance') && keepSize;
  const shouldRecapture = manual || hasExplicitPan || hasManualDistance;

  if (shouldRecapture) {
    try {
      const recaptured = captureStudioFraming(directLayout, follow.ids);
      if (recaptured.ids.length !== follow.ids.length) {
        return { layout: directLayout, follow: null, notice: '跟随目标已隐藏或不可用，已解除跟随。' };
      }
      return { layout: directLayout, follow: recaptured };
    } catch (error) {
      if (['STUDIO_FOLLOW_UNAVAILABLE', 'STUDIO_ITEM_NOT_FOUND'].includes(error.code)) {
        return { layout: directLayout, follow: null, notice: '跟随目标不可见或超出可解范围，已解除跟随。' };
      }
      throw error;
    }
  }

  try {
    const followedLayout = validateLayout(
      followStudioCamera(baseLayout, { ...patch, enabled: true }, follow, { keepSize }),
    );
    return { layout: followedLayout, follow: copy(follow) };
  } catch (error) {
    if (['STUDIO_FOLLOW_UNAVAILABLE', 'STUDIO_ITEM_NOT_FOUND'].includes(error.code)) {
      return {
        layout: directLayout,
        follow: null,
        notice: '跟随主体超出可解范围或已丢失，已切换为自由机位。',
      };
    }
    throw error;
  }
}

function selectFramingTargets(layout, mode, ids = []) {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    fail('STUDIO_INVALID_INPUT', 'Expected an array of item ids.');
  }
  const byId = new Map(layout.items.map((item) => [item.id, item]));
  for (const id of ids) {
    if (!byId.has(id)) fail('STUDIO_ITEM_NOT_FOUND', `Unknown item id: ${id}`);
  }
  const worldItems = layout.items.filter((item) => !item.hidden && studioBody(item, layout).anchor === 'world');
  if (!worldItems.length) {
    fail('STUDIO_FRAME_UNAVAILABLE', 'No non-hidden world items available to frame.');
  }
  if (ids.length) {
    const wanted = new Set(ids);
    const chosen = worldItems.filter((item) => wanted.has(item.id)).map((item) => item.id);
    if (!chosen.length) {
      fail('STUDIO_FRAME_UNAVAILABLE', 'Selected items do not include any visible world bodies.');
    }
    return chosen;
  }
  if (mode === 'smart' || mode === 'fit') {
    return worldItems.map((item) => item.id);
  }
  // subject / center / fill default to defaultSubject from base original layout
  const baseGoal = captureStudioFraming({ ...layout, camera: { enabled: false } }, []);
  return baseGoal.ids;
}

function rawUnion(projected, targetIds) {
  const selected = targetIds.map((id) => projected.items[id]);
  if (!selected.length || selected.some((item) => !item || !(item.depth > NEAR)
    || !Array.isArray(item.corners) || item.corners.some((pt) => pt === null))) {
    return null;
  }
  const xs = selected.flatMap((item) => [item.raw[0], item.raw[2]]);
  const ys = selected.flatMap((item) => [item.raw[1], item.raw[3]]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  return box.every(Number.isFinite) ? box : null;
}

function insideCanvas(box, layout, margin = 0) {
  return Boolean(
    box
    && box[0] >= margin * layout.width - 1e-4
    && box[1] >= margin * layout.height - 1e-4
    && box[2] <= (1 - margin) * layout.width + 1e-4
    && box[3] <= (1 - margin) * layout.height + 1e-4,
  );
}

function recoverStartLayout(layout, targetIds) {
  try {
    const projected = projectStudioLayout(layout);
    if (rawUnion(projected, targetIds)) return layout;
  } catch {
    // recover below
  }
  try {
    return frameStudioCamera(layout, targetIds);
  } catch {
    return layout;
  }
}

function solveSpanRatio(layout, targetIds, targetRatio) {
  let working = recoverStartLayout(layout, targetIds);
  const cxGoal = layout.width / 2;
  const cyGoal = layout.height / 2;

  // Center at current distance or initial guess first
  let currentSize = Math.sqrt(layout.width * layout.height) * targetRatio;
  try {
    const initialProj = projectStudioLayout(working);
    const u0 = rawUnion(initialProj, targetIds);
    if (u0) {
      const span0 = Math.max((u0[2] - u0[0]) / layout.width, (u0[3] - u0[1]) / layout.height);
      const s0 = Math.sqrt(area(u0));
      if (span0 > 1e-6 && s0 > 1e-6) {
        currentSize = s0 * (targetRatio / span0);
      }
    }
  } catch {
    // use default currentSize
  }

  let bestLayout = null;
  let bestErr = Infinity;
  const meetsGoal = (candidate) => {
    const projected = projectStudioLayout(candidate), u = rawUnion(projected, targetIds);
    if (!insideCanvas(u, layout) || !targetIds.every(id => projected.items[id]?.visible && !projected.items[id]?.partial)) return false;
    const [cx, cy] = center(u);
    const span = Math.max((u[2] - u[0]) / layout.width, (u[3] - u[1]) / layout.height);
    return Math.hypot(cx - cxGoal, cy - cyGoal) <= 0.1 && Math.abs(span - targetRatio) <= 0.005;
  };

  for (let step = 0; step < 8; step++) {
    let candidate;
    try {
      candidate = followStudioCamera(
        working,
        {},
        { ids: targetIds, cx: cxGoal, cy: cyGoal, size: clamp(currentSize, 4, 8192) },
        { keepSize: true },
      );
    } catch {
      break;
    }
    const proj = projectStudioLayout(candidate);
    const u = rawUnion(proj, targetIds);
    if (!u) break;
    const span = Math.max((u[2] - u[0]) / layout.width, (u[3] - u[1]) / layout.height);
    const actualSize = Math.sqrt(area(u));
    if (!(span > 1e-6 && actualSize > 1e-6)) break;

    if (insideCanvas(u, layout, 0) && targetIds.every((id) => proj.items[id]?.visible && !proj.items[id]?.partial)) {
      const err = Math.abs(span - targetRatio);
      if (err < bestErr) {
        bestErr = err;
        bestLayout = candidate;
      }
      if (meetsGoal(candidate)) {
        return validateLayout(candidate);
      }
    }

    currentSize = actualSize * (targetRatio / span);
    working = candidate;
  }

  if (bestLayout && meetsGoal(bestLayout)) {
    return validateLayout(bestLayout);
  }

  // Fallback to frameStudioCamera if within bounds
  try {
    const framed = frameStudioCamera(layout, targetIds);
    if (meetsGoal(framed)) return validateLayout(framed);
  } catch { /* No fallback may claim success without the requested framing. */ }
  fail('STUDIO_FRAME_UNAVAILABLE', `Cannot fit target items cleanly at ratio ${targetRatio}.`);
}

export function frameStudioView(layout, mode = 'smart', ids = []) {
  const baseLayout = validateLayout(layout);
  if (!['smart', 'fit', 'subject', 'center', 'fill'].includes(mode)) {
    fail('STUDIO_INVALID_INPUT', `Unknown framing mode: ${mode}`);
  }
  const targetIds = selectFramingTargets(baseLayout, mode, ids);
  const enabledLayout = {
    ...copy(baseLayout),
    camera: { ...STUDIO_CAMERA_DEFAULTS, ...baseLayout.camera, enabled: true },
  };

  if (mode === 'center') {
    const cxGoal = baseLayout.width / 2;
    const cyGoal = baseLayout.height / 2;
    let sizeDummy = 256;
    try {
      const cap = captureStudioFraming(enabledLayout, targetIds);
      sizeDummy = cap.size;
    } catch {
      // keep default dummy size
    }
    try {
      const centered = followStudioCamera(
        enabledLayout,
        {},
        { ids: targetIds, cx: cxGoal, cy: cyGoal, size: sizeDummy },
        { keepSize: false },
      );
      const proj = projectStudioLayout(centered);
      const u = rawUnion(proj, targetIds);
      if (!u || !targetIds.every((id) => proj.items[id]?.visible)) {
        fail('STUDIO_FRAME_UNAVAILABLE', 'Centered target is not visible at the current camera distance.');
      }
      return validateLayout(centered);
    } catch (error) {
      if (error.code === 'STUDIO_FOLLOW_UNAVAILABLE') {
        fail('STUDIO_FRAME_UNAVAILABLE', error.message);
      }
      throw error;
    }
  }

  if (mode === 'subject') {
    const baseGoal = captureStudioFraming({ ...baseLayout, camera: { enabled: false } }, targetIds);
    const working = recoverStartLayout(enabledLayout, targetIds);
    try {
      const solved = followStudioCamera(working, {}, baseGoal, { keepSize: true });
      const proj = projectStudioLayout(solved);
      if (!rawUnion(proj, targetIds) || !targetIds.every((id) => proj.items[id]?.visible)) {
        fail('STUDIO_FRAME_UNAVAILABLE', 'Subject baseline framing is not visible from this angle.');
      }
      return validateLayout(solved);
    } catch (error) {
      if (error.code === 'STUDIO_FOLLOW_UNAVAILABLE') {
        fail('STUDIO_FRAME_UNAVAILABLE', error.message);
      }
      throw error;
    }
  }

  if (mode === 'fit') {
    return solveSpanRatio(enabledLayout, targetIds, 0.88);
  }

  if (mode === 'fill') {
    return solveSpanRatio(enabledLayout, targetIds, 0.70);
  }

  // mode === 'smart': try base framing goal first; if it clips or is outside canvas, fall back to fit (0.88)
  try {
    const baseGoal = captureStudioFraming({ ...baseLayout, camera: { enabled: false } }, targetIds);
    const working = recoverStartLayout(enabledLayout, targetIds);
    const solved = followStudioCamera(working, {}, baseGoal, { keepSize: true });
    const proj = projectStudioLayout(solved);
    const u = rawUnion(proj, targetIds);
    if (u && insideCanvas(u, baseLayout) && targetIds.every((id) => proj.items[id]?.visible && !proj.items[id]?.partial)) {
      return validateLayout(solved);
    }
  } catch {
    // Fall back to fit
  }
  return solveSpanRatio(enabledLayout, targetIds, 0.88);
}

export function studioTopView(layout) {
  const cleanLayout = validateLayout(layout);
  const frame = studioCameraFrame(cleanLayout);
  const camera = { ...STUDIO_CAMERA_DEFAULTS, ...cleanLayout.camera };
  const activeCamera = camera.enabled ? camera : STUDIO_CAMERA_DEFAULTS;
  const f0 = cleanLayout.height / (2 * Math.tan(25 * RAD));
  const W = cleanLayout.width;

  const items = [];
  for (const item of cleanLayout.items) {
    if (item.hidden) continue;
    let body;
    try {
      body = studioBody(item, cleanLayout);
    } catch {
      continue;
    }
    if (body.anchor !== 'world') continue;
    const [cx] = center(item.bbox);
    const width = (item.bbox[2] - item.bbox[0]) * body.z / f0;
    const depth = width * body.thickness;
    const x = (cx - W / 2) * body.z / f0;
    const z = body.z;
    items.push({
      id: item.id,
      name: item.name || item.label,
      label: item.label,
      x,
      z,
      width,
      depth,
      yaw: body.yaw,
      locked: Boolean(item.locked),
    });
  }

  const target = [
    activeCamera.pan_x * frame.pivot,
    activeCamera.pan_y * frame.pivot,
    (1 + activeCamera.pan_z) * frame.pivot,
  ];
  const aspect = cleanLayout.width / cleanLayout.height;
  const vFovRad = activeCamera.fov * RAD;
  const hFovDeg = 2 * Math.atan(Math.tan(vFovRad / 2) * aspect) * DEG;

  const maxCoord = Math.max(
    2.5,
    Math.abs(frame.position[0]) + 0.5,
    Math.abs(frame.position[2]) + 0.5,
    Math.abs(target[0]) + 0.5,
    Math.abs(target[2]) + 0.5,
    ...items.map((it) => Math.max(Math.abs(it.x) + it.width / 2 + 0.3, Math.abs(it.z) + it.depth / 2 + 0.3)),
  );
  const viewWidth = 320;
  const viewHeight = 190;
  const originX = viewWidth / 2;
  const originY = 28;
  const scale = Math.min((viewWidth * 0.44) / maxCoord, (viewHeight - originY - 16) / maxCoord);

  return {
    frame,
    target,
    hFovDeg,
    items,
    mapping: {
      viewWidth,
      viewHeight,
      originX,
      originY,
      scale,
      extent: maxCoord,
    },
  };
}

export function cameraFromTopPoint(layout, x, z) {
  const cleanLayout = validateLayout(layout);
  finite(x, 'x');
  finite(z, 'z');
  const frame = studioCameraFrame(cleanLayout);
  const camera = { ...STUDIO_CAMERA_DEFAULTS, ...cleanLayout.camera };
  const targetX = camera.pan_x * frame.pivot;
  const targetZ = (1 + camera.pan_z) * frame.pivot;
  const dx = x - targetX;
  const dz = z - targetZ;
  const horizDist = Math.hypot(dx, dz);
  if (horizDist < 1e-5) {
    fail('STUDIO_CAMERA_UNAVAILABLE', 'Top-view camera point cannot coincide with the pivot target.');
  }
  // Forward in XZ is [-sin(orbit)*cos(pitch), cos(orbit)*cos(pitch)]
  // Position = target - forward * distance * pivot
  // So dx = position.x - target.x = sin(orbit) * cos(pitch) * distance * pivot
  // dz = position.z - target.z = -cos(orbit) * cos(pitch) * distance * pivot
  const orbitRaw = Math.atan2(dx, -dz) * DEG;
  const orbit = Math.round(clamp(orbitRaw, -180, 180) * 100) / 100;
  const cp = Math.max(Math.cos(camera.pitch * RAD), Math.cos(85 * RAD));
  const rawDistance = horizDist / (cp * frame.pivot);
  const distance = Math.round(clamp(rawDistance, 0.2, 5) * 1000) / 1000;
  return {
    enabled: true,
    orbit,
    distance,
  };
}

export function returnStudioItemsToView(layout, ids = []) {
  const cleanLayout = validateLayout(layout);
  if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string')) {
    fail('STUDIO_INVALID_INPUT', 'Expected a non-empty array of item ids.');
  }
  const byId = new Map(cleanLayout.items.map((item) => [item.id, item]));
  for (const id of ids) {
    if (!byId.has(id)) fail('STUDIO_ITEM_NOT_FOUND', `Unknown item id: ${id}`);
  }

  const wanted = new Set(ids);
  const groups = new Set(
    cleanLayout.items.filter((item) => wanted.has(item.id) && item.group).map((item) => item.group),
  );
  const lockedGroups = new Set(
    cleanLayout.items.filter((item) => item.locked && item.group).map((item) => item.group),
  );
  const expanded = cleanLayout.items.filter(
    (item) => wanted.has(item.id) || (item.group && groups.has(item.group)),
  );
  if (expanded.some((item) => item.locked || (item.group && lockedGroups.has(item.group)))) {
    fail('STUDIO_LOCKED', 'Selected item or group is locked.');
  }

  let working = copy(cleanLayout);
  const nonWorldIds = expanded
    .filter((item) => studioBody(item, working).anchor !== 'world')
    .map((item) => item.id);
  const worldMembers = expanded.filter((item) => studioBody(item, working).anchor === 'world');

  // 2D shift screen/backdrop items inside canvas if any were selected
  if (nonWorldIds.length) {
    const nonWorldSet = new Set(nonWorldIds);
    const batches = new Map();
    for (const item of working.items) if (nonWorldSet.has(item.id)) {
      const key = item.group ? `group:${item.group}` : `item:${item.id}`;
      if (!batches.has(key)) batches.set(key, []);
      batches.get(key).push(item);
    }
    for (const members of batches.values()) {
      const visible = members.filter(item => !item.hidden);
      if (!visible.length) continue;
      const bounds = [Math.min(...visible.map(i => i.bbox[0])), Math.min(...visible.map(i => i.bbox[1])), Math.max(...visible.map(i => i.bbox[2])), Math.max(...visible.map(i => i.bbox[3]))];
      if (bounds[2] - bounds[0] > working.width || bounds[3] - bounds[1] > working.height) {
        fail('STUDIO_MOVE_UNAVAILABLE', 'Selected screen/backdrop bounds cannot fit by translation alone.');
      }
      const dx = clamp(0, -bounds[0], working.width - bounds[2]);
      const dy = clamp(0, -bounds[1], working.height - bounds[3]);
      for (const item of members) {
        // Preserve legacy inferred anchor/depth before shifting its bbox.
        item.body = studioBody(item, cleanLayout);
        item.bbox = item.bbox.map((n, i) => n + (i % 2 ? dy : dx));
      }
    }
    if (!worldMembers.length) {
      return validateLayout(working);
    }
  }

  if (!worldMembers.length) {
    fail('STUDIO_MOVE_UNAVAILABLE', 'No movable items selected to return into view.');
  }

  const worldIds = worldMembers.filter(item => !item.hidden).map((item) => item.id);
  if (!worldIds.length) return validateLayout(working);
  const f0 = working.height / (2 * Math.tan(25 * RAD));
  const frame = studioCameraFrame(working);

  // Compute current average world center of moving world members
  const currentCenter = [0, 0, 0];
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const item of worldMembers) {
    const body = studioBody(item, working);
    const [cx, cy] = center(item.bbox);
    const wx = (cx - working.width / 2) * body.z / f0;
    const wy = (cy - working.height / 2) * body.z / f0;
    const wz = body.z;
    currentCenter[0] += wx / worldMembers.length;
    currentCenter[1] += wy / worldMembers.length;
    currentCenter[2] += wz / worldMembers.length;
    minZ = Math.min(minZ, wz);
    maxZ = Math.max(maxZ, wz);
  }

  const currentFrontDist = dot(
    [
      currentCenter[0] - frame.position[0],
      currentCenter[1] - frame.position[1],
      currentCenter[2] - frame.position[2],
    ],
    frame.forward,
  );

  const candidateDists = [
    ...(currentFrontDist >= 0.35 && currentFrontDist <= 12 ? [currentFrontDist] : []),
    frame.pivot,
    Math.max(0.6, frame.pivot * 1.2),
    1.0,
    1.5,
    2.2,
    3.2,
    0.75,
    4.5,
  ];

  const seenDists = new Set();
  for (const dFront of candidateDists) {
    const key = dFront.toFixed(4);
    if (seenDists.has(key)) continue;
    seenDists.add(key);

    const targetWorld = [
      frame.position[0] + frame.forward[0] * dFront,
      frame.position[1] + frame.forward[1] * dFront,
      frame.position[2] + frame.forward[2] * dFront,
    ];
    let delta = [
      targetWorld[0] - currentCenter[0],
      targetWorld[1] - currentCenter[1],
      targetWorld[2] - currentCenter[2],
    ];
    // Ensure all member depths z1 = z0 + dz stay in [0.15, 95]
    if (minZ + delta[2] < 0.15) {
      delta[2] = 0.15 - minZ;
    } else if (maxZ + delta[2] > 95) {
      delta[2] = 95 - maxZ;
    }

    try {
      let candidate = translateStudioItems(working, ids, delta, { freeze: false, follow: false, individual: false });
      let proj = projectStudioLayout(candidate);
      let u = rawUnion(proj, worldIds);
      for (let refine = 0; refine < 6 && u; refine++) {
        const [ux, uy] = center(u);
        const dx = working.width / 2 - ux;
        const dy = working.height / 2 - uy;
        if (Math.hypot(dx, dy) <= 0.5) break;
        let improved = false;
        // First try moveStudioItems; accept only if it strictly reduces the union center error
        try {
          const moved = moveStudioItems(candidate, ids, dx, dy, { freeze: false, follow: false, individual: false });
          const nextProj = projectStudioLayout(moved);
          const nextU = rawUnion(nextProj, worldIds);
          if (nextU) {
            const [nux, nuy] = center(nextU);
            if (Math.hypot(working.width / 2 - nux, working.height / 2 - nuy) < Math.hypot(dx, dy) * 0.9) {
              candidate = moved;
              proj = nextProj;
              u = nextU;
              improved = true;
            }
          }
        } catch {
          // fall through to camera-plane world translation
        }
        if (!improved) {
          const stepWorld = [
            (frame.right[0] * dx + frame.down[0] * dy) * (dFront / frame.focal),
            (frame.right[1] * dx + frame.down[1] * dy) * (dFront / frame.focal),
            (frame.right[2] * dx + frame.down[2] * dy) * (dFront / frame.focal),
          ];
          try {
            const moved = translateStudioItems(candidate, ids, stepWorld, { freeze: false, follow: false, individual: false });
            const nextProj = projectStudioLayout(moved);
            const nextU = rawUnion(nextProj, worldIds);
            if (nextU) {
              const [nux, nuy] = center(nextU);
              if (Math.hypot(working.width / 2 - nux, working.height / 2 - nuy) < Math.hypot(dx, dy)) {
                candidate = moved;
                proj = nextProj;
                u = nextU;
                improved = true;
              }
            }
          } catch {
            // stop refining
          }
        }
        if (!improved) break;
      }
      if (insideCanvas(u, working) && worldIds.every((id) => proj.items[id]?.visible && !proj.items[id]?.partial)) {
        return validateLayout(candidate);
      }
    } catch (error) {
      if (!['STUDIO_MOVE_UNAVAILABLE', 'STUDIO_CAMERA_DEGENERATE', 'STUDIO_CAMERA_NUMERIC'].includes(error.code)) {
        throw error;
      }
    }
  }

  fail('STUDIO_MOVE_UNAVAILABLE', 'Could not return selected items into camera view with fixed camera.');
}

export function studioCameraReadout(layout) {
  const cleanLayout = validateLayout(layout);
  const camera = { ...STUDIO_CAMERA_DEFAULTS, ...cleanLayout.camera };
  const focalMm = 24 / (2 * Math.tan((camera.fov * RAD) / 2));
  const framing = camera.distance * Math.tan((camera.fov * RAD) / 2) / Math.tan(25 * RAD);

  const orbitText = Math.abs(camera.orbit) < 5
    ? '正面'
    : `${camera.orbit > 0 ? '右侧' : '左侧'}环绕 ${Math.round(Math.abs(camera.orbit))}°`;
  const pitchText = Math.abs(camera.pitch) < 5
    ? '平视'
    : camera.pitch >= 55
      ? `鸟瞰俯视 ${Math.round(camera.pitch)}°`
      : camera.pitch > 0
        ? `俯视 ${Math.round(camera.pitch)}°`
        : `仰视 ${Math.round(Math.abs(camera.pitch))}°`;
  const rollText = Math.abs(camera.roll) < 3
    ? ''
    : ` · 倾斜 ${Math.round(camera.roll)}°`;
  const shotText = framing < 0.65
    ? '特写/近景'
    : framing < 0.9
      ? '中近景'
      : framing <= 1.25
        ? '标准中景'
        : framing <= 1.8
          ? '全景'
          : '远景';
  const lensText = `约 ${focalMm.toFixed(0)}mm 等效（垂直 FOV ${Math.round(camera.fov)}°）`;
  const statusPrefix = camera.enabled ? '' : '（未启用，当前为基准视口）';
  const text = `${statusPrefix}${orbitText} · ${pitchText}${rollText} · ${shotText}（取景比 ${framing.toFixed(2)}x） · ${lensText} · 仅作构图辅助，非真实3D标定`;

  return {
    text,
    focalMm,
    framing,
  };
}
