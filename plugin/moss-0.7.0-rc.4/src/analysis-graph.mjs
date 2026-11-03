/** Host-only, pure resolved-GBC validation and Studio proposal conversion. No I/O. */
import { createHash } from 'node:crypto';
import { types } from 'node:util';
import { validateStudioDoc } from './studio-domain.mjs';
import { resolveStudioSharedDoc } from './studio-shared.mjs';

const MAX_BYTES = 1024 * 1024;
const LABELS = ['image', 'entity', 'composition', 'relation'];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function fail(reason, message) {
  const error = new TypeError(`${reason}: ${message}`);
  error.code = 'STUDIO_ANALYSIS_GRAPH';
  error.reason = reason;
  throw error;
}
const requireThat = (ok, reason, message) => { if (!ok) fail(reason, message); };

/** Inspect descriptors before reading values; never call user getters/toJSON/proxy traps. */
function detachedJson(raw) {
  const ancestors = new Set();
  let bytes = 0, nodes = 0;
  const charge = n => { bytes += n; requireThat(bytes <= MAX_BYTES, 'SIZE', 'Graph exceeds 1 MiB encoded JSON.'); };
  function copy(value, depth) {
    requireThat(depth <= 32 && ++nodes <= 131072, 'JSON_BOUND', 'JSON depth/node limit exceeded.');
    if (value === null) { charge(4); return null; }
    if (typeof value === 'string') {
      requireThat(value.length <= MAX_BYTES, 'SIZE', 'String exceeds graph budget.');
      charge(Buffer.byteLength(JSON.stringify(value))); return value;
    }
    if (typeof value === 'boolean') { charge(value ? 4 : 5); return value; }
    if (typeof value === 'number') {
      requireThat(Number.isFinite(value), 'JSON', 'Nonfinite number.'); charge(String(value).length); return value;
    }
    requireThat(value && typeof value === 'object' && !types.isProxy(value), 'JSON', 'Expected inert plain JSON.');
    const array = Array.isArray(value), proto = Object.getPrototypeOf(value);
    requireThat(array ? proto === Array.prototype : proto === Object.prototype || proto === null, 'JSON', 'Expected plain object/array.');
    requireThat(!ancestors.has(value), 'JSON', 'Cyclic JSON.');
    ancestors.add(value);
    const keys = Reflect.ownKeys(value);
    let result;
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length').value;
      requireThat(length <= 131072 && keys.length === length + 1, 'JSON', 'Sparse or oversized array.');
      result = [];
      charge(2 + Math.max(0, length - 1));
      for (let i = 0; i < length; i++) {
        const p = Object.getOwnPropertyDescriptor(value, String(i));
        requireThat(p && p.enumerable && Object.hasOwn(p, 'value'), 'JSON', 'Expected dense own data entries.');
        result.push(copy(p.value, depth + 1));
      }
    } else {
      result = {}; charge(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        requireThat(typeof key === 'string', 'JSON', 'Symbol property is not JSON.');
        const p = Object.getOwnPropertyDescriptor(value, key);
        requireThat(p.enumerable && Object.hasOwn(p, 'value'), 'JSON', 'Expected enumerable own data properties.');
        charge(Buffer.byteLength(JSON.stringify(key)) + 1);
        Object.defineProperty(result, key, { value: copy(p.value, depth + 1), enumerable: true, writable: true, configurable: true });
      }
    }
    ancestors.delete(value);
    return result;
  }
  return copy(raw, 0);
}
function record(value, allowed, required = allowed) {
  requireThat(value !== null && typeof value === 'object' && !Array.isArray(value), 'SCHEMA', 'Expected record.');
  requireThat(Object.keys(value).every(k => allowed.includes(k)) && required.every(k => Object.hasOwn(value, k)), 'SCHEMA', 'Unknown or missing field.');
}
function text(value, max = 12000, nonblank = false) {
  requireThat(typeof value === 'string' && value.length <= max && (!nonblank || value.trim()), 'TEXT', 'Invalid bounded text.');
}
function list(value, max) { requireThat(Array.isArray(value) && value.length <= max, 'SCHEMA', 'Invalid bounded array.'); }
function unit(value) { requireThat(typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1, 'BBOX', 'Expected normalized finite value.'); }
const edgeKey = e => JSON.stringify([e.source, e.text, e.target]);

