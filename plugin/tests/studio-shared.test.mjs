import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { validateStudioShared, resolveStudioSharedDoc, sharedSnapshot } from '../src/studio-shared.mjs';

const SERIES = '9b27c847-ff20-42ca-9268-af25282c25df';

function profile() {
  return { series_id: SERIES, revision: 1, style: '  Ink illustration.  ', cast: [
    { character_id: 'alice', name: 'Alice', description: 'Red-haired traveler.' },
    { character_id: 'bob', name: 'Bob', description: 'Blue-cloaked musician.' },
  ] };
}

function snapshot() {
  return { ...profile(), bindings: [{ item_id: 'hero', character_id: 'alice' }], caption_cast_ids: ['bob'] };
}

function doc(kind = 'layout') {
  return {
    kind,
    layout: { width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
      summary: { caption: 'Under the tree.', meta: ['wide'], palette: ['blue'] }, items: [
        { id: 'hero', label: 'character', name: 'Local display', caption: 'Holding a cup.', bbox: [0, 0, 512, 1024],
          body: { z: 1, thickness: 0, yaw: 0, anchor: 'world' }, tags: ['standing'], hidden: false },
        { id: 'other', label: 'character', name: 'Alice', caption: 'Seated on a bench.', bbox: [512, 0, 1024, 1024] },
        { id: 'cup', label: 'object', caption: 'A ceramic cup.', bbox: [100, 100, 200, 200] },
      ] },
    caption: { caption: 'Local scene action.' },
  };
}

function invalidSnapshot(change) {
  const value = snapshot();
  change(value);
  assert.throws(() => validateStudioShared(value), { code: 'STUDIO_INVALID_INPUT' });
}

test('snapshot validation preserves exact fields and returns fully detached data', () => {
  const input = snapshot();
  const output = validateStudioShared(input);
  assert.deepEqual(output, input);
  assert.notEqual(output, input);
  assert.notEqual(output.cast, input.cast);
  assert.notEqual(output.cast[0], input.cast[0]);
  assert.notEqual(output.bindings[0], input.bindings[0]);
  assert.notEqual(output.caption_cast_ids, input.caption_cast_ids);
  output.cast[0].description = 'changed';
  output.bindings[0].item_id = 'changed';
  output.caption_cast_ids.push('alice');
  assert.equal(input.cast[0].description, 'Red-haired traveler.');
  assert.equal(input.bindings[0].item_id, 'hero');
  assert.deepEqual(input.caption_cast_ids, ['bob']);
  assert.equal(validateStudioShared(undefined), undefined);
});

test('sharedSnapshot freezes profile revision and copies explicit bindings without live inheritance', () => {
  const source = profile();
  const bindings = [{ item_id: 'hero', character_id: 'alice' }];
  const selections = ['bob', 'alice'];
  const output = sharedSnapshot(source, bindings, selections);
  assert.deepEqual(output, { ...profile(), bindings, caption_cast_ids: ['bob', 'alice'] });
  source.revision = 2;
  source.style = 'Different style';
  source.cast[0].description = 'Different identity';
  bindings[0].character_id = 'bob';
  selections.reverse();
  assert.equal(output.revision, 1);
  assert.equal(output.style, '  Ink illustration.  ');
  assert.equal(output.cast[0].description, 'Red-haired traveler.');
  assert.deepEqual(output.bindings, [{ item_id: 'hero', character_id: 'alice' }]);
  assert.deepEqual(output.caption_cast_ids, ['bob', 'alice']);
  assert.deepEqual(sharedSnapshot(profile()), { ...profile(), bindings: [], caption_cast_ids: [] });
});

test('strict snapshot rejects unknown or missing fields without copying hashes or source metadata', () => {
  for (const change of [
    (v) => { v.hash = 'not-in-pure-contract'; },
    (v) => { v.cast[0].extra = true; },
    (v) => { v.bindings[0].extra = true; },
    (v) => { delete v.series_id; },
    (v) => { delete v.revision; },
    (v) => { delete v.style; },
    (v) => { delete v.cast; },
    (v) => { delete v.bindings; },
    (v) => { delete v.caption_cast_ids; },
    (v) => { delete v.cast[0].name; },
    (v) => { delete v.cast[0].description; },
    (v) => { delete v.bindings[0].character_id; },
  ]) invalidSnapshot(change);
  assert.throws(() => sharedSnapshot({ ...profile(), hash: 'x' }), { code: 'STUDIO_INVALID_INPUT' });
  assert.throws(() => sharedSnapshot(snapshot()), { code: 'STUDIO_INVALID_INPUT' });
});

