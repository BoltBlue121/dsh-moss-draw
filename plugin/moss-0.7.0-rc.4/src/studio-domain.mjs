/**
 * Independent implementation of the public Studio Doc and MOSS Layout formats.
 * Format provenance: xiang6150592/-moss-prompt-editor, snapshot 701eecd800891716b1cb1da39a50dd9bc80e579a,
 * src/types.ts (document fields only); no reference implementation is incorporated.
 * Browser-safe ESM: only pure Studio camera math, no I/O, Node globals, generation, or regions adapter.
 */

import {projectStudioLayout,studioCameraMoved,studioCameraText} from './studio-camera.mjs';
import {validateStudioShared,resolveStudioSharedDoc} from './studio-shared.mjs';

const MAX_BYTES = 512 * 1024;

function invalid(path, message) {
  const error = new TypeError(`${path}: ${message}`);
  error.code = 'STUDIO_INVALID_INPUT';
  throw error;
}

function string(maximum, nonblank = false) {
  return (value, path) => {
    if (typeof value !== 'string' || value.length > maximum || (nonblank && !value.trim())) {
      invalid(path, `expected ${nonblank ? 'nonblank ' : ''}string of at most ${maximum} characters`);
    }
    return value;
  };
}

function number(minimum, maximum, { integer = false, exclusiveMin = false } = {}) {
  return (value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || (integer && !Number.isInteger(value))
      || (exclusiveMin ? value <= minimum : value < minimum) || value > maximum) {
      invalid(path, `expected ${integer ? 'integer' : 'finite number'} ${exclusiveMin ? '>' : '>='}${minimum} and <=${maximum}`);
    }
    return value;
  };
}

function boolean(value, path) {
  if (typeof value !== 'boolean') invalid(path, 'expected boolean');
  return value;
}

function choice(...values) {
  return (value, path) => {
    if (!values.includes(value)) invalid(path, `expected one of ${values.join(', ')}`);
    return value;
  };
}

/** Only enumerable own data properties survive JSON; never silently lose the rest. */
function ownValue(value, key, path) {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property || !property.enumerable || !Object.hasOwn(property, 'value')) {
    invalid(path, 'expected an enumerable own data property');
  }
  return property.value;
}