/** Return a checked, fully detached graph, including bounded inert evidence metadata. */
export function validateGbcGraph(raw) {
  const graph = detachedJson(raw);
  record(graph, ['vertices', 'img_path', 'img_url', 'img_size', 'original_caption', 'short_caption', 'detail_caption', 'mask_inside_threshold'], ['vertices']);
  for (const k of ['original_caption', 'short_caption', 'detail_caption']) if (Object.hasOwn(graph, k) && graph[k] !== null) text(graph[k]);
  if (Object.hasOwn(graph, 'img_size') && graph.img_size !== null) {
    requireThat(Array.isArray(graph.img_size) && graph.img_size.length === 2 && graph.img_size.every(n => Number.isSafeInteger(n) && n > 0),
      'SOURCE_DIMENSIONS', 'Graph image size must be null or [width, height] positive safe integers.');
  }
  list(graph.vertices, 128);
  const byId = new Map();
  for (const v of graph.vertices) {
    record(v, ['vertex_id', 'label', 'bbox', 'descs', 'in_edges', 'out_edges', 'sub_masks', 'super_masks', 'tags'],
      ['vertex_id', 'label', 'bbox', 'descs', 'in_edges', 'out_edges', 'sub_masks', 'super_masks']);
    text(v.vertex_id, 12000);
    requireThat(LABELS.includes(v.label) && (v.label === 'image' || v.vertex_id.trim()), 'VERTEX', 'Invalid label or non-root ID.');
    requireThat(!byId.has(v.vertex_id), 'DUPLICATE_ID', 'Duplicate vertex ID.'); byId.set(v.vertex_id, v);
    record(v.bbox, ['left', 'top', 'right', 'bottom', 'confidence']);
    for (const key of ['left', 'top', 'right', 'bottom']) unit(v.bbox[key]);
    if (v.bbox.confidence !== null) unit(v.bbox.confidence);
    requireThat(v.bbox.right > v.bbox.left && v.bbox.bottom > v.bbox.top, 'BBOX', 'Degenerate box.');
    list(v.descs, 128);
    for (const d of v.descs) {
      record(d, ['text', 'label', 'full_label', 'statistics', 'clip_scores', 'toxicity_scores'], ['text', 'label']);
      text(d.text); text(d.label, 200); if (Object.hasOwn(d, 'full_label')) text(d.full_label, 12000);
    }
    for (const key of ['in_edges', 'out_edges', 'sub_masks', 'super_masks']) list(v[key], 512);
    if (Object.hasOwn(v, 'tags')) {
      requireThat(v.tags && typeof v.tags === 'object' && !Array.isArray(v.tags), 'SCHEMA', 'Expected tag scores.');
      for (const [tag, score] of Object.entries(v.tags)) { text(tag, 12000); requireThat(typeof score === 'number', 'SCHEMA', 'Expected numeric tag score.'); }
    }
  }
  const roots = graph.vertices.filter(v => v.label === 'image');
  requireThat(roots.length === 1, 'ROOT', 'Exactly one image root required.');
  const out = new Set(), incoming = new Set(); let count = 0;
  for (const v of graph.vertices) {
    for (const key of ['sub_masks', 'super_masks']) {
      const seen = new Set();
      for (const id of v[key]) {
        text(id); requireThat(byId.has(id) && !seen.has(id), 'MASK_REF', 'Invalid mask ID reference.'); seen.add(id);
      }
    }
    for (const direction of ['out_edges', 'in_edges']) for (const e of v[direction]) {
      record(e, ['source', 'text', 'target']); text(e.source); text(e.target); text(e.text);
      requireThat(byId.has(e.source) && byId.has(e.target) && e.source !== e.target, 'EDGE_REF', 'Invalid edge endpoint.');
      requireThat((direction === 'out_edges' ? e.source : e.target) === v.vertex_id, 'EDGE_OWNER', 'Edge does not match its owning vertex.');
      const seen = direction === 'out_edges' ? out : incoming, key = edgeKey(e);
      requireThat(!seen.has(key), 'DUPLICATE_EDGE', 'Duplicate directed phrase edge.'); seen.add(key);
      if (direction === 'out_edges') requireThat(++count <= 512, 'EDGE_LIMIT', 'More than 512 out-edges.');
    }
  }
  requireThat(out.size === incoming.size && [...out].every(k => incoming.has(k)), 'EDGE_MIRROR', 'in_edges must exactly mirror out_edges.');
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    requireThat(!visiting.has(id), 'CYCLE', 'Directed graph cycle.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const e of byId.get(id).out_edges) visit(e.target);
    visiting.delete(id); visited.add(id);
  }
  // Check cycles even in disconnected components before checking reachability.
  for (const id of byId.keys()) visit(id);
  const reached = new Set();
  function reach(id) { if (reached.has(id)) return; reached.add(id); for (const e of byId.get(id).out_edges) reach(e.target); }
  reach(roots[0].vertex_id);
  requireThat(reached.size === byId.size, 'UNREACHABLE', 'Every vertex must be reachable from the image root.');
  return graph;
}