test('strict snapshot validates UUID, positive safe revision and scalar limits without coercing or trimming', () => {
  for (const change of [
    (v) => { v.series_id = 'not-a-uuid'; },
    (v) => { v.series_id = '00000000-0000-0000-0000-000000000000'; },
    (v) => { v.revision = 0; },
    (v) => { v.revision = 1.5; },
    (v) => { v.revision = Number.MAX_SAFE_INTEGER + 1; },
    (v) => { v.revision = '1'; },
    (v) => { v.style = 'a'.repeat(12001); },
    (v) => { v.style = null; },
    (v) => { v.cast[0].character_id = ''; },
    (v) => { v.cast[0].character_id = ' '; },
    (v) => { v.cast[0].character_id = 'a'.repeat(81); },
    (v) => { v.cast[0].name = 'a'.repeat(201); },
    (v) => { v.cast[0].description = 'a'.repeat(12001); },
    (v) => { v.bindings[0].item_id = ''; },
    (v) => { v.bindings[0].item_id = 'a'.repeat(81); },
    (v) => { v.caption_cast_ids = [null]; },
  ]) invalidSnapshot(change);
  const input = snapshot();
  input.series_id = SERIES.toUpperCase();
  input.revision = Number.MAX_SAFE_INTEGER;
  input.style = 'a'.repeat(12000);
  input.cast[0] = { character_id: 'a'.repeat(80), name: 'n'.repeat(200), description: 'd'.repeat(12000) };
  input.bindings[0] = { item_id: 'i'.repeat(80), character_id: 'a'.repeat(80) };
  assert.deepEqual(validateStudioShared(input), input);
  input.style = '';
  input.cast[0].name = '';
  input.cast[0].description = '';
  assert.deepEqual(validateStudioShared(input), input);
});

test('cast ids, binding item ids and caption selections must be unique and reference known cast ids', () => {
  for (const change of [
    (v) => { v.cast.push({ ...v.cast[0] }); },
    (v) => { v.bindings.push({ item_id: 'hero', character_id: 'bob' }); },
    (v) => { v.bindings[0].character_id = 'unknown'; },
    (v) => { v.caption_cast_ids = ['unknown']; },
    (v) => { v.caption_cast_ids = ['alice', 'alice']; },
    (v) => { v.cast = []; },
  ]) invalidSnapshot(change);
  const input = snapshot();
  input.bindings.push({ item_id: 'other', character_id: 'alice' });
  input.cast[1].name = input.cast[0].name;
  assert.deepEqual(validateStudioShared(input), input, 'same card may bind different items; names need not be unique');
});

test('snapshot permits the exact array caps and rejects sparse or oversized arrays', () => {
  const input = { series_id: SERIES, revision: 1, style: '',
    cast: Array.from({ length: 32 }, (_, i) => ({ character_id: `c${i}`, name: '', description: '' })),
    bindings: Array.from({ length: 128 }, (_, i) => ({ item_id: `i${i}`, character_id: `c${i % 32}` })),
    caption_cast_ids: Array.from({ length: 32 }, (_, i) => `c${i}`) };
  assert.deepEqual(validateStudioShared(input), input);
  for (const [key, extra] of [['cast', { character_id: 'last', name: '', description: '' }],
    ['bindings', { item_id: 'last', character_id: 'c0' }], ['caption_cast_ids', 'last']]) {
    const overflow = structuredClone(input);
    overflow[key].push(extra);
    assert.throws(() => validateStudioShared(overflow), { code: 'STUDIO_INVALID_INPUT' });
    invalidSnapshot((v) => { v[key] = new Array(1); });
  }
});

