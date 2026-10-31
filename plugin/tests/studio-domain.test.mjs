import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { emptyStudioDoc, validateStudioDoc, compileStudioDoc } from '../src/studio-domain.mjs';

function draft() {
  return {
    kind: 'layout',
    layout: {
      width: 1536, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
      summary: { caption: 'A cup on a table.' },
      items: [{ id: 'cup', label: 'object', caption: 'A blue cup.', bbox: [176, 224, 800, 864] }],
    },
    caption: { caption: '' },
  };
}

function invalid(change, name = 'invalid input') {
  const doc = draft();
  change(doc);
  assert.throws(() => validateStudioDoc(doc), (error) => error instanceof TypeError
    && error.code === 'STUDIO_INVALID_INPUT', name);
}

test('empty documents are independent valid blank editors with both modes and no reference prerequisite', () => {
  for (const kind of ['layout', 'caption']) {
    const doc = emptyStudioDoc(kind);
    assert.equal(doc.kind, kind);
    assert.equal(doc.layout.summary.caption, '');
    assert.deepEqual(doc.layout.items, []);
    assert.deepEqual(doc.caption, { caption: '' });
    assert.deepEqual(Object.keys(doc).sort(), ['caption', 'kind', 'layout']);
    assert.deepEqual(validateStudioDoc(doc), doc);
    assert.equal(compileStudioDoc(doc).compiled, false);
    assert.equal(compileStudioDoc(doc).prompt, '');
  }
  const first = emptyStudioDoc();
  const second = emptyStudioDoc();
  first.layout.items.push({});
  first.caption.caption = 'not shared';
  assert.deepEqual(second.layout.items, []);
  assert.equal(second.caption.caption, '');
  assert.throws(() => emptyStudioDoc('other'), { code: 'STUDIO_INVALID_INPUT' });
});

test('validation preserves both branches, all optional fields, whitespace and out-of-canvas coordinates without defaults', () => {
  const doc = draft();
  doc.kind = 'caption';
  doc.caption.caption = '  原句\nunchanged  ';
  doc.layout.summary = { caption: '', meta: ['wide shot'], canvas: 'multi_panel', palette: ['blue'] };
  Object.assign(doc.layout.items[0], {
    caption: '', bbox: [-16.25, -8, 1600, 1100], text: '', tags: ['cup'], palette: ['#336699'],
    name: '  名称  ', hidden: false, locked: true, depth: 'mg', color: 255,
    body: { z: 1.75, thickness: 0.3, yaw: -270, anchor: 'screen' }, group: ' group ',
  });
  doc.layout.camera = { enabled: false, orbit: 50, pitch: 20, roll: -10, distance: 1,
    fov: 50, pan_x: 3, pan_y: 4, pan_z: 5 };
  doc.layout.perspective = { enabled: false, mode: 2, horizon_y: 0.4, vp1_x: -2,
    vp2_x: 2, vp3_x: 0.5, vp3_y: -1, show_grid: true, auto_scale: false, source: 'manual' };
  doc.layout.prompt_options = { depth: true, perspective: false, camera: true };
  const copy = validateStudioDoc(doc);
  assert.deepEqual(copy, doc);
  assert.notEqual(copy, doc);
  assert.notEqual(copy.layout.items[0].body, doc.layout.items[0].body);
  copy.layout.summary.meta[0] = 'changed';
  copy.layout.items[0].bbox[0] = 0;
  assert.equal(doc.layout.summary.meta[0], 'wide shot');
  assert.equal(doc.layout.items[0].bbox[0], -16.25);
  const minimal = draft();
  assert.deepEqual(validateStudioDoc(minimal), minimal);
  minimal.layout.camera = {};
  assert.deepEqual(validateStudioDoc(minimal).layout.camera, {});
});