function description(v) {
  for (const label of ['detail', 'short', 'original', 'hardcode']) {
    const found = v.descs.find(d => d.label === label && d.text.trim()); if (found) return found.text;
  }
  return v.descs.find(d => d.text.trim())?.text ?? '';
}
function rootCaption(graph) {
  const root = graph.vertices.find(v => v.label === 'image');
  for (const label of ['detail', 'short', 'original']) {
    const desc = root.descs.find(d => d.label === label && d.text.trim());
    const caption = graph[`${label}_caption`];
    if (typeof caption === 'string' && caption.trim()) return caption;
    if (desc) return desc.text;
  }
  return description(root);
}
function relationTexts(graph) {
  return [...new Set(graph.vertices.filter(v => v.label === 'relation').flatMap(v => v.descs.map(d => d.text).filter(t => t.trim())))].sort(compare);
}
function checkedSummary(graph, detail) {
  const counts = { vertices: graph.vertices.length, edges: 0, image: 0, entity: 0, composition: 0, relation: 0 };
  for (const v of graph.vertices) { counts[v.label]++; counts.edges += v.out_edges.length; }
  const warnings = [], bounded = value => {
    if (value.length <= 1200) return value;
    if (!warnings.length) warnings.push({ code: 'STUDIO_ANALYSIS_SUMMARY_OMITTED', message: 'Long inspection descriptions omitted; graph evidence is unchanged.' });
    return '';
  };
  const result = { counts, caption: bounded(rootCaption(graph)), nodes: [], relations: [], warnings };
  if (detail) result.nodes = [...graph.vertices].sort((a, b) => compare(a.vertex_id, b.vertex_id)).map(v => ({ vertex_id: v.vertex_id, label: v.label, caption: bounded(description(v)) }));
  let budget = 12000;
  for (const t of relationTexts(graph)) {
    if (t.length > budget) {
      warnings.push({ code: 'STUDIO_ANALYSIS_RELATIONS_OMITTED', message: 'Inspection relation text budget exceeded; remaining facts stay in graph evidence.' }); break;
    }
    result.relations.push(t); budget -= t.length;
  }
  return result;
}

/** Bounded inspection only; paths and raw boxes never become descriptive prose. */
export function summarizeGbcGraph(graph, options = {}) {
  requireThat(options !== null, 'SCHEMA', 'Summary options must not be null.');
  const { detail = false } = options;
  return checkedSummary(validateGbcGraph(graph), detail);
}

