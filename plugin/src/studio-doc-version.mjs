/**
 * Pure v2 Studio Doc data protocol: schema version, grid shape assertions, direction
 * guards and lossy downgrade candidates.
 *
 * Browser-safe ESM with no I/O and no Node globals. This module deliberately imports
 * only pure geometry: the domain owns full Doc structure parsing and calls these
 * guards on an already-parsed candidate, so importing the domain here would cycle.
 * None of this layer grants write permission; the Host policy layer is not involved.
 */

import { assertStudioRingSimple, parseStudioGridRing } from './studio-geometry.mjs';

// Document-wide v2 ring point budget (and, implicitly, the per-ring cap of 128).
const SHAPE_POINT_BUDGET = 4096;
const COORDINATE_LIMIT = 16384;

// Whole-layer deletion is an explicit edit. Restore additionally lists deleted
// rich layers because it replaces the whole page with a historical snapshot.
export function studioRemovedRichItems(before,after,includeDeleted=false){
  const next=new Map(after.layout.items.map(item=>[item.id,item]));
  return before.layout.items.filter(item=>{
    const target=next.get(item.id);
    return (target||includeDeleted)&&['role','rig','attachment','bubble','sketch'].some(key=>
      Object.hasOwn(item,key)&&!Object.hasOwn(target??{},key));
  }).map(item=>item.id).sort();
}
export function assertStudioRichRemovals(before,after,declared=[]){
  const losses=studioRemovedRichItems(before,after);
  if(!Array.isArray(declared)||declared.length!==losses.length||losses.some((id,i)=>id!==declared[i])){
    fail('STUDIO_RICH_REMOVED','after.layout.items','a rich field was stripped without an exact removal receipt');
  }
}

function fail(code, path, message) {
  const error = new TypeError(`${path}: ${message}`);
  error.code = code;
  throw error;
}

function invalid(path, message) {
  fail('STUDIO_INVALID_INPUT', path, message);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function ownData(value, key, path) {
  const entry = Object.getOwnPropertyDescriptor(value, key);
  if (!entry || !entry.enumerable || !Object.hasOwn(entry, 'value')) {
    invalid(path, 'expected an enumerable own data property');
  }
  return entry.value;
}

function optionalOwnData(value, key, path) {
  const entry = Object.getOwnPropertyDescriptor(value, key);
  if (!entry) return { present: false };
  if (!entry.enumerable || !Object.hasOwn(entry, 'value')) {
    invalid(path, 'expected an enumerable own data property');
  }
  return { present: true, value: entry.value };
}

function denseLength(value, path) {
  if (!Array.isArray(value)) invalid(path, 'expected a dense data array');
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value)
    || length.value < 0) {
    invalid(path, 'expected a dense data array');
  }
  if (Reflect.ownKeys(value).length !== length.value + 1) {
    invalid(path, 'must not contain holes or extra properties');
  }
  return length.value;
}

function entryAt(value, index, path) {
  const entry = Object.getOwnPropertyDescriptor(value, String(index));
  if (!entry || !entry.enumerable || !Object.hasOwn(entry, 'value')) {
    invalid(path, 'must be an own enumerable data entry');
  }
  return entry.value;
}

/**
 * Missing schema_version is the frozen v1 format; only an explicit own data `2`
 * is v2. An accessor is rejected without ever executing the caller's getter.
 */
export function studioDocSchemaVersion(doc) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    invalid('doc', 'expected a Studio document object');
  }
  const entry = Object.getOwnPropertyDescriptor(doc, 'schema_version');
  if (!entry) return 1;
  if (!entry.enumerable || !Object.hasOwn(entry, 'value')) {
    invalid('doc.schema_version', 'expected an enumerable own data property');
  }
  if (entry.value === 2) return 2;
  invalid('doc.schema_version', 'expected 2 when present; omit the field for schema version 1');
}

function readShapeRing(value, path) {
  if (!isRecord(value)) invalid(path, 'expected a plain object');
  for (const key of Reflect.ownKeys(value)) {
    if (key !== 'kind' && key !== 'ring') invalid(path, `unknown field ${String(key)}`);
  }
  const kind = ownData(value, 'kind', `${path}.kind`);
  if (kind !== 'polygon') invalid(`${path}.kind`, 'expected polygon');
  return ownData(value, 'ring', `${path}.ring`);
}

function readBbox(value, path) {
  if (!Array.isArray(value)) invalid(path, 'expected a dense bbox array of four coordinates');
  if (denseLength(value, path) !== 4) invalid(path, 'expected four xyxy coordinates');
  const result = [];
  for (let index = 0; index < 4; index++) {
    const coordinate = ownData(value, String(index), `${path}[${index}]`);
    if (typeof coordinate !== 'number' || !Number.isFinite(coordinate)
      || Math.abs(coordinate) > COORDINATE_LIMIT) {
      invalid(`${path}[${index}]`, 'must be a finite coordinate in [-16384, 16384]');
    }
    result.push(coordinate);
  }
  if (result[2] <= result[0] || result[3] <= result[1]) {
    invalid(path, 'expected four xyxy coordinates with positive width and height');
  }
  return result;
}