function record(value, path, fields, required = Object.keys(fields)) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid(path, 'expected a plain object');
  }
  const result = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !Object.hasOwn(fields, key)) invalid(path, `unknown field ${String(key)}`);
    result[key] = fields[key](ownValue(value, key, `${path}.${key}`), `${path}.${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(result, key)) invalid(`${path}.${key}`, 'required field is missing');
  }
  return result;
}

function list(check, maximum) {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > maximum) invalid(path, `expected array of at most ${maximum} entries`);
    for (const key of Reflect.ownKeys(value)) {
      if (key === 'length') continue;
      if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length) {
        invalid(path, `unknown array field ${String(key)}`);
      }
    }
    const result = [];
    for (let i = 0; i < value.length; i++) result.push(check(ownValue(value, String(i), `${path}[${i}]`), `${path}[${i}]`));
    return result;
  };
}

const captionString = string(12000);
const nameString = string(200);
const idString = string(80, true);
// The document byte budget bounds text arrays without imposing an extra token-count policy.
const textList = list(captionString, MAX_BYTES);
const kind = choice('layout', 'caption');
const bodyFields = {
  z: number(0, 100, { exclusiveMin: true }), thickness: number(0, 10),
  yaw: number(-360, 360), anchor: choice('world', 'screen', 'backdrop'),
};
const cameraFields = {
  enabled: boolean, orbit: number(-180, 180), pitch: number(-85, 85), roll: number(-180, 180),
  distance: number(0.01, 100), fov: number(10, 120),
  pan_x: number(-100, 100), pan_y: number(-100, 100), pan_z: number(-100, 100),
};
const finite = number(-Number.MAX_VALUE, Number.MAX_VALUE);
const perspectiveFields = {
  enabled: boolean, mode: choice(1, 2, 3), horizon_y: finite, vp1_x: finite, vp2_x: finite,
  vp3_x: finite, vp3_y: finite, show_grid: boolean, auto_scale: boolean,
  source: choice('manual', 'boxes', 'image'),
};

function bbox(value, path) {
  const result = list(number(-16384, 16384), 4)(value, path);
  if (result.length !== 4 || result[2] <= result[0] || result[3] <= result[1]) {
    invalid(path, 'expected four xyxy coordinates with positive width and height');
  }
  return result;
}

function item(value, path) {
  return record(value, path, {
    id: idString, label: choice('object', 'character', 'text'), caption: captionString, bbox,
    text: captionString, tags: textList, palette: textList, name: nameString,
    hidden: boolean, locked: boolean, depth: choice('auto', 'fg', 'mg', 'bg'),
    color: number(0, 255, { integer: true }), body: (v, p) => record(v, p, bodyFields),
    group: string(80),
  }, ['id', 'label', 'caption', 'bbox']);
}

function items(value, path) {
  const result = list(item, 128)(value, path);
  const ids = new Set();
  for (const entry of result) {
    if (ids.has(entry.id)) invalid(path, `duplicate item id ${entry.id}`);
    ids.add(entry.id);
  }
  return result;
}

function dimension(value, path) {
  number(16, 4096, { integer: true })(value, path);
  if (value % 16 !== 0) invalid(path, 'expected a multiple of 16');
  return value;
}

function layout(value, path) {
  return record(value, path, {
    width: dimension, height: dimension, bbox_coord_space: choice('abs'), bbox_format: choice('xyxy'),
    summary: (v, p) => record(v, p, {
      caption: captionString, meta: textList, canvas: choice('single', 'multi_panel', 'collage'), palette: textList,
    }, ['caption']),
    items,
    // Partial optional records remain partial. Missing fields are not written back as defaults.
    camera: (v, p) => record(v, p, cameraFields, []),
    perspective: (v, p) => record(v, p, perspectiveFields, []),
    prompt_options: (v, p) => record(v, p, { depth: boolean, perspective: boolean, camera: boolean }, []),
  }, ['width', 'height', 'bbox_coord_space', 'bbox_format', 'summary', 'items']);
}

/** Return a new blank editor document, not a generation request or a reference-bound plan. */
export function emptyStudioDoc(documentKind = 'layout') {
  kind(documentKind, 'kind');
  return {
    kind: documentKind,
    layout: {
      width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
      summary: { caption: '' }, items: [],
    },
    caption: { caption: '' },
  };
}

/** Validate both retained modes; return a detached copy without repairing or filling input. */
export function validateStudioDoc(doc) {
  const result = record(doc, 'doc', {
    kind, layout, caption: (value, path) => record(value, path, { caption: captionString }),
    shared:(value,path)=>{if(value===undefined)invalid(path,'omit an absent shared snapshot');return validateStudioShared(value);},
  },['kind','layout','caption']);
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BYTES) {
    invalid('doc', 'UTF-8 JSON exceeds 512 KiB');
  }
  return result;
}

/** Quantize the exact IEEE-754 input, avoiding rounding introduced by value * 1e9. */
function roundNine(value) {
  const bits = new DataView(new ArrayBuffer(8));
  bits.setFloat64(0, value, false);
  const raw = bits.getBigUint64(0, false);
  const exponent = Number((raw >> 52n) & 2047n);
  const fraction = raw & ((1n << 52n) - 1n);
  const mantissa = exponent === 0 ? fraction : fraction + (1n << 52n);
  const power = exponent === 0 ? -1074 : exponent - 1075;
  const scaled = mantissa * 1000000000n;
  let rounded;
  if (power >= 0) rounded = scaled << BigInt(power);
  else {
    const denominator = 1n << BigInt(-power);
    rounded = scaled / denominator;
    const twiceRemainder = (scaled % denominator) * 2n;
    if (twiceRemainder > denominator || (twiceRemainder === denominator && (rounded & 1n) === 1n)) rounded++;
  }
  // Bbox magnitudes are <=16384, so rounded is exactly representable as a Number.
  const result = Number(rounded) / 1e9;
  return (raw >> 63n) === 1n ? -result : result;
}

function centeredBox(box, width, height) {
  const [left, top, right, bottom] = box.map(roundNine);
  return [Math.floor(top) - height / 2, Math.floor(left) - width / 2,
    Math.ceil(bottom) - height / 2, Math.ceil(right) - width / 2];
}

/** Python str.isspace semantics for compiler parity; inspect without trimming or rewriting. */
function pythonNonemptyText(value) {
  return typeof value === 'string' && /[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(value);
}

/**
 * Compile only the active mode. Structural errors throw STUDIO_INVALID_INPUT;
 * valid editor drafts that are not compilable return checks and an empty prompt.
 * Camera projection and optional composition phrases affect the compiled copy only.
 */
export function compileStudioDoc(doc) {
  const clean = resolveStudioSharedDoc(validateStudioDoc(doc));
  const result = { prompt: '', checks: [], prefix: '', negative: '', kind: clean.kind, compiled: false };
  let omittedChecks = 0;
  const check = (code, message, item_id) => {
    if (result.checks.length < 128) {
      result.checks.push(item_id === undefined ? { code, message } : { code, message, item_id });
    } else omittedChecks++;
  };
  if (clean.kind === 'caption') {
    if (!pythonNonemptyText(clean.caption.caption)) check('STUDIO_CAPTION_REQUIRED', 'Caption text is empty.');
    else { result.prompt = clean.caption.caption; result.compiled = true; }
    return result;
  }

  const checkStrings = (record, keys, location, item_id) => {
    for (const key of keys) {
      if (!Object.hasOwn(record, key)) continue;
      record[key].forEach((value, index) => {
        if (!pythonNonemptyText(value)) check('STUDIO_STRING_ENTRY_REQUIRED', `${location}.${key}[${index}] is empty.`, item_id);
      });
    }
  };
  const { width, height, summary, camera, perspective, prompt_options: options = {} } = clean.layout;
  if (!pythonNonemptyText(summary.caption)) check('STUDIO_SUMMARY_CAPTION_REQUIRED', 'Layout summary caption is empty.');
  checkStrings(summary, ['meta', 'palette'], 'summary');
  let entries = clean.layout.items;
  if (studioCameraMoved(clean.layout)) {
    try {
      const view = projectStudioLayout(clean.layout);
      for (const issue of view.checks ?? []) check(issue.code ?? 'STUDIO_PROJECTION_INVALID', issue.message ?? 'Camera projection is invalid.', issue.item_id);
      const originals = new Map(entries.map(item => [item.id,item]));
      entries = view.order.map(id => {
        const original=originals.get(id), projected=view.items[id];
        return {...original,bbox:projected?.visible?projected.bbox.map(Math.round):original.bbox,hidden:original.hidden||!projected?.visible};
      });
    } catch (error) { check('STUDIO_PROJECTION_INVALID', String(error.message ?? error).slice(0,200)); }
  }
  if (camera?.enabled && options.camera !== false) {
    const phrase=studioCameraText(clean.layout);if(phrase)summary.caption+=` ${phrase}`;
  } else if (perspective?.enabled && options.perspective === true) {
    const mode={1:'one-point',2:'two-point',3:'three-point'}[perspective.mode??1];
    const horizon=perspective.horizon_y===undefined?'':` Horizon at ${Math.round(perspective.horizon_y)} pixels from the top.`;
    summary.caption+=` Use ${mode} perspective.${horizon}`;
  }

  const output = [];
  for (let itemIndex=0;itemIndex<entries.length;itemIndex++) {
    const entry=entries[itemIndex];
    if (entry.hidden === true) continue;
    checkStrings(entry, ['tags', 'palette'], 'item', entry.id);
    if (!pythonNonemptyText(entry.caption)) check('STUDIO_ITEM_CAPTION_REQUIRED', 'Item caption is empty.', entry.id);
    if ((entry.label === 'text' || Object.hasOwn(entry, 'text')) && !pythonNonemptyText(entry.text)) {
      check('STUDIO_ITEM_TEXT_REQUIRED', 'Item text is empty or missing.', entry.id);
    }
    const [left, top, right, bottom] = entry.bbox;
    if (left < 0 || top < 0 || right > width || bottom > height) {
      check('STUDIO_BBOX_OUT_OF_BOUNDS', 'Item bbox extends outside the layout canvas.', entry.id);
    }
    const converted = centeredBox(entry.bbox, width, height);
    if (converted[2] <= converted[0] || converted[3] <= converted[1]) {
      check('STUDIO_BBOX_INVALID', 'Item bbox has zero area after the required nine-decimal rounding.', entry.id);
    }
    let caption=entry.caption;
    if (options.depth === true && entry.label!=='text') {
      const tier={fg:'In the foreground.',mg:'In the middle ground.',bg:'In the background.'}[entry.depth];
      if(tier)caption+=` ${tier}`;
      // Layer order is back-to-front. Only geometrically overlapping non-text
      // objects receive a relation; avoid inventing a relationship for disjoint boxes.
      const relations=[];
      for(let j=0;j<entries.length&&relations.length<3;j++){
        const other=entries[j];if(j===itemIndex||other.hidden||other.label==='text')continue;
        const b=other.bbox,a=entry.bbox,intersection=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1]));
        const smaller=Math.min((a[2]-a[0])*(a[3]-a[1]),(b[2]-b[0])*(b[3]-b[1]));
        if(intersection/smaller>=.05)relations.push(`${j<itemIndex?'in front of':'behind'} ${other.name||other.caption.slice(0,100)}`);
      }
      if(relations.length)caption+=` Positioned ${relations.join('; ')}.`;
    }
    const compiledItem = { label: entry.label, caption, bbox: converted };
    for (const key of ['text', 'tags', 'palette']) {
      if (Object.hasOwn(entry, key)) compiledItem[key] = entry[key];
    }
    output.push(compiledItem);
  }
  if (!output.length) check('STUDIO_ITEMS_REQUIRED', 'Layout requires at least one visible item.');
  if (omittedChecks) result.checks.push({ code: 'STUDIO_CHECKS_TRUNCATED', message: `${omittedChecks} additional checks omitted.` });
  if (!result.checks.length) {
    result.prompt = JSON.stringify({ bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx', summary, items: output });
    result.compiled = true;
  }
  return result;
}
