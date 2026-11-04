/**
 * Independent implementation of the public Studio Doc and MOSS Layout formats.
 * Format provenance: xiang6150592/-moss-prompt-editor, snapshot 701eecd800891716b1cb1da39a50dd9bc80e579a,
 * src/types.ts (document fields only); no reference implementation is incorporated.
 * Browser-safe ESM: only pure Studio camera math, no I/O, Node globals, generation, or regions adapter.
 */

import {studioCameraMoved,studioCameraText} from './studio-camera.mjs';
import {hasStudioRig,projectStudioComposition} from './studio-composition.mjs';
import {validateStudioRig,validateStudioAttachment,validateStudioRigLayout} from './studio-rig.mjs';
import {validateStudioBubble,validateStudioSketch,assertStudioAnnotations,STUDIO_SKETCH_MAX_POINTS} from './studio-annotations.mjs';
import {validateStudioShared,resolveStudioSharedDoc} from './studio-shared.mjs';
import {assertStudioDocShapes,downgradeStudioDocCandidate,studioDocSchemaVersion} from './studio-doc-version.mjs';
import {studioShapeFidelity,studioShapeCameraBlocked,studioPanelShapeDescription,STUDIO_SHAPE_CAMERA_CODE,STUDIO_SHAPE_CAMERA_MESSAGE} from './studio-shape-render.mjs';

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

// v2 shape structure only. Lattice membership, per-ring/total budgets, simplicity
// and derived-bbox equality belong to studio-doc-version and pure geometry.
const GRID_RING_MAX_POINTS = 128;

function gridPoint(value, path) {
  const point = list((entry, entryPath) => number(-16384, 16384)(entry, entryPath), 2)(value, path);
  if (point.length !== 2) invalid(path, 'expected an [x, y] coordinate pair');
  return point;
}

function polygonShape(value, path) {
  return record(value, path, {
    kind: choice('polygon'), ring: (ring, ringPath) => list(gridPoint, GRID_RING_MAX_POINTS)(ring, ringPath),
  }, ['kind', 'ring']);
}

function itemFields(version) {
  const fields = {
    id: idString, label: choice('object', 'character', 'text'), caption: captionString, bbox,
    text: captionString, tags: textList, palette: textList, name: nameString,
    hidden: boolean, locked: boolean, depth: choice('auto', 'fg', 'mg', 'bg'),
    color: number(0, 255, { integer: true }), body: (v, p) => record(v, p, bodyFields),
    group: string(80),
  };
  // Unknown-field rejection keeps `shape` illegal on the frozen v1 format.
  if (version === 2) {
    fields.shape = polygonShape;
    fields.role = choice('panel');
    fields.rig = validateStudioRig;
    fields.attachment = validateStudioAttachment;
    fields.bubble = validateStudioBubble;
    fields.sketch = validateStudioSketch;
  }
  return fields;
}

function item(value, path, version) {
  const entry = record(value, path, itemFields(version), ['id', 'label', 'caption', 'bbox']);
  if (entry.role === 'panel' && (entry.label !== 'object' || !entry.shape)) {
    invalid(`${path}.role`, 'a panel must be a shaped object');
  }
  return entry;
}