function derivedBounds(points) {
  let [left, top] = points[0], right = left, bottom = top;
  for (const [x, y] of points) {
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return [left, top, right, bottom];
}

function documentItems(doc, path) {
  const layout = ownData(doc, 'layout', `${path}.layout`);
  if (!isRecord(layout)) invalid(`${path}.layout`, 'expected a plain object');
  const items = ownData(layout, 'items', `${path}.items`);
  return { layout, items, count: denseLength(items, `${path}.items`) };
}

/**
 * Assert the v2 shape rules over a candidate the domain has structurally parsed.
 *
 * Ordering matters: every structure, coordinate, per-ring count, bbox and document
 * total is checked linearly first, and only then does each ring pay the O(n^2)
 * simplicity test. The derived bbox is compared against the ring's own exact
 * lattice bounds; the legacy EPS-based ring validator is never reused here, so a
 * legal micro-triangle below STUDIO_AREA_EPSILON remains a valid v2 shape.
 */
export function assertStudioDocShapes(parsedCandidate) {
  const version = studioDocSchemaVersion(parsedCandidate);
  const { items, count } = documentItems(parsedCandidate, 'doc');
  const rings = [];
  let total = 0;
  for (let index = 0; index < count; index++) {
    const path = `doc.layout.items[${index}]`;
    const item = entryAt(items, index, path);
    if (!isRecord(item)) invalid(path, 'expected a plain object');
    const shape = optionalOwnData(item, 'shape', `${path}.shape`);
    if (!shape.present) continue;
    if (version === 1) invalid(`${path}.shape`, 'shape requires schema version 2');
    const ringPath = `${path}.shape.ring`;
    const points = parseStudioGridRing(readShapeRing(shape.value, `${path}.shape`), ringPath);
    total += points.length;
    if (total > SHAPE_POINT_BUDGET) {
      invalid('doc.layout.items', `total ring points exceed the ${SHAPE_POINT_BUDGET}-point document budget`);
    }
    const bbox = readBbox(ownData(item, 'bbox', `${path}.bbox`), `${path}.bbox`);
    const derived = derivedBounds(points);
    for (let axis = 0; axis < 4; axis++) {
      if (bbox[axis] !== derived[axis]) {
        invalid(`${path}.bbox`, `must equal the ring-derived bounds [${derived.join(', ')}]`);
      }
    }
    rings.push({ path: ringPath, points });
  }
  for (const ring of rings) assertStudioRingSimple(ring.points, ring.path);
  return parsedCandidate;
}

function readTransitionOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    invalid('options', 'must be a plain data object');
  }
  let allowUpgrade = true;
  let shapeRemovals = [];
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'allow_upgrade' && key !== 'shape_removals') invalid('options', `unknown option ${String(key)}`);
    const value = ownData(options, key, `options.${key}`);
    if (key === 'allow_upgrade') {
      if (typeof value !== 'boolean') invalid('options.allow_upgrade', 'must be boolean');
      allowUpgrade = value;
      continue;
    }
    const length = denseLength(value, 'options.shape_removals');
    const removals = [];
    for (let index = 0; index < length; index++) {
      const id = entryAt(value, index, `options.shape_removals[${index}]`);
      if (typeof id !== 'string' || !id.length) {
        invalid(`options.shape_removals[${index}]`, 'must be a nonempty item id string');
      }
      removals.push(id);
    }
    shapeRemovals = removals;
  }
  return { allowUpgrade, shapeRemovals };
}

function shapeIndex(doc, label) {
  const { items, count } = documentItems(doc, label);
  const index = new Map();
  for (let position = 0; position < count; position++) {
    const path = `${label}.layout.items[${position}]`;
    const item = entryAt(items, position, path);
    if (!isRecord(item)) invalid(path, 'expected a plain object');
    const id = ownData(item, 'id', `${path}.id`);
    if (typeof id !== 'string' || !id.length) invalid(`${path}.id`, 'expected a nonempty string');
    if (index.has(id)) invalid(`${label}.layout.items`, `duplicate item id ${id}`);
    index.set(id, optionalOwnData(item, 'shape', `${path}.shape`).present);
  }
  return index;
}

/**
 * Pure data guard for a Doc transition. This does not consult or grant Host
 * permissions; allow_upgrade belongs to the trusted caller, never to the Doc.
 * Whole-item deletion is a normal document change, not a shape field removal.
 */
