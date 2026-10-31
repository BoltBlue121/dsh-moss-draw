/**
 * Pure series-profile snapshots and deterministic, active-mode-only text resolution.
 * No live profile lookup, hash, model/LoRA changes, I/O or domain imports.
 * The domain owns full Doc validation before calling resolveStudioSharedDoc.
 */

const MAX_BYTES = 512 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function invalid(path, message) {
  const error = new TypeError(`${path}: ${message}`);
  error.code = 'STUDIO_INVALID_INPUT';
  throw error;
}

function ownValue(value, key, path) {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) {
    invalid(path, 'expected an enumerable own data property');
  }
  return property.value;
}

function plain(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(path, 'expected a plain object');
  }
}

function record(value, fields, path) {
  plain(value, path);
  const output = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !Object.hasOwn(fields, key)) invalid(path, `unknown field ${String(key)}`);
    output[key] = fields[key](ownValue(value, key, `${path}.${key}`), `${path}.${key}`);
  }
  for (const key of Object.keys(fields)) {
    if (!Object.hasOwn(output, key)) invalid(`${path}.${key}`, 'required field is missing');
  }
  return output;
}

function text(maximum, nonblank = false) {
  return (value, path) => {
    if (typeof value !== 'string' || value.length > maximum || (nonblank && !value.trim())) {
      invalid(path, `expected ${nonblank ? 'nonblank ' : ''}string of at most ${maximum} characters`);
    }
    return value;
  };
}

function array(check, maximum) {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > maximum) invalid(path, `expected array of at most ${maximum} entries`);
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        invalid(path, `unknown array field ${String(key)}`);
      }
    }
    const output = [];
    for (let i = 0; i < value.length; i++) {
      output.push(check(ownValue(value, String(i), `${path}[${i}]`), `${path}[${i}]`));
    }
    return output;
  };
}

function byteBudget(value, path) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_BYTES) {
    invalid(path, 'UTF-8 JSON exceeds 512 KiB');
  }
}

function unique(values, path) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) invalid(path, `duplicate id ${value}`);
    seen.add(value);
  }
  return seen;
}

const id = text(80, true);
const caption = text(12000);
const profileFields = {
  series_id(value, path) {
    if (typeof value !== 'string' || !UUID.test(value)) invalid(path, 'expected a UUID');
    return value;
  },
  revision(value, path) {
    if (!Number.isSafeInteger(value) || value < 1) invalid(path, 'expected a positive safe integer');
    return value;
  },
  style: caption,
  cast: array((value, path) => record(value, {
    character_id: id, name: text(200), description: caption,
  }, path), 32),
};
const snapshotFields = {
  ...profileFields,
  bindings: array((value, path) => record(value, { item_id: id, character_id: id }, path), 128),
  caption_cast_ids: array(id, 32),
};

/** Omitted optional snapshot stays omitted; explicit null/invalid data is rejected. */
export function validateStudioShared(value) {
  if (value === undefined) return undefined;
  const output = record(value, snapshotFields, 'shared');
  const castIds = unique(output.cast.map((card) => card.character_id), 'shared.cast');
  unique(output.bindings.map((binding) => binding.item_id), 'shared.bindings');
  unique(output.caption_cast_ids, 'shared.caption_cast_ids');
  for (const binding of output.bindings) {
    if (!castIds.has(binding.character_id)) invalid('shared.bindings', `unknown character_id ${binding.character_id}`);
  }
  for (const characterId of output.caption_cast_ids) {
    if (!castIds.has(characterId)) invalid('shared.caption_cast_ids', `unknown character_id ${characterId}`);
  }
  byteBudget(output, 'shared');
  return output;
}

/** Create a self-contained versioned snapshot. Source edits cannot mutate its content. */
export function sharedSnapshot(profile, bindings = [], captionCastIds = []) {
  const source = record(profile, profileFields, 'profile');
  return validateStudioShared({ ...source, bindings, caption_cast_ids: captionCastIds });
}

function joinText(parts, path) {
  // Empty strings contribute nothing; whitespace and all other original characters are retained.
  return caption(parts.filter((part) => part !== '').join('\n\n'), path);
}

/**
 * Resolve an already domain-validated Doc into an independent, ordinary Doc.
 * Only the active kind is expanded; the inactive branch remains unchanged.
 * Layout: style -> summary; bound card description -> local item action.
 * Caption: style -> explicitly selected cards (selection order) -> local text.
 * Shared metadata is removed so resolving the result again cannot duplicate text.
 * Regions consumers use original doc.shared.style + resolved item.caption once,
 * not resolved summary or every cast member. Hidden metadata is never changed.
 */
export function resolveStudioSharedDoc(doc) {
  plain(doc, 'doc');
  if (!Object.hasOwn(doc, 'shared')) return structuredClone(doc);
  const shared = validateStudioShared(ownValue(doc, 'shared', 'doc.shared'));
  if (shared === undefined) invalid('doc.shared', 'omit the optional field instead of supplying undefined');
  const output = structuredClone(doc);
  delete output.shared;
  if (!Array.isArray(output.layout?.items)) invalid('doc.layout.items', 'expected domain-validated items');
  const items = new Map(output.layout.items.map((item) => [item.id, item]));
  for (const binding of shared.bindings) {
    const item = items.get(binding.item_id);
    if (!item) invalid('shared.bindings', `item_id ${binding.item_id} does not exist`);
    if (item.label !== 'character') invalid('shared.bindings', `item_id ${binding.item_id} must have label character`);
  }
  const cards = new Map(shared.cast.map((card) => [card.character_id, card]));
  if (output.kind === 'layout') {
    output.layout.summary.caption = joinText([shared.style, output.layout.summary.caption], 'resolved.layout.summary.caption');
    for (const binding of shared.bindings) {
      const item = items.get(binding.item_id);
      item.caption = joinText([cards.get(binding.character_id).description, item.caption], `resolved.item.${item.id}.caption`);
    }
  } else if (output.kind === 'caption') {
    output.caption.caption = joinText([
      shared.style, ...shared.caption_cast_ids.map((characterId) => cards.get(characterId).description), output.caption.caption,
    ], 'resolved.caption.caption');
  } else invalid('doc.kind', 'expected layout or caption');
  byteBudget(output, 'resolved doc');
  return output;
}