function items(value, path, version) {
  let sketchPoints=0;
  const result = list((entry, entryPath) => {
    const checked=item(entry,entryPath,version);
    if(checked.sketch){
      for(const stroke of checked.sketch.strokes)sketchPoints+=stroke.points.length;
      if(sketchPoints>STUDIO_SKETCH_MAX_POINTS)invalid(entryPath,'sketch_point_budget');
    }
    if((checked.rig||checked.attachment)&&(checked.bubble||checked.sketch))invalid(entryPath,'incompatible annotation and rig');
    return checked;
  }, 128)(value, path);
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

function layout(value, path, version) {
  return record(value, path, {
    width: dimension, height: dimension, bbox_coord_space: choice('abs'), bbox_format: choice('xyxy'),
    summary: (v, p) => record(v, p, {
      caption: captionString, meta: textList, canvas: choice('single', 'multi_panel', 'collage'), palette: textList,
    }, ['caption']),
    items: (v, p) => items(v, p, version),
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
  const version = studioDocSchemaVersion(doc);
  const fields = {
    kind, layout: (value, path) => layout(value, path, version),
    caption: (value, path) => record(value, path, { caption: captionString }),
    shared:(value,path)=>{if(value===undefined)invalid(path,'omit an absent shared snapshot');return validateStudioShared(value);},
  };
  // The marker is echoed only for v2: v1 output must stay byte-for-byte identical.
  if (version === 2) {
    fields.schema_version = (value, path) => {
      if (value !== 2) invalid(path, 'expected 2 when present');
      return 2;
    };
  }
  const result = record(doc, 'doc', fields, ['kind', 'layout', 'caption']);
  if (version === 2) {
    assertStudioDocShapes(result);
    validateStudioRigLayout(result.layout);
    assertStudioAnnotations(result);
  }
  if (new TextEncoder().encode(JSON.stringify(result)).length > MAX_BYTES) {
    invalid('doc', 'UTF-8 JSON exceeds 512 KiB');
  }
  return result;
}

/**
 * Public conversion entry points: full validate, pure conversion, then validate the
 * candidate again. Neither entry point writes anything; callers decide how to persist.
 * A v2 input is already current, so upgrading returns its detached validated copy.
 */
export function upgradeStudioDoc(input) {
  const clean = validateStudioDoc(input);
  if (studioDocSchemaVersion(clean) === 2) return clean;
  return validateStudioDoc({ schema_version: 2, ...clean });
}

/** Downgrade to v1 only as a candidate; shapes need the explicit drop_shapes loss flag. */
export function downgradeStudioDoc(input, options = {}) {
  const clean = validateStudioDoc(input);
  const candidate = downgradeStudioDocCandidate(clean, options);
  return { ...candidate, doc:validateStudioDoc(candidate.doc) };
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
  // v2-only metadata: the same shared helper the Host preview and prepare path reuse.
  // v1 output gains no field at all, so every frozen v1 golden stays byte-identical.
  const version = studioDocSchemaVersion(clean);
  const activeShapes = version === 2 && studioShapeFidelity(clean) === 'bbox-only';
  // The one camera/geometry judgement: v2 Layout + active shape + moved camera.
  const shapeCameraBlocked = studioShapeCameraBlocked(clean);
  let omittedChecks = 0;
  const check = (code, message, item_id) => {
    if (result.checks.length < 128) {
      result.checks.push(item_id === undefined ? { code, message } : { code, message, item_id });
    } else omittedChecks++;
  };
  if (clean.kind === 'caption') {
    if (!pythonNonemptyText(clean.caption.caption)) check('STUDIO_CAPTION_REQUIRED', 'Caption text is empty.');
    else { result.prompt = clean.caption.caption; result.compiled = true; }
    if (version === 2) result.shape_fidelity = 'none';
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
  const cameraMoved = studioCameraMoved(clean.layout);
  if (cameraMoved || hasStudioRig(clean.layout)) {
    // A shape ring cannot be projected, so an active shape with a moved camera is a
    // hard compile failure. This one shared check is reused by prepare, the Host
    // preview and the client; unmoved default cameras stay legal.
    if (shapeCameraBlocked) {
      check(STUDIO_SHAPE_CAMERA_CODE, STUDIO_SHAPE_CAMERA_MESSAGE);
    } else try {
      const view = projectStudioComposition(clean.layout);
      for (const issue of view.checks ?? []) check(issue.code ?? 'STUDIO_PROJECTION_INVALID', issue.message ?? 'Camera projection is invalid.', issue.item_id);
      const originals = new Map(entries.map(item => [item.id,item]));
      entries = view.order.map(id => {
        const original=originals.get(id), projected=view.items[id];
        if(original.role==='panel'||original.bubble||original.sketch||(!cameraMoved&&!original.rig&&!original.attachment))return original;
        const keepExact=original.rig||original.attachment;
        return {...original,bbox:projected?.visible?(keepExact?projected.bbox:projected.bbox.map(Math.round)):original.bbox,hidden:original.hidden||!projected?.visible};
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
  let panelNumber = 0;
  for (let itemIndex=0;itemIndex<entries.length;itemIndex++) {
    const entry=entries[itemIndex];
    if (entry.hidden === true || entry.sketch) continue;
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
    if (entry.role === 'panel') {
      // The frame belongs to the page layout. Keep subjects and dialogue in
      // their own items so a cut never introduces another character or prop.
        const shape = studioPanelShapeDescription(entry.shape.ring);
        summary.caption += ` Panel ${++panelNumber}: ${shape.outline} frame, bounds ${JSON.stringify(converted)} (yxyx). ${shape.hint ? shape.hint+' ' : ''}${entry.caption}`;
      continue;
    }
    let caption=entry.caption;
    if(entry.bubble){
      caption+=` A ${entry.bubble.style} comic balloon.`;
      const speaker=entries.find(item=>item.id===entry.bubble.tail?.speaker_id&&!item.hidden);
      if(speaker)caption+=` Spoken by ${speaker.name||speaker.caption}.`;
    }
    if (options.depth === true && entry.label!=='text') {
      const tier={fg:'In the foreground.',mg:'In the middle ground.',bg:'In the background.'}[entry.depth];
      if(tier)caption+=` ${tier}`;
      // Layer order is back-to-front. Only geometrically overlapping non-text
      // objects receive a relation; avoid inventing a relationship for disjoint boxes.
      const relations=[];
      for(let j=0;j<entries.length&&relations.length<3;j++){
        const other=entries[j];if(j===itemIndex||other.hidden||other.label==='text'||other.role==='panel'||other.sketch)continue;
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
  // Disclosed only when compilation succeeds with active shapes; failures stay checks.
  if (version === 2) result.shape_fidelity = result.compiled && activeShapes ? 'bbox-only' : 'none';
  return result;
}