test('validation rejects missing and unknown fields at every public document boundary', () => {
  for (const change of [
    (d) => { d.extra = true; },
    (d) => { d.layout.extra = true; },
    (d) => { d.caption.extra = true; },
    (d) => { d.layout.summary.extra = true; },
    (d) => { d.layout.items[0].extra = true; },
    (d) => { d.layout.items[0].body = { z: 1, thickness: 0, yaw: 0, anchor: 'world', x: 0 }; },
    (d) => { d.layout.camera = { enabled: false, bogus: 0 }; },
    (d) => { d.layout.perspective = { enabled: false, bogus: 0 }; },
    (d) => { d.layout.prompt_options = { depth: false, bogus: false }; },
    (d) => { delete d.caption; },
    (d) => { delete d.layout.summary.caption; },
    (d) => { delete d.layout.items[0].id; },
    (d) => { d.kind = 'regions'; },
    (d) => { d.layout.bbox_coord_space = 'normalized'; },
    (d) => { d.layout.bbox_format = 'yxyx'; },
    (d) => { d.layout.items[0].label = 'region'; },
    (d) => { d.layout.summary.canvas = 'storyboard'; },
  ]) invalid(change);
});

test('validation rejects wrong scalar types and preserves inclusive numeric boundaries', () => {
  for (const [key, values] of Object.entries({ width: [0, 15, 17, 4112, '1024', NaN], height: [-16, 33, Infinity] })) {
    for (const value of values) invalid((d) => { d.layout[key] = value; }, `${key} ${value}`);
  }
  for (const [key, value] of [['id', ''], ['id', '   '], ['name', 'x'.repeat(201)], ['id', 'x'.repeat(81)],
    ['caption', 'x'.repeat(12001)], ['text', false], ['hidden', 1], ['locked', null], ['color', -1],
    ['color', 256], ['color', 1.5], ['depth', 'front'], ['group', 12], ['tags', 'blue'], ['palette', [null]]]) {
    invalid((d) => { d.layout.items[0][key] = value; }, key);
  }
  invalid((d) => { d.caption.caption = 'x'.repeat(12001); });
  invalid((d) => { d.layout.summary.caption = 'x'.repeat(12001); });
  invalid((d) => { d.layout.summary.meta = [1]; });
  const doc = draft();
  doc.layout.width = 16;
  doc.layout.height = 4096;
  doc.layout.items[0].bbox = [-16384, -16384, 16384, 16384];
  doc.layout.items[0].color = 0;
  doc.layout.items[0].name = 'x'.repeat(200);
  doc.layout.items[0].caption = 'x'.repeat(12000);
  assert.deepEqual(validateStudioDoc(doc), doc);
});

test('validation rejects duplicate ids, nonfinite or degenerate boxes and sparse arrays', () => {
  invalid((d) => { d.layout.items.push({ ...d.layout.items[0] }); });
  for (const bbox of [[1, 2, 1, 3], [1, 2, 3, 2], [2, 2, 1, 3], [0, 0, Infinity, 3],
    [0, NaN, 2, 3], [0, 0, 16385, 3], [0, 0, 2], [0, 0, 2, 3, 4], [0, 0, '2', 3], [0, , 2, 3]]) {
    invalid((d) => { d.layout.items[0].bbox = bbox; });
  }
  invalid((d) => { d.layout.items = new Array(1); });
  invalid((d) => { d.layout.summary.meta = new Array(1); });
  invalid((d) => { d.layout.items[0].tags = new Array(1); });
  invalid((d) => { d.layout.items[0].palette = new Array(1); });
  const doc = draft();
  doc.layout.items = Array.from({ length: 128 }, (_, i) => ({ ...doc.layout.items[0], id: `i${i}` }));
  assert.equal(validateStudioDoc(doc).layout.items.length, 128);
  doc.layout.items.push({ ...doc.layout.items[0], id: 'last' });
  assert.throws(() => validateStudioDoc(doc), { code: 'STUDIO_INVALID_INPUT' });
});

