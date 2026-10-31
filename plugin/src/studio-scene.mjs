import { projectStudioLayout, studioCameraFrame } from './studio-camera.mjs';

const RELATION_LIMIT = 64;
const invalid = message => { throw Object.assign(new TypeError(message), { code: 'STUDIO_INVALID_INPUT' }); };
const take = (value, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
function canonical(value) {
  if (typeof value === 'number' && !Number.isFinite(value)) invalid('Geometry must be finite.');
  if (Array.isArray(value)) return Array.from(value, canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') invalid('Geometry must contain JSON values.');
  return value;
}

/** Exact canonical geometry snapshot, not a lossy hash. Display names/descriptions/shared never enter it. */
export function studioGeometryKey(doc) {
  if (!doc || !doc.layout) invalid('Expected a Studio document.');
  const layout = doc.layout;
  studioCameraFrame(layout); // Shared geometry validation, without projection singularities or writes.
  return JSON.stringify(canonical({
    kind: doc.kind ?? 'layout',
    layout: {
      ...take(layout, ['width', 'height', 'bbox_coord_space', 'bbox_format', 'camera', 'perspective']),
      items: layout.items.map(item => take(item, ['id', 'label', 'bbox', 'body', 'hidden', 'depth'])),
    },
  }));
}

/** Bounded projected-box summary. These are composition proxies, never semantic shape occlusions. */
export function studioSceneSummary(layout) {
  const projection = projectStudioLayout(layout);
  const warnings = [], relations = [];
  let truncated = false;
  const band = (value, low, middle, high) => value < 1 / 3 ? low : value > 2 / 3 ? high : middle;
  const items = layout.items.filter(item => !item.hidden).map(item => {
    const projected = projection.items[item.id], raw = [...projected.raw], bbox = [...projected.bbox];
    const outside = raw[2] <= 0 || raw[3] <= 0 || raw[0] >= layout.width || raw[1] >= layout.height;
    const behind = projected.anchor === 'world' && projected.depth <= 0;
    if (!projected.visible || projected.partial) warnings.push({
      code: behind ? 'STUDIO_SCENE_BEHIND' : outside ? 'STUDIO_SCENE_OUTSIDE' : projected.partial ? 'STUDIO_SCENE_PARTIAL' : 'STUDIO_SCENE_NOT_VISIBLE',
      item_id: item.id,
    });
    const width = (raw[2] - raw[0]) / layout.width, height = (raw[3] - raw[1]) / layout.height;
    return {
      id: item.id, anchor: projected.anchor, raw, bbox, visible: projected.visible, partial: projected.partial, outside,
      position: { horizontal: band((raw[0] / 2 + raw[2] / 2) / layout.width, 'left', 'center', 'right'),
        vertical: band((raw[1] / 2 + raw[3] / 2) / layout.height, 'top', 'middle', 'bottom') },
      size: { width, height, area: width * height },
      depth: projected.anchor === 'world' ? projected.depth : null,
    };
  });
  const add = relation => { if (relations.length < RELATION_LIMIT) relations.push(relation); else truncated = true; };
  const visible = items.filter(item => item.visible);
  for (let i = 0; i < visible.length; i++) for (let j = i + 1; j < visible.length; j++) {
    const a = visible[i], b = visible[j], box = [Math.max(a.bbox[0], b.bbox[0]), Math.max(a.bbox[1], b.bbox[1]), Math.min(a.bbox[2], b.bbox[2]), Math.min(a.bbox[3], b.bbox[3])];
    if (box[0] < box[2] && box[1] < box[3]) add({ type: 'bbox-overlap', a: a.id, b: b.id, overlap_bbox: box, intersection_area: (box[2] - box[0]) * (box[3] - box[1]) });
    if (a.bbox[2] <= b.bbox[0]) add({ type: 'left-of', a: a.id, b: b.id });
    else if (b.bbox[2] <= a.bbox[0]) add({ type: 'left-of', a: b.id, b: a.id });
    if (a.bbox[3] <= b.bbox[1]) add({ type: 'above', a: a.id, b: b.id });
    else if (b.bbox[3] <= a.bbox[1]) add({ type: 'above', a: b.id, b: a.id });
    if (a.anchor === 'world' && b.anchor === 'world' && a.depth > 0 && b.depth > 0
      && Math.abs(a.depth - b.depth) > 1e-8 * Math.max(1, a.depth, b.depth)) {
      add({ type: 'nearer-than', a: a.depth < b.depth ? a.id : b.id, b: a.depth < b.depth ? b.id : a.id });
    }
  }
  if (truncated) warnings.push({ code: 'STUDIO_SCENE_RELATIONS_TRUNCATED', limit: RELATION_LIMIT });
  return canonical({ items, relations, warnings, approximation: {
    basis: 'projected-bbox-and-blockout-depth', exact_occlusion: false, truncated, relation_limit: RELATION_LIMIT,
    note: 'Projected bbox overlap and proxy depth only; not measured object occlusion or reconstructed 3D.',
  } });
}