test('snapshot rejects non-JSON records, symbol keys, accessors and decorated arrays', () => {
  for (const value of [null, 0, [], 'snapshot', new Date()]) {
    assert.throws(() => validateStudioShared(value), { code: 'STUDIO_INVALID_INPUT' });
  }
  invalidSnapshot((v) => { v.cast[0] = new Date(); });
  invalidSnapshot((v) => { v[Symbol('unknown')] = true; });
  invalidSnapshot((v) => { Object.defineProperty(v.cast[0], 'description', { value: 'x', enumerable: false }); });
  invalidSnapshot((v) => { v.bindings.extra = true; });
  invalidSnapshot((v) => { v.cast[0].description = undefined; });
  let invoked = false;
  const input = snapshot();
  Object.defineProperty(input, 'style', { enumerable: true, get() { invoked = true; return 'x'; } });
  assert.throws(() => validateStudioShared(input), { code: 'STUDIO_INVALID_INPUT' });
  assert.equal(invoked, false);
});

test('snapshot byte budget uses UTF-8 rather than character length', () => {
  const input = { series_id: SERIES, revision: 1, style: '',
    cast: Array.from({ length: 32 }, (_, i) => ({ character_id: `c${i}`, name: '', description: '界'.repeat(6000) })),
    bindings: [], caption_cast_ids: [] };
  assert.ok(JSON.stringify(input).length < 512 * 1024);
  assert.ok(new TextEncoder().encode(JSON.stringify(input)).length > 512 * 1024);
  assert.throws(() => validateStudioShared(input), { code: 'STUDIO_INVALID_INPUT' });
});

test('no-shared documents retain byte-identical content and nested detachment', () => {
  const input = doc();
  const original = JSON.stringify(input);
  const output = resolveStudioSharedDoc(input);
  assert.equal(JSON.stringify(output), original);
  assert.notEqual(output, input);
  assert.notEqual(output.layout.items[0].body, input.layout.items[0].body);
  output.layout.items[0].bbox[0] = 99;
  output.layout.summary.meta.push('not shared');
  assert.equal(input.layout.items[0].bbox[0], 0);
  assert.deepEqual(input.layout.summary.meta, ['wide']);
});

test('layout resolution injects style once and only the explicitly ID-bound card before local action', () => {
  const input = doc();
  input.shared = snapshot();
  const before = structuredClone(input);
  const output = resolveStudioSharedDoc(input);
  assert.equal(output.layout.summary.caption, '  Ink illustration.  \n\nUnder the tree.');
  assert.equal(output.layout.items[0].caption, 'Red-haired traveler.\n\nHolding a cup.');
  assert.equal(output.layout.items[1].caption, 'Seated on a bench.');
  assert.equal(output.layout.items[2].caption, 'A ceramic cup.');
  assert.deepEqual(output.caption, { caption: 'Local scene action.' });
  assert.equal(Object.hasOwn(output, 'shared'), false);
  assert.deepEqual(input, before);
  assert.deepEqual(resolveStudioSharedDoc(output), output, 'a resolved document does not inject a second time');
  const cropPrompt = [input.shared.style, output.layout.items[0].caption].join('\n\n');
  assert.equal(cropPrompt, '  Ink illustration.  \n\nRed-haired traveler.\n\nHolding a cup.');
  assert.equal(cropPrompt.includes('Blue-cloaked musician.'), false);
  assert.equal(cropPrompt.includes('Under the tree.'), false);
});

test('caption resolution selects only explicit cast ids in selection order, not binding or cast order', () => {
  const input = doc('caption');
  input.shared = { ...snapshot(), caption_cast_ids: ['bob', 'alice'] };
  const output = resolveStudioSharedDoc(input);
  assert.equal(output.caption.caption, '  Ink illustration.  \n\nBlue-cloaked musician.\n\nRed-haired traveler.\n\nLocal scene action.');
  assert.deepEqual(output.layout, input.layout);
  input.shared.caption_cast_ids = [];
  assert.equal(resolveStudioSharedDoc(input).caption.caption, '  Ink illustration.  \n\nLocal scene action.');
  assert.equal(Object.hasOwn(output, 'shared'), false);
});