test('body and camera numeric limits reject without clamping; original distance=1 remains intact', () => {
  const body = { z: 100, thickness: 10, yaw: 360, anchor: 'backdrop' };
  const camera = { enabled: true, orbit: -180, pitch: 85, roll: 180, distance: 0.01, fov: 120,
    pan_x: -100, pan_y: 100, pan_z: 100 };
  const doc = draft();
  doc.layout.items[0].body = body;
  doc.layout.camera = camera;
  assert.deepEqual(validateStudioDoc(doc), doc);
  for (const [key, value] of [['z', 0], ['z', 101], ['thickness', -1], ['thickness', 11],
    ['yaw', -361], ['yaw', 361], ['anchor', 'canvas']]) {
    invalid((d) => { d.layout.items[0].body = { ...body, [key]: value }; });
  }
  for (const [key, value] of [['enabled', 1], ['orbit', 181], ['pitch', -86], ['roll', -181],
    ['distance', 0], ['distance', 101], ['fov', 9], ['fov', 121], ['pan_x', -101],
    ['pan_y', 101], ['pan_z', Infinity]]) {
    invalid((d) => { d.layout.camera = { ...camera, [key]: value }; });
  }
  for (const change of [
    (d) => { d.layout.perspective = { enabled: true, mode: 4 }; },
    (d) => { d.layout.perspective = { enabled: false, horizon_y: NaN }; },
    (d) => { d.layout.perspective = { enabled: false, show_grid: 1 }; },
    (d) => { d.layout.perspective = { enabled: false, source: 'guess' }; },
    (d) => { d.layout.prompt_options = { depth: 'yes' }; },
  ]) invalid(change);
});

test('validation enforces UTF-8 JSON budget instead of a character or UTF-16 estimate', () => {
  const doc = draft();
  doc.layout.items = Array.from({ length: 44 }, (_, i) => ({
    id: `item-${i}`, label: 'object', caption: '界'.repeat(4000), bbox: [0, 0, 1, 1],
  }));
  assert.ok(JSON.stringify(doc).length < 512 * 1024);
  assert.ok(new TextEncoder().encode(JSON.stringify(doc)).length > 512 * 1024);
  assert.throws(() => validateStudioDoc(doc), { code: 'STUDIO_INVALID_INPUT' });
  doc.layout.items.length = 40;
  assert.equal(validateStudioDoc(doc).layout.items.length, 40);
});

test('validation rejects non-JSON values and accessors without executing input code', () => {
  for (const value of [null, [], 1, 'doc', new Date()]) {
    assert.throws(() => validateStudioDoc(value), { code: 'STUDIO_INVALID_INPUT' });
  }
  invalid((d) => { d.layout.camera = undefined; });
  invalid((d) => { d.layout.items[0].tags = [undefined]; });
  invalid((d) => { d.layout.summary[Symbol('extra')] = true; });
  invalid((d) => { Object.defineProperty(d.layout.summary, 'extra', { value: 1 }); });
  invalid((d) => { d.layout.items.note = 'not JSON'; });
  invalid((d) => { d.layout.items[0].body = d; });
  let invoked = false;
  const doc = draft();
  Object.defineProperty(doc.layout.summary, 'caption', { enumerable: true, get() { invoked = true; return 'x'; } });
  assert.throws(() => validateStudioDoc(doc), { code: 'STUDIO_INVALID_INPUT' });
  assert.equal(invoked, false);
});

test('caption compilation keeps original words, spacing and newlines, never the layout branch', () => {
  const doc = draft();
  doc.kind = 'caption';
  doc.caption.caption = '  茶杯，原词。\nSecond line.  ';
  assert.deepEqual(compileStudioDoc(doc), {
    prompt: '  茶杯，原词。\nSecond line.  ', checks: [], prefix: '', negative: '', kind: 'caption', compiled: true,
  });
  for (const caption of ['', ' \n\t ']) {
    doc.caption.caption = caption;
    const result = compileStudioDoc(doc);
    assert.equal(result.compiled, false);
    assert.equal(result.prompt, '');
    assert.ok(result.checks.some((check) => check.code === 'STUDIO_CAPTION_REQUIRED'));
  }
});

