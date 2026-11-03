/**
 * Pure explicit Studio body estimation and group-depth alignment helper.
 * Independent implementation of functional heuristics for explicit body estimation;
 * legacy implicit studioBody in studio-camera.mjs remains unchanged.
 * Browser-safe ESM: no Node imports, no domain import (avoids camera cycles).
 */

const MAX_BYTES = 512 * 1024;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round2 = (value) => Math.round(value * 100) / 100;
const boxWidth = (bbox) => bbox[2] - bbox[0];
const boxHeight = (bbox) => bbox[3] - bbox[1];
const boxArea = (bbox) => boxWidth(bbox) * boxHeight(bbox);
const copy = (value) => JSON.parse(JSON.stringify(value));

const BACKDROP_ENGLISH_TERMS = Object.freeze([
  'background', 'backdrop', 'sky', 'skies', 'cloud', 'clouds', 'sunset', 'sunrise', 'night sky',
  'horizon', 'wall', 'ceiling', 'floor', 'ground', 'room', 'interior', 'hallway', 'corridor',
  'landscape', 'scenery', 'mountain', 'mountains', 'hill', 'hills', 'forest', 'woods', 'field',
  'meadow', 'desert', 'valley', 'cityscape', 'street', 'water', 'ocean', 'sea', 'lake', 'river',
  'pond', 'beach', 'shore',
]);

const BACKDROP_CHINESE_TERMS = Object.freeze([
  '背景', '远景', '底图', '天空', '天际', '云层', '晚霞', '夕阳', '夜空', '星空',
  '墙面', '墙壁', '背景墙', '天花板', '地面', '地板', '室内', '房间', '走廊', '大厅',
  '风景', '山脉', '远山', '群山', '山坡', '森林', '树林', '草地', '草原', '原野',
  '沙漠', '峡谷', '街景', '城市背景', '水面', '大海', '海洋', '湖面', '湖水', '河水',
  '河流', '海滩', '海岸',
]);

function fail(code, message) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

function finite(value, name = 'geometry') {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('STUDIO_INVALID_INPUT', `${name} must be a finite number.`);
  }
  return value;
}

function validateBbox(bbox, path = 'bbox') {
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    fail('STUDIO_INVALID_INPUT', `${path} must be a 4-element xyxy array.`);
  }
  for (let i = 0; i < 4; i++) {
    const coord = finite(bbox[i], `${path}[${i}]`);
    if (Math.abs(coord) > 16384) {
      fail('STUDIO_INVALID_INPUT', `${path}[${i}] exceeds ±16384.`);
    }
  }
  if (bbox[2] <= bbox[0] || bbox[3] <= bbox[1]) {
    fail('STUDIO_INVALID_INPUT', `${path} must have positive width and height.`);
  }
  const area = boxArea(bbox);
  if (!Number.isFinite(area) || area <= 0) {
    fail('STUDIO_INVALID_INPUT', `${path} area must be finite and positive.`);
  }
  return bbox;
}

function validateBodyRecord(body, path = 'body') {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail('STUDIO_INVALID_INPUT', `${path} must be an object.`);
  }
  const z = finite(body.z, `${path}.z`);
  const thickness = finite(body.thickness, `${path}.thickness`);
  const yaw = finite(body.yaw, `${path}.yaw`);
  if (z <= 0 || z > 100) {
    fail('STUDIO_INVALID_INPUT', `${path}.z must be within (0, 100].`);
  }
  if (thickness < 0 || thickness > 10) {
    fail('STUDIO_INVALID_INPUT', `${path}.thickness must be within [0, 10].`);
  }
  if (yaw < -360 || yaw > 360) {
    fail('STUDIO_INVALID_INPUT', `${path}.yaw must be within [-360, 360].`);
  }
  if (!['world', 'screen', 'backdrop'].includes(body.anchor)) {
    fail('STUDIO_INVALID_INPUT', `${path}.anchor must be world, screen, or backdrop.`);
  }
  return { z, thickness, yaw, anchor: body.anchor };
}

