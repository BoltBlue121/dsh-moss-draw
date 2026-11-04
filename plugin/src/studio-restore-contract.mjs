/**
 * Strict, browser-safe wire contract for Studio restore acknowledgements.
 *
 * The Host derives a diff from the page revision it just checked and the historical
 * snapshot; the Client may only echo the exact fields from that diff as an
 * acknowledgement. Sharing the derivation and validation here keeps the Host and
 * the browser from drifting. No I/O, no Node globals, no write permission.
 */

import {studioDocSchemaVersion,studioRemovedRichItems} from './studio-doc-version.mjs';

export const STUDIO_RESTORE_ACK_CODE = 'STUDIO_RESTORE_ACK_REQUIRED';
// The acknowledgement is a UI-side echo of a diff the Host already computed. It is
// not a new human authorization: manual control still needs the private lease.
export const STUDIO_RESTORE_ACK_MESSAGE = '恢复需要确认精确的文档格式或形状差异。';

const DIFF_KEYS = Object.freeze([
  'snapshot_id', 'expected_revision', 'snapshot_schema_version', 'result_schema_version', 'removed_shape_item_ids',
]);
const MAX_DIFF_BYTES = 65536;
const MAX_REMOVED_IDS = 128;
const MAX_ID_LENGTH = 80;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SNAPSHOT_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([1-9][0-9]*)$/i;

function invalid(path, message) {
  const error = new TypeError(`${path}: ${message}`);
  error.code = 'STUDIO_INVALID_INPUT';
  throw error;
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

function utf8Length(value) {
  return new TextEncoder().encode(value).length;
}

function isRevision(value) {
  return Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
}

function schemaVersion(value, path) {
  if (value !== 1 && value !== 2) invalid(path, 'expected schema version 1 or 2');
  return value;
}

function snapshotId(value) {
  if (typeof value !== 'string' || value.length > 54) invalid('diff.snapshot_id', 'expected page_id:revision');
  const match = SNAPSHOT_ID.exec(value);
  if (!match || !isRevision(Number(match[2]))) invalid('diff.snapshot_id', 'expected page_id:revision');
  return value;
}

function removedItemIds(value, field='removed_shape_item_ids') {
  const path='diff.'+field;
  if (!Array.isArray(value) || value.length > MAX_REMOVED_IDS) {
    invalid(path, `expected a dense array of at most ${MAX_REMOVED_IDS} ids`);
  }
  if (Reflect.ownKeys(value).length !== value.length + 1) {
    invalid(path, 'must not contain holes or extra properties');
  }
  const ids = [];
  for (let index = 0; index < value.length; index++) {
    const id = ownData(value, String(index), `${path}[${index}]`);
    if (typeof id !== 'string' || !id.trim() || id.length > MAX_ID_LENGTH) {
      invalid(`${path}[${index}]`, 'expected a nonblank item id of at most 80 characters');
    }
    // Default Array#sort is UTF-16 code-unit order; the wire must stay exact, unique
    // and locale independent, so validate the same comparison it was derived with.
    if (index > 0 && !(ids[index - 1] < id)) {
      invalid(path, 'ids must be strictly ascending by UTF-16 code unit and unique');
    }
    ids.push(id);
  }
  return ids;
}

/** Validate the exact five-field acknowledgement diff the Host may emit. */
export function validateStudioRestoreDiff(value) {
  if (!isRecord(value)) invalid('diff', 'expected a plain object');
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !DIFF_KEYS.includes(key)&&key!=='removed_rich_item_ids') invalid('diff', `unknown field ${String(key)}`);
  }
  for (const key of DIFF_KEYS) {
    if (!Object.hasOwn(value, key)) invalid(`diff.${key}`, 'required field is missing');
  }
  return Object.freeze({
    snapshot_id: snapshotId(ownData(value, 'snapshot_id', 'diff.snapshot_id')),
    expected_revision: (() => {
      const expected = ownData(value, 'expected_revision', 'diff.expected_revision');
      if (!isRevision(expected)) invalid('diff.expected_revision', 'expected a positive safe integer');
      return expected;
    })(),
    snapshot_schema_version: schemaVersion(ownData(value, 'snapshot_schema_version', 'diff.snapshot_schema_version'),
      'diff.snapshot_schema_version'),
    result_schema_version: schemaVersion(ownData(value, 'result_schema_version', 'diff.result_schema_version'),
      'diff.result_schema_version'),
    ...(Object.hasOwn(value,'removed_rich_item_ids')?{removed_rich_item_ids:Object.freeze(removedItemIds(
      ownData(value,'removed_rich_item_ids','diff.removed_rich_item_ids'),'removed_rich_item_ids'))}:{}),
    removed_shape_item_ids: Object.freeze(removedItemIds(ownData(value, 'removed_shape_item_ids',
      'diff.removed_shape_item_ids'))),
  });
}