test('layout compilation uses hand-derived centralized yxyx and strips only editor metadata', () => {
  const doc = draft();
  doc.layout.summary = { caption: ' A cup on a table. ', meta: ['wide shot'], canvas: 'single', palette: ['blue'] };
  Object.assign(doc.layout.items[0], {
    name: 'Display name', hidden: false, locked: true, depth: 'fg', color: 7,
    body: { z: 2, thickness: 0.4, yaw: 45, anchor: 'world' }, group: 'group-a',
    tags: ['ceramic'], palette: ['#123456'],
  });
  doc.layout.items.push({ id: 'letter', label: 'text', caption: 'Lettering.', text: ' 茶 ', bbox: [0, 0, 1536, 1024] });
  doc.layout.items.push({ id: 'hidden', label: 'text', caption: '', text: '', hidden: true, bbox: [-10, -10, 20, 20] });
  doc.layout.prompt_options = { depth: true, perspective: true, camera: true };
  const before = structuredClone(doc);
  const result = compileStudioDoc(doc);
  assert.equal(result.compiled, true);
  assert.deepEqual(result.checks, []);
  assert.deepEqual(JSON.parse(result.prompt), {
    bbox_coord_space: 'abs_centralized', bbox_format: 'yxyx',
    summary: { caption: ' A cup on a table. ', meta: ['wide shot'], canvas: 'single', palette: ['blue'] },
    items: [
      { label: 'object', caption: 'A blue cup. In the foreground.', bbox: [-288, -592, 352, 32], tags: ['ceramic'], palette: ['#123456'] },
      { label: 'text', caption: 'Lettering.', text: ' 茶 ', bbox: [-512, -768, 512, 768] },
    ],
  });
  assert.equal(result.prompt.includes('\n'), false);
  assert.equal(result.prefix, '');
  assert.equal(result.negative, '');
  assert.equal(result.kind, 'layout');
  assert.deepEqual(doc, before);
});

test('fractional edges round to nine decimals before outward integer rounding', () => {
  const doc = draft();
  doc.layout.width = 1024;
  doc.layout.height = 1024;
  doc.layout.items[0].bbox = [100.9999999996, 200.0000000004, 300.0000000004, 400.9999999996];
  assert.deepEqual(JSON.parse(compileStudioDoc(doc).prompt).items[0].bbox, [-312, -411, -111, -212]);
  doc.layout.items[0].bbox = [100.25, 200.75, 300.25, 400.75];
  assert.deepEqual(JSON.parse(compileStudioDoc(doc).prompt).items[0].bbox, [-312, -412, -111, -211]);
});

test('decimal quantization follows binary-float ties-to-even before outward bbox rounding', () => {
  // Literal golden vectors independently checked against the public Python compiler.
  const fixtures = [
    { box: [0.9999999995, 0, 32, 32], want: [-512, -512, -480, -480] },
    { box: [1.9999999995, 15.9999999995, 32.0000000005, 64.0000000005], want: [-497, -511, -448, -479] },
    { box: [0, 0, 1.0000000005, 2.0000000005], want: [-512, -512, -509, -510] },
    { box: [31.9999999995, 63.9999999995, 1023.9999999995, 1024], want: [-449, -480, 512, 512] },
    { box: [0.0009765625, 0.0029296875, 1.0009765625, 2.0029296875], want: [-512, -512, -509, -510] },
  ];
  for (const { box, want } of fixtures) {
    const doc = draft();
    doc.layout.width = 1024;
    doc.layout.items[0].bbox = box;
    const result = compileStudioDoc(doc);
    assert.equal(result.compiled, true);
    assert.deepEqual(JSON.parse(result.prompt).items[0].bbox, want, JSON.stringify(box));
    assert.deepEqual(doc.layout.items[0].bbox, box);
  }
});

test('nine-decimal collapse is reported rather than emitting a zero-area compiled bbox', () => {
  const doc = draft();
  doc.layout.items[0].bbox = [1, 1, 1.0000000001, 2];
  assert.deepEqual(validateStudioDoc(doc).layout.items[0].bbox, [1, 1, 1.0000000001, 2]);
  const result = compileStudioDoc(doc);
  assert.equal(result.compiled, false);
  assert.equal(result.prompt, '');
  assert.ok(result.checks.some((check) => check.code === 'STUDIO_BBOX_INVALID' && check.item_id === 'cup'));
  assert.deepEqual(doc.layout.items[0].bbox, [1, 1, 1.0000000001, 2]);
});