function validateItem(item, path = 'item') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    fail('STUDIO_INVALID_INPUT', `${path} must be an object.`);
  }
  if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 80) {
    fail('STUDIO_INVALID_INPUT', `${path}.id must be a nonblank string.`);
  }
  if (!['object', 'character', 'text'].includes(item.label)) {
    fail('STUDIO_INVALID_INPUT', `${path}.label must be object, character, or text.`);
  }
  validateBbox(item.bbox, `${path}.bbox`);
  if (item.body !== undefined) {
    validateBodyRecord(item.body, `${path}.body`);
  }
}

function validateLayout(layout) {
  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    fail('STUDIO_INVALID_INPUT', 'Expected a Studio layout object.');
  }
  const width = finite(layout.width, 'layout.width');
  const height = finite(layout.height, 'layout.height');
  if (width <= 0 || height <= 0 || width > 4096 || height > 4096) {
    fail('STUDIO_INVALID_INPUT', 'Canvas dimensions must be in (0, 4096].');
  }
  if (layout.bbox_coord_space !== undefined && layout.bbox_coord_space !== 'abs') {
    fail('STUDIO_INVALID_INPUT', 'layout.bbox_coord_space must be abs.');
  }
  if (layout.bbox_format !== undefined && layout.bbox_format !== 'xyxy') {
    fail('STUDIO_INVALID_INPUT', 'layout.bbox_format must be xyxy.');
  }
  if (!Array.isArray(layout.items) || layout.items.length > 128) {
    fail('STUDIO_INVALID_INPUT', 'layout.items must be an array of at most 128 items.');
  }
  const ids = new Set();
  for (let i = 0; i < layout.items.length; i++) {
    const entry = layout.items[i];
    validateItem(entry, `layout.items[${i}]`);
    if (ids.has(entry.id)) {
      fail('STUDIO_INVALID_INPUT', `Duplicate item id: ${entry.id}`);
    }
    ids.add(entry.id);
  }
  if (layout.perspective !== undefined) {
    if (!layout.perspective || typeof layout.perspective !== 'object' || Array.isArray(layout.perspective)) {
      fail('STUDIO_INVALID_INPUT', 'layout.perspective must be an object.');
    }
    if (layout.perspective.horizon_y !== undefined) {
      finite(layout.perspective.horizon_y, 'layout.perspective.horizon_y');
    }
  }
}

function finishLayout(layout) {
  validateLayout(layout);
  if (new TextEncoder().encode(JSON.stringify(layout)).length > MAX_BYTES) {
    fail('STUDIO_INVALID_INPUT', 'Layout exceeds 512 KiB.');
  }
  return layout;
}

function hasBackdropWords(item) {
  const raw = `${typeof item.name === 'string' ? item.name : ''} ${typeof item.caption === 'string' ? item.caption : ''}`.toLowerCase();
  if (!raw.trim()) return false;
  for (const term of BACKDROP_CHINESE_TERMS) {
    if (raw.includes(term)) return true;
  }
  const tokens = raw.split(/[^a-z0-9]+/).filter(Boolean);
  const tokenSet = new Set(tokens);
  for (const term of BACKDROP_ENGLISH_TERMS) {
    if (term.includes(' ')) {
      if (raw.includes(term)) return true;
    } else if (tokenSet.has(term)) {
      return true;
    }
  }
  return false;
}

function isBackdropCandidate(item, layout) {
  if (item.label !== 'object') return false;
  const W = layout.width;
  const H = layout.height;
  const canvasArea = W * H;
  const w = boxWidth(item.bbox);
  const h = boxHeight(item.bbox);
  const a = w * h;
  if (w >= 0.9 * W && h >= 0.6 * H) return true;
  const bgWords = hasBackdropWords(item);
  if (a > 0.5 * canvasArea && bgWords) return true;
  if (w >= 0.85 * W && a > 0.15 * canvasArea && (item.depth === 'bg' || bgWords)) return true;
  return false;
}

function horizonY(layout) {
  const p = layout.perspective;
  if (p && p.enabled === true && typeof p.horizon_y === 'number' && Number.isFinite(p.horizon_y)) {
    return p.horizon_y;
  }
  return 0.45 * layout.height;
}