export function assertStudioShapeTransition(before, after, options = {}) {
  const { allowUpgrade, shapeRemovals } = readTransitionOptions(options);
  const beforeVersion = studioDocSchemaVersion(before);
  const afterVersion = studioDocSchemaVersion(after);
  if (afterVersion < beforeVersion) {
    fail('STUDIO_SCHEMA_DOWNGRADE', 'after',
      'a schema version downgrade requires the explicit lossy downgrade path');
  }
  if (afterVersion > beforeVersion && !allowUpgrade) {
    fail('STUDIO_SCHEMA_UPGRADE_FORBIDDEN', 'after',
      'schema version upgrades are not allowed for this caller');
  }
  const beforeItems = shapeIndex(before, 'before');
  const afterItems = shapeIndex(after, 'after');
  const removals = new Set();
  for (const id of shapeRemovals) {
    if (removals.has(id)) invalid('options.shape_removals', `duplicate removal id ${id}`);
    removals.add(id);
    if (!beforeItems.has(id)) invalid('options.shape_removals', `unknown removal id ${id}`);
    if (!beforeItems.get(id)) invalid('options.shape_removals', `item ${id} has no shape to remove`);
    if (!afterItems.has(id)) invalid('options.shape_removals', `item ${id} was deleted entirely, not stripped of a shape`);
    if (afterItems.get(id)) invalid('options.shape_removals', `item ${id} still has a shape`);
  }
  for (const [id, hadShape] of beforeItems) {
    if (!hadShape || !afterItems.has(id) || afterItems.get(id) || removals.has(id)) continue;
    fail('STUDIO_SHAPE_REMOVED', 'after.layout.items',
      `item ${id} loses its shape without an explicit shape removal`);
  }
  return true;
}

function readDowngradeOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    invalid('options', 'must be a plain data object');
  }
  const flags = {drop_shapes:false,drop_rich:false};
  for (const key of Reflect.ownKeys(options)) {
    if (!Object.hasOwn(flags,key)) invalid('options', `unknown option ${String(key)}`);
    const value = ownData(options, key, `options.${key}`);
    if (typeof value !== 'boolean') invalid(`options.${key}`, 'must be boolean');
    flags[key] = value;
  }
  return flags;
}

function cloneData(value) {
  if (Array.isArray(value)) return value.map(cloneData);
  if (isRecord(value)) {
    const output = {};
    for (const key of Reflect.ownKeys(value)) output[key] = cloneData(ownData(value, key, 'doc'));
    return output;
  }
  return value;
}

/**
 * Candidate-only downgrade. Returns a detached v1 document and the ids whose shape
 * field was dropped, in document order. Shapes are never removed silently: a v2
 * document with shapes requires the explicit drop_shapes flag (STUDIO_SCHEMA_LOSSY).
 * The result is a candidate for a new copy or download; it is not written anywhere.
 */
export function downgradeStudioDocCandidate(validDoc, options = {}) {
  const flags = readDowngradeOptions(options);
  const version = studioDocSchemaVersion(validDoc);
  const { items, count } = documentItems(validDoc, 'doc');
  const shapeFlags = [];
  const removed = [];
  for (let position = 0; position < count; position++) {
    const path = `doc.layout.items[${position}]`;
    const item = entryAt(items, position, path);
    if (!isRecord(item)) invalid(path, 'expected a plain object');
    const shaped = optionalOwnData(item, 'shape', `${path}.shape`).present;
    shapeFlags.push(shaped);
    if (!shaped) continue;
    const id = ownData(item, 'id', `${path}.id`);
    if (typeof id !== 'string' || !id.length) invalid(`${path}.id`, 'expected a nonempty string');
    removed.push(id);
  }
  if (version === 1) {
    if (removed.length) invalid('doc.layout.items', 'shape requires schema version 2');
    return { doc: cloneData(validDoc), removed_shape_item_ids: [] };
  }
  if (removed.length && !flags.drop_shapes) {
    fail('STUDIO_SCHEMA_LOSSY', 'doc',
      'removing schema version 2 drops item shapes; pass drop_shapes: true to accept the loss');
  }
  const doc = cloneData(validDoc);
  const richKeys=['rig','attachment','bubble','sketch'];
  const richIds=doc.layout.items.filter(item=>richKeys.some(key=>Object.hasOwn(item,key))).map(item=>item.id);
  if(richIds.length&&!flags.drop_rich)fail('STUDIO_SCHEMA_LOSSY','doc','pass drop_rich: true to discard poses, attachments, balloons or sketches in this copy');
  delete doc.schema_version;
  for (let position = 0; position < count; position++) {
    if (shapeFlags[position]) {
      delete doc.layout.items[position].shape;
      delete doc.layout.items[position].role;
    }
    for(const key of richKeys)delete doc.layout.items[position][key];
  }
  return { doc, removed_shape_item_ids: removed, ...(richIds.length?{removed_rich_item_ids:richIds}:{}) };
}