test('layout reports blank prompts and visible outside boxes without silent repair', () => {
  const doc = draft();
  doc.layout.summary.caption = '  ';
  doc.layout.items[0].caption = '';
  doc.layout.items[0].bbox = [-0.0000000001, 0, 1537, 1024];
  doc.layout.items.push({ id: 'text-1', label: 'text', caption: 'Lettering', text: ' ', bbox: [0, 0, 2, 2] });
  const before = structuredClone(doc);
  const result = compileStudioDoc(doc);
  assert.equal(result.compiled, false);
  assert.equal(result.prompt, '');
  assert.ok(result.checks.some((check) => check.code === 'STUDIO_SUMMARY_CAPTION_REQUIRED'));
  assert.ok(result.checks.some((check) => check.code === 'STUDIO_ITEM_CAPTION_REQUIRED' && check.item_id === 'cup'));
  assert.ok(result.checks.some((check) => check.code === 'STUDIO_ITEM_TEXT_REQUIRED' && check.item_id === 'text-1'));
  assert.ok(result.checks.some((check) => check.code === 'STUDIO_BBOX_OUT_OF_BOUNDS' && check.item_id === 'cup'));
  assert.ok(result.checks.every((check) => typeof check.message === 'string' && check.message.length));
  assert.deepEqual(doc, before);
  const absentText = draft();
  absentText.layout.items[0].label = 'text';
  assert.equal(compileStudioDoc(absentText).compiled, false);
  const explicitEmptyText = draft();
  explicitEmptyText.layout.items[0].text = '';
  assert.equal(compileStudioDoc(explicitEmptyText).compiled, false);
});

test('empty or all-hidden layouts remain valid editors but cannot emit an empty official items array', () => {
  for (const hiddenOnly of [false, true]) {
    const doc = draft();
    if (hiddenOnly) doc.layout.items[0].hidden = true;
    else doc.layout.items = [];
    const before = structuredClone(doc);
    assert.deepEqual(validateStudioDoc(doc), before);
    const result = compileStudioDoc(doc);
    assert.equal(result.compiled, false);
    assert.equal(result.prompt, '');
    assert.ok(result.checks.some((check) => check.code === 'STUDIO_ITEMS_REQUIRED'));
    assert.deepEqual(doc, before);
  }
});

test('blank meta, tags and palette entries are saved verbatim but prevent official compilation', () => {
  for (const [scope, field] of [['summary', 'meta'], ['summary', 'palette'], ['item', 'tags'], ['item', 'palette']]) {
    for (const blank of ['', ' \n\t ']) {
      const doc = draft();
      const target = scope === 'summary' ? doc.layout.summary : doc.layout.items[0];
      target[field] = ['  original words  ', blank];
      const before = structuredClone(doc);
      assert.deepEqual(validateStudioDoc(doc), before);
      const result = compileStudioDoc(doc);
      assert.equal(result.compiled, false, `${scope}.${field}`);
      assert.equal(result.prompt, '');
      assert.ok(result.checks.some((check) => check.code === 'STUDIO_STRING_ENTRY_REQUIRED'
        && check.message.includes(`${field}[1]`)
        && (scope === 'summary' ? !Object.hasOwn(check, 'item_id') : check.item_id === 'cup')));
      assert.deepEqual(doc, before);
    }
  }
});