/** Build a detached proposal, never overwrite a saved page or enforce store policy here. */
export function buildGbcProposal(options) {
  requireThat(options != null, 'SCHEMA', 'Proposal options are required.');
  const { graph: raw, baseDoc, source, fit = 'contain', vertexIds } = options;
  const graph = validateGbcGraph(raw), doc = validateStudioDoc(baseDoc);
  const src = detachedJson(source);
  record(src, ['sha256', 'width', 'height']);
  requireThat(typeof src.sha256 === 'string' && /^[a-f0-9]{64}$/.test(src.sha256), 'SOURCE', 'Expected lowercase SHA256.');
  requireThat([src.width, src.height].every(n => Number.isSafeInteger(n) && n > 0), 'SOURCE', 'Expected positive safe integer source dimensions.');
  requireThat(graph.img_size == null || graph.img_size[0] === src.width && graph.img_size[1] === src.height,
    'SOURCE_DIMENSIONS', 'Graph image size conflicts with the authoritative source dimensions.');
  requireThat(['contain', 'cover', 'stretch'].includes(fit), 'FIT', 'Unknown fit mode.');
  const byId = new Map(graph.vertices.map(v => [v.vertex_id, v])), selected = new Set();
  if (vertexIds !== undefined) {
    const ids = detachedJson(vertexIds); list(ids, 128);
    for (const id of ids) {
      text(id); requireThat(byId.get(id)?.label === 'entity' && !selected.has(id), 'SELECTION', 'Expected unique existing entity IDs.'); selected.add(id);
    }
  } else {
    const root = graph.vertices.find(v => v.label === 'image');
    for (const e of root.out_edges) {
      const child = byId.get(e.target);
      if (child.label === 'entity') selected.add(child.vertex_id);
      else if (child.label === 'composition') for (const instance of child.out_edges) {
        if (byId.get(instance.target).label === 'entity') selected.add(instance.target);
      }
    }
  }
  const { width, height } = doc.layout;
  const scale = (fit === 'cover' ? Math.max : Math.min)(width / src.width, height / src.height);
  // Work in normalized extents to avoid unnecessary multiply/divide roundoff.
  const dw = fit === 'stretch' ? width : src.width * scale;
  const dh = fit === 'stretch' ? height : src.height * scale;
  const ox = (width - dw) / 2, oy = (height - dh) / 2;
  const items = [], mapping = [], warnings = [];
  for (const id of [...selected].sort(compare)) {
    const v = byId.get(id), b = v.bbox;
    const box = [b.left * dw + ox, b.top * dh + oy, b.right * dw + ox, b.bottom * dh + oy];
    const clipped = box.map((n, i) => Math.max(0, Math.min(i % 2 ? height : width, n)));
    if (clipped[2] <= clipped[0] || clipped[3] <= clipped[1]) {
      warnings.push({ code: 'STUDIO_ANALYSIS_CROPPED', vertex_id: id, message: 'Entity is fully outside the fitted viewport and was omitted.' }); continue;
    }
    if (box.some((n, i) => n !== clipped[i])) warnings.push({ code: 'STUDIO_ANALYSIS_CLIPPED', vertex_id: id, message: 'Entity box intersected with the fitted viewport.' });
    const item_id = `gbc_${createHash('sha256').update(JSON.stringify([src.sha256, id])).digest('hex')}`;
    const phrases = v.in_edges.map(e => e.text).filter(t => t.trim()).sort(compare);
    const name = (phrases[0] || v.label).slice(0, 200);
    if ((phrases[0] || '').length > 200) warnings.push({ code: 'STUDIO_ANALYSIS_NAME_SHORTENED', vertex_id: id, message: 'Display name shortened; original edge phrase retained in graph evidence.' });
    items.push({ id: item_id, label: 'object', name, caption: description(v), bbox: clipped });
    mapping.push({ vertex_id: id, item_id });
  }
  requireThat(items.length > 0, 'NO_ITEMS', 'At least one usable entity is required.');
  const caption = [...new Set([rootCaption(graph), ...relationTexts(graph)].filter(t => t.trim()))].join('\n');
  requireThat(caption.length <= 12000, 'SUMMARY_BUDGET', 'Root/relation facts exceed Studio summary field budget.');
  doc.kind = 'layout'; doc.layout.items = items; doc.layout.summary = { caption };
  if (doc.layout.camera?.enabled) doc.layout.camera.enabled = false;
  let checked;
  try { checked = validateStudioDoc(doc); }
  catch (error) { fail('DOCUMENT_BUDGET', `Converted proposal is not a valid Studio Doc: ${error.message}`); }
  try { resolveStudioSharedDoc(checked); } catch { throw Object.assign(new TypeError('Pinned shared bindings cannot be mapped to GBC objects; preserve or explicitly rebind the original characters before proposing.'), {code:'STUDIO_SHARED_PROTECTED'}); }
  return { doc: checked, summary: checkedSummary(graph, false), generation: generationPrompt(caption, items, warnings), mapping, warnings };
}

/**
 * The analysed structure as a ready-to-use generation prompt: the scene caption followed by one
 * line per detected subject. Returning it here keeps the structural facts with the proposal
 * instead of asking every caller to rebuild them by hand.
 */
function generationPrompt(caption, items, warnings) {
  const budget = 11000;
  const lines = [], seen = new Set();
  for (const item of items) {
    const text = item.caption.trim();
    if (!text) continue;
    const line = `${item.name}: ${text}`;
    if (seen.has(line)) continue;
    seen.add(line);
    if (lines.reduce((total, value) => total + value.length + 1, caption.length + 1) + line.length > budget) {
      warnings.push({ code: 'STUDIO_ANALYSIS_PROMPT_TRIMMED', message: 'Generation prompt reached its budget; later subject lines were omitted.' });
      break;
    }
    lines.push(line);
  }
  return { prompt: [caption, ...lines].join('\n'), negative: '' };
}

/**
 * Same projection from a bare graph, for callers that read an analysis without building a
 * proposal: the caption plus one line per described subject.
 */
// Composition vertices carry the spatial mapping (who stands where, which garment sits where).
// Without them the entity lines describe clothing with no owner and a generator may swap colours.
function structureTexts(graph) {
  return graph.vertices.filter(vertex => vertex.label === 'composition').map(vertex => description(vertex));
}
export function buildGenerationPrompt(raw) {
  const graph = validateGbcGraph(raw), warnings = [], items = [];
  for (const vertex of graph.vertices) {
    if (vertex.label !== 'entity') continue;
    const phrases = vertex.in_edges.map(edge => edge.text).filter(text => text.trim()).sort(compare);
    items.push({ name: (phrases[0] || vertex.label).slice(0, 200), caption: description(vertex) });
  }
  const caption = [...new Set([rootCaption(graph), ...relationTexts(graph), ...structureTexts(graph)].filter(text => text.trim()))].join('\n');
  return { ...generationPrompt(caption, items, warnings), warnings };
}