/**
 * Derive the acknowledgement diff. Removals are same-id shape losses between the
 * current document and the final content; deleting the whole item is not one.
 */
export function deriveStudioRestoreDiff({page_id, expected_revision, revision, current_doc, snapshot_doc, result_doc}) {
  if (typeof page_id !== 'string' || !UUID.test(page_id)) invalid('restore.page_id', 'expected a page UUID');
  if (!isRevision(expected_revision)) invalid('restore.expected_revision', 'expected a positive safe integer');
  if (!isRevision(revision)) invalid('restore.revision', 'expected a positive safe integer');
  const shapes = doc => new Map((doc.layout?.items ?? []).map(item => [item.id, Object.hasOwn(item, 'shape')]));
  const current = shapes(current_doc), result = shapes(result_doc);
  const removed = [];
  for (const [id, shaped] of current) {
    if (shaped && result.has(id) && !result.get(id)) removed.push(id);
  }
  removed.sort();
  const richLosses=studioRemovedRichItems(current_doc,result_doc,true);
  return validateStudioRestoreDiff({
    snapshot_id: `${page_id}:${revision}`,
    expected_revision,
    snapshot_schema_version: studioDocSchemaVersion(snapshot_doc),
    result_schema_version: studioDocSchemaVersion(result_doc),
    removed_shape_item_ids: removed,
    ...(richLosses.length?{removed_rich_item_ids:richLosses}:{}),
  });
}

/** Any version mismatch between current/history/final or a same-id shape loss needs an ack. */
export function studioRestoreNeedsAck(diff, currentSchemaVersion) {
  return diff.snapshot_schema_version !== currentSchemaVersion
    || diff.result_schema_version !== currentSchemaVersion
    || diff.snapshot_schema_version !== diff.result_schema_version
    || diff.removed_shape_item_ids.length > 0 || !!diff.removed_rich_item_ids?.length;
}

/** Exact semantic equality, independent of object insertion order. */
export function sameStudioRestoreDiff(left, right) {
  if (!isRecord(left) || Reflect.ownKeys(left).length !== Reflect.ownKeys(right).length) return false;
  for (const key of DIFF_KEYS) if (!Object.hasOwn(left, key)) return false;
  if(Object.hasOwn(left,'removed_rich_item_ids')!==Object.hasOwn(right,'removed_rich_item_ids'))return false;
  if(right.removed_rich_item_ids){
    const ids=left.removed_rich_item_ids;
    if(!Array.isArray(ids)||ids.length!==right.removed_rich_item_ids.length||right.removed_rich_item_ids.some((id,i)=>id!==ids[i]))return false;
  }
  if (left.snapshot_id !== right.snapshot_id || left.expected_revision !== right.expected_revision
    || left.snapshot_schema_version !== right.snapshot_schema_version
    || left.result_schema_version !== right.result_schema_version) return false;
  const ids = left.removed_shape_item_ids;
  if (!Array.isArray(ids) || ids.length !== right.removed_shape_item_ids.length) return false;
  for (let index = 0; index < ids.length; index++) {
    if (ids[index] !== right.removed_shape_item_ids[index]) return false;
  }
  return true;
}

/** Host-side whitelist: the only body ever emitted for a restore acknowledgement. */
export function encodeStudioRestoreAckError(diff) {
  let clean;
  try { clean = validateStudioRestoreDiff(diff); } catch { return null; }
  const text = JSON.stringify({code: STUDIO_RESTORE_ACK_CODE, message: STUDIO_RESTORE_ACK_MESSAGE, diff: clean});
  return utf8Length(text) <= MAX_DIFF_BYTES ? text : null;
}

/** Client-side strict parse: anything outside this shape is an ordinary error. */
export function parseStudioRestoreAckError(text) {
  if (typeof text !== 'string' || utf8Length(text) > MAX_DIFF_BYTES) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!isRecord(value)) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !Object.hasOwn(value, 'code') || !Object.hasOwn(value, 'message')
    || !Object.hasOwn(value, 'diff')) return null;
  if (value.code !== STUDIO_RESTORE_ACK_CODE || value.message !== STUDIO_RESTORE_ACK_MESSAGE) return null;
  let diff;
  try { diff = validateStudioRestoreDiff(value.diff); } catch { return null; }
  return {code: STUDIO_RESTORE_ACK_CODE, message: STUDIO_RESTORE_ACK_MESSAGE, diff};
}