test('compiler empty-text checks match all Python whitespace characters without altering the editor', () => {
  // Literal Python str.isspace set, independently enumerated over all Unicode codepoints.
  const whitespace = [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
    0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
    0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
  const targets = [
    ['caption', (d, s) => { d.kind = 'caption'; d.caption.caption = s; }],
    ['summary.caption', (d, s) => { d.layout.summary.caption = s; }],
    ['item.caption', (d, s) => { d.layout.items[0].caption = s; }],
    ['item.text', (d, s) => { d.layout.items[0].label = 'text'; d.layout.items[0].text = s; }],
    ['summary.meta', (d, s) => { d.layout.summary.meta = [s]; }],
    ['summary.palette', (d, s) => { d.layout.summary.palette = [s]; }],
    ['item.tags', (d, s) => { d.layout.items[0].tags = [s]; }],
    ['item.palette', (d, s) => { d.layout.items[0].palette = [s]; }],
  ];
  for (const point of whitespace) {
    for (const [name, set] of targets) {
      const doc = draft();
      set(doc, String.fromCodePoint(point));
      const before = structuredClone(doc);
      assert.deepEqual(validateStudioDoc(doc), before);
      const result = compileStudioDoc(doc);
      assert.equal(result.compiled, false, `${name} U+${point.toString(16)}`);
      assert.equal(result.prompt, '');
      assert.ok(result.checks.length);
      assert.deepEqual(doc, before);
    }
  }
});

test('compiler preserves FEFF and surrounding Python whitespace as nonempty original text', () => {
  const value = '\u0085\ufeff\u001c';
  const doc = draft();
  doc.layout.summary = { caption: value, meta: [value], palette: [value] };
  Object.assign(doc.layout.items[0], { label: 'text', caption: value, text: value, tags: [value], palette: [value] });
  const result = compileStudioDoc(doc);
  assert.equal(result.compiled, true);
  const output = JSON.parse(result.prompt);
  assert.deepEqual(output.summary, { caption: value, meta: [value], palette: [value] });
  assert.equal(output.items[0].caption, value);
  assert.equal(output.items[0].text, value);
  assert.deepEqual(output.items[0].tags, [value]);
  assert.deepEqual(output.items[0].palette, [value]);
  doc.kind = 'caption';
  doc.caption.caption = '\ufeff';
  assert.equal(compileStudioDoc(doc).compiled, true);
  assert.equal(compileStudioDoc(doc).prompt, '\ufeff');
});

test('compiler bounds diagnostic amplification while reporting the exact omitted check count', () => {
  const doc = draft();
  doc.layout.summary.meta = Array(170000).fill('');
  assert.ok(new TextEncoder().encode(JSON.stringify(doc)).length < 512 * 1024);
  assert.equal(validateStudioDoc(doc).layout.summary.meta.length, 170000);
  const result = compileStudioDoc(doc);
  assert.equal(result.compiled, false);
  assert.equal(result.prompt, '');
  assert.equal(result.checks.length, 129);
  assert.ok(result.checks.slice(0, 128).every((check) => check.code === 'STUDIO_STRING_ENTRY_REQUIRED'));
  assert.deepEqual(result.checks[128], {
    code: 'STUDIO_CHECKS_TRUNCATED', message: '169872 additional checks omitted.',
  });
  assert.ok(JSON.stringify(result).length < 20000);
  assert.equal(doc.layout.summary.meta.length, 170000);
});

test('empty optional arrays and hidden item blanks do not prevent a valid visible item compiling', () => {
  const doc = draft();
  doc.layout.summary.meta = [];
  doc.layout.summary.palette = [];
  doc.layout.items[0].tags = ['  literal tag  '];
  doc.layout.items[0].palette = [];
  doc.layout.items.push({ id: 'hidden', label: 'object', caption: '', bbox: [0, 0, 1, 1],
    hidden: true, tags: [''], palette: [' '] });
  const result = compileStudioDoc(doc);
  assert.equal(result.compiled, true);
  const output = JSON.parse(result.prompt);
  assert.deepEqual(output.summary.meta, []);
  assert.deepEqual(output.summary.palette, []);
  assert.deepEqual(output.items[0].tags, ['  literal tag  ']);
  assert.deepEqual(output.items[0].palette, []);
  assert.equal(output.items.length, 1);
});

test('default camera uses source distance=1 and moved cameras compile or diagnose empty projection', () => {
  const defaults = { enabled: true, orbit: 0, pitch: 0, roll: 0, distance: 1, fov: 50, pan_x: 0, pan_y: 0, pan_z: 0 };
  for (const camera of [{}, defaults, { enabled: false, distance: 5, orbit: 45 }, { enabled: true }]) {
    const doc = draft();
    doc.layout.camera = camera;
    assert.equal(compileStudioDoc(doc).compiled, true);
    assert.deepEqual(doc.layout.camera, camera);
  }
  for (const [key, value] of [['orbit', 1], ['pitch', 1], ['roll', 1], ['distance', 5], ['fov', 51],
    ['pan_x', 1], ['pan_y', 1], ['pan_z', 1]]) {
    const doc = draft();
    doc.layout.camera = { ...defaults, [key]: value };
    const result = compileStudioDoc(doc);
    assert.ok(!result.checks.some((check) => check.code === 'STUDIO_CAMERA_ADAPTER_REQUIRED'), key);
    if(result.compiled)assert.ok(JSON.parse(result.prompt).items.length>0);
    else assert.ok(result.checks.some((check)=>check.code==='STUDIO_ITEMS_REQUIRED'),key);
    assert.equal(doc.layout.camera[key], value);
  }
});

test('enabled perspective can supply optional guidance while disabled perspective roundtrips', () => {
  const doc = draft();
  doc.layout.perspective = { enabled: true, mode: 1, horizon_y: 0.5, vp1_x: 0.5,
    vp2_x: 1.5, vp3_x: 0.5, vp3_y: -1, show_grid: true, auto_scale: false, source: 'boxes' };
  let result = compileStudioDoc(doc);
  assert.equal(result.compiled, true);
  assert.ok(!result.checks.some((check) => check.code === 'STUDIO_PERSPECTIVE_ADAPTER_REQUIRED'));
  doc.layout.perspective.enabled = false;
  result = compileStudioDoc(doc);
  assert.equal(result.compiled, true);
  assert.equal(doc.layout.perspective.source, 'boxes');
});

test('compile validates the whole document instead of hiding an invalid inactive branch', () => {
  const doc = draft();
  doc.kind = 'caption';
  doc.caption.caption = 'valid plain caption';
  doc.layout.items[0].bbox = [0, 0, 0, 1];
  assert.throws(() => compileStudioDoc(doc), { code: 'STUDIO_INVALID_INPUT' });
});

test('the module runs in a browser-like realm with bundled pure dependencies and no Node globals', async () => {
  const source = await readFile(new URL('../src/studio-domain.mjs', import.meta.url), 'utf8');
  // Execute real module bodies in separate lexical scopes, as a browser bundle does;
  // only their imported API names cross the boundary, never private const/helpers.
  const context = vm.createContext({ TextEncoder, structuredClone });
  const cameraSource=await readFile(new URL('../src/studio-camera.mjs',import.meta.url),'utf8');
  const cameraBody=cameraSource.replace(/^export\s+/gm,'');
  const cameraModule=`const {projectStudioLayout,studioCameraMoved,studioCameraText}=(()=>{${cameraBody}\nreturn {projectStudioLayout,studioCameraMoved,studioCameraText};})();\n`;
  const sharedSource=await readFile(new URL('../src/studio-shared.mjs',import.meta.url),'utf8');
  const sharedBody=sharedSource.replace(/^export\s+/gm,'');
  const sharedModule=`const {validateStudioShared,resolveStudioSharedDoc}=(()=>{${sharedBody}\nreturn {validateStudioShared,resolveStudioSharedDoc};})();\n`;
  const program = cameraModule+sharedModule+source.replace(/^import[^\n]+\n/gm,'').replace(/\bexport\s+(?=function\s)/g, '') + '\n;({emptyStudioDoc,validateStudioDoc,compileStudioDoc})';
  const api = vm.runInContext(program, context);
  const doc = api.emptyStudioDoc('caption');
  doc.caption.caption = '浏览器中原样保留';
  assert.equal(api.compileStudioDoc(doc).prompt, '浏览器中原样保留');
  assert.equal(api.validateStudioDoc(doc).caption.caption, '浏览器中原样保留');
  const layout = api.emptyStudioDoc();
  layout.layout.summary.caption = 'Browser layout';
  // Create records in the browser realm, as a client document editor does.
  context.doc = layout;
  vm.runInContext("doc.layout.items.push({id:'cup',label:'object',caption:'Cup',bbox:[0.9999999995,0,32,32]})", context);
  assert.equal(JSON.stringify(JSON.parse(api.compileStudioDoc(layout).prompt).items[0].bbox), '[-512,-512,-480,-480]');
  vm.runInContext(`doc.shared={series_id:'9b27c847-ff20-42ca-9268-af25282c25df',revision:1,
    style:'Browser shared style',cast:[],bindings:[],caption_cast_ids:[]}`, context);
  assert.equal(api.validateStudioDoc(layout).shared.style, 'Browser shared style');
  const compiledShared = JSON.parse(api.compileStudioDoc(layout).prompt);
  assert.equal(compiledShared.summary.caption, 'Browser shared style\n\nBrowser layout');
  assert.equal(compiledShared.items[0].caption, 'Cup');
  assert.equal(Object.hasOwn(compiledShared, 'shared'), false);
  assert.equal(layout.layout.summary.caption, 'Browser layout');
  assert.equal(layout.shared.style, 'Browser shared style');
});