test('empty shared text adds no separator or display-name text, while nonempty text preserves original whitespace', () => {
  const input = doc();
  input.shared = snapshot();
  input.shared.style = '';
  input.shared.cast[0].description = '';
  assert.deepEqual(resolveStudioSharedDoc(input), doc());
  input.layout.summary.caption = '';
  input.layout.items[0].caption = '';
  input.shared.style = '  ';
  input.shared.cast[0].description = '\n';
  const output = resolveStudioSharedDoc(input);
  assert.equal(output.layout.summary.caption, '  ');
  assert.equal(output.layout.items[0].caption, '\n');
  assert.equal(output.layout.items[0].caption.includes('Alice'), false);
});

test('resolution rejects dangling or non-character bindings in both active document modes', () => {
  for (const kind of ['layout', 'caption']) {
    for (const item_id of ['missing', 'cup']) {
      const input = doc(kind);
      input.shared = { ...snapshot(), bindings: [{ item_id, character_id: 'alice' }] };
      assert.throws(() => resolveStudioSharedDoc(input), { code: 'STUDIO_INVALID_INPUT' });
    }
  }
  const input = doc();
  input.shared = snapshot();
  input.layout.items[0].label = 'text';
  assert.throws(() => resolveStudioSharedDoc(input), { code: 'STUDIO_INVALID_INPUT' });
});

test('resolved captions exceeding field or UTF-8 document budgets fail without truncation', () => {
  for (const target of ['style', 'item', 'caption']) {
    const input = doc(target === 'caption' ? 'caption' : 'layout');
    input.shared = snapshot();
    if (target === 'style') input.shared.style = 'x'.repeat(12000);
    else input.shared.cast[0].description = 'x'.repeat(12000);
    if (target === 'caption') input.shared.caption_cast_ids = ['alice'];
    const before = structuredClone(input);
    assert.throws(() => resolveStudioSharedDoc(input), { code: 'STUDIO_INVALID_INPUT' });
    assert.deepEqual(input, before);
  }
  const input = doc();
  input.layout.items = Array.from({ length: 128 }, (_, i) => ({ id: `i${i}`, label: 'character', caption: '', bbox: [0, 0, 1, 1] }));
  input.shared = { series_id: SERIES, revision: 1, style: '',
    cast: [{ character_id: 'same', name: '', description: '界'.repeat(2000) }],
    bindings: input.layout.items.map(({ id }) => ({ item_id: id, character_id: 'same' })), caption_cast_ids: [] };
  assert.throws(() => resolveStudioSharedDoc(input), { code: 'STUDIO_INVALID_INPUT' });
});

test('resolution allows exact joined 12000-character boundary without adding extra leading separators', () => {
  const input = doc();
  input.shared = snapshot();
  input.shared.style = 's'.repeat(11997);
  input.layout.summary.caption = 'x';
  input.shared.cast[0].description = 'd'.repeat(12000);
  input.layout.items[0].caption = '';
  const output = resolveStudioSharedDoc(input);
  assert.equal(output.layout.summary.caption.length, 12000);
  assert.equal(output.layout.items[0].caption, 'd'.repeat(12000));
});

test('module executes in a browser-only realm without imports, Node globals or domain dependency', async () => {
  const source = await readFile(new URL('../src/studio-shared.mjs', import.meta.url), 'utf8');
  const context = vm.createContext({ TextEncoder, structuredClone });
  const api = vm.runInContext(source.replace(/\bexport\s+(?=function\s)/g, '')
    + '\n;({validateStudioShared,sharedSnapshot,resolveStudioSharedDoc})', context);
  context.data = JSON.stringify({ doc: doc(), shared: snapshot(), profile: profile() });
  vm.runInContext('globalThis.input=JSON.parse(data);input.doc.shared=input.shared', context);
  assert.equal(api.resolveStudioSharedDoc(context.input.doc).layout.items[0].caption, 'Red-haired traveler.\n\nHolding a cup.');
  assert.equal(api.sharedSnapshot(context.input.profile).series_id, SERIES);
  assert.equal(api.validateStudioShared(context.input.shared).revision, 1);
});