function inferThickness(item) {
  if (item.label === 'character') return 0.45;
  const w = boxWidth(item.bbox);
  const h = boxHeight(item.bbox);
  if (w > 3 * h || h > 4 * w) return 0.12;
  return 0.6;
}

/**
 * Independent ground or aerial depth estimate for a world item (no parent attachment).
 */
function independentWorldDepth(item, layout) {
  const H = layout.height;
  const W = layout.width;
  const hy = horizonY(layout);
  const bottom = item.bbox[3];
  let rawZ;
  if (bottom > hy + 0.05 * H) {
    rawZ = (H - hy) / (bottom - hy);
  } else {
    const a = Math.max(1, boxArea(item.bbox));
    rawZ = Math.sqrt((0.18 * W * H) / a);
  }
  if (!Number.isFinite(rawZ)) rawZ = 1;
  return round2(clamp(rawZ, 0.4, 8));
}

/**
 * Base anchor & body without parent attachment, optionally ignoring existing body on unlocked items.
 */
function baseEstimate(item, layout, useExistingBody = true) {
  if (useExistingBody && item.body) {
    return validateBodyRecord(item.body);
  }
  if (item.label === 'text') {
    return { z: 1, thickness: 0.05, yaw: 0, anchor: 'screen' };
  }
  if (isBackdropCandidate(item, layout)) {
    return { z: 6, thickness: 0, yaw: 0, anchor: 'backdrop' };
  }
  return {
    z: independentWorldDepth(item, layout),
    thickness: inferThickness(item),
    yaw: 0,
    anchor: 'world',
  };
}

function intersectionArea(a, b) {
  const dx = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const dy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  return dx * dy;
}

function groupName(item) {
  return typeof item.group === 'string' && item.group.trim() ? item.group : '';
}

function estimateWithMode(item, layout, { respectUnlockedBodies = true } = {}) {
  const canUseSelfBody = Boolean(item.body) && (respectUnlockedBodies || item.locked === true);
  if (canUseSelfBody) {
    return validateBodyRecord(item.body);
  }
  const own = baseEstimate(item, layout, false);
  if (own.anchor !== 'world') {
    return own;
  }

  const childGroup = groupName(item);
  const canAttach = item.label === 'object' || Boolean(childGroup);
  if (!canAttach) {
    return own;
  }

  const childArea = boxArea(item.bbox);
  const items = layout.items;
  const selfIndex = items.findIndex((entry) => entry.id === item.id);

  let bestSameGroup = null;
  let bestSameGroupOverlap = -1;
  let bestSameGroupIndex = -1;

  let bestChar = null;
  let bestCharOverlap = -1;
  let bestCharIndex = -1;

  for (let i = 0; i < items.length; i++) {
    const candidate = items[i];
    if (candidate.id === item.id || candidate.hidden === true || candidate.label === 'text') continue;
    const candUseExisting = Boolean(candidate.body) && (respectUnlockedBodies || candidate.locked === true);
    const candBase = baseEstimate(candidate, layout, candUseExisting);
    if (candBase.anchor !== 'world') continue;

    const candArea = boxArea(candidate.bbox);
    if (!(candArea > childArea)) continue;

    const overlap = intersectionArea(item.bbox, candidate.bbox);
    if (overlap < 0.1 * childArea) continue;

    const sameGroup = Boolean(childGroup) && groupName(candidate) === childGroup;
    if (sameGroup) {
      if (overlap > bestSameGroupOverlap) {
        bestSameGroup = { candidate, z: candBase.z };
        bestSameGroupOverlap = overlap;
        bestSameGroupIndex = i;
      }
    } else if (item.label === 'object' && candidate.label === 'character') {
      if (overlap > bestCharOverlap) {
        bestChar = { candidate, z: candBase.z };
        bestCharOverlap = overlap;
        bestCharIndex = i;
      }
    }
  }

  const chosen = bestSameGroup ?? bestChar;
  const parentIndex = bestSameGroup ? bestSameGroupIndex : bestCharIndex;
  if (!chosen) {
    return own;
  }

  const childAfterParent = selfIndex > parentIndex;
  const factor = childAfterParent ? 0.97 : 1.03;
  const attachedZ = round2(clamp(chosen.z * factor, 0.15, 12));
  return {
    ...own,
    z: attachedZ,
  };
}

/**
 * Estimate or copy a single item's 3D composition body inside a Studio layout.
 */
export function estimateStudioBody(item, layout) {
  validateLayout(layout);
  validateItem(item, 'item');
  return estimateWithMode(item, layout, { respectUnlockedBodies: true });
}

/**
 * Return a detached layout with estimated bodies for missing (or all unlocked) items.
 * Locked items remain byte-for-byte identical. When onlyMissing is false, unlocked parent
 * depths come from fresh independent estimates rather than stale manual bodies.
 */
export function estimateStudioLayoutBodies(layout, { onlyMissing = true } = {}) {
  validateLayout(layout);
  if (typeof onlyMissing !== 'boolean') {
    fail('STUDIO_INVALID_INPUT', 'onlyMissing must be a boolean.');
  }
  const result = copy(layout);
  for (const entry of result.items) {
    if (entry.locked === true) continue;
    if (onlyMissing && entry.body) continue;
    entry.body = estimateWithMode(entry, layout, { respectUnlockedBodies: onlyMissing });
  }
  return finishLayout(result);
}

/**
 * Align depths of selected world non-text members from largest to smallest so smaller
 * overlapping members follow their strictly larger holder's depth with front/back layer offset.
 * Note: Unlike automatic body estimation (which excludes `hidden: true` items from acting as
 * holders), explicit group alignment honors all explicitly selected non-text world members
 * (including selected hidden or locked parents) as eligible depth anchors.
 */
export function alignStudioGroupDepth(layout, ids) {
  validateLayout(layout);
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    fail('STUDIO_INVALID_INPUT', 'Expected an array of item ids.');
  }
  const indexById = new Map(layout.items.map((item, idx) => [item.id, idx]));
  for (const id of ids) {
    if (!indexById.has(id)) {
      fail('STUDIO_ITEM_NOT_FOUND', `Unknown item id: ${id}`);
    }
  }

  const wanted = new Set(ids);
  const result = copy(layout);
  const selectedWorld = [];

  for (let i = 0; i < result.items.length; i++) {
    const entry = result.items[i];
    if (!wanted.has(entry.id) || entry.label === 'text') continue;
    const effectiveBody = entry.body
      ? validateBodyRecord(entry.body)
      : estimateWithMode(entry, layout, { respectUnlockedBodies: true });
    if (effectiveBody.anchor !== 'world') continue;
    if (!entry.locked && !entry.body) {
      entry.body = { ...effectiveBody };
    }
    selectedWorld.push({
      id: entry.id,
      index: i,
      area: boxArea(entry.bbox),
      bbox: entry.bbox,
      locked: entry.locked === true,
      body: entry.body ? { ...entry.body } : { ...effectiveBody },
    });
  }

  // Sort descending by bbox area; break ties deterministically by original array index.
  selectedWorld.sort((a, b) => (b.area - a.area) || (a.index - b.index));

  for (let i = 0; i < selectedWorld.length; i++) {
    const child = selectedWorld[i];
    if (child.locked) continue;

    let bestParent = null;
    let bestOverlap = -1;
    for (let j = 0; j < i; j++) {
      const candidate = selectedWorld[j];
      if (!(candidate.area > child.area)) continue;
      const overlap = intersectionArea(child.bbox, candidate.bbox);
      if (overlap < 0.1 * child.area) continue;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestParent = candidate;
      }
    }

    if (bestParent) {
      const factor = child.index > bestParent.index ? 0.97 : 1.03;
      const nextZ = round2(clamp(bestParent.body.z * factor, 0.15, 12));
      child.body = { ...child.body, z: nextZ };
      result.items[child.index].body = { ...child.body };
    }
  }

  return finishLayout(result);
}
