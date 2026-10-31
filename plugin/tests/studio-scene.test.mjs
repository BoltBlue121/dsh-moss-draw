import test from 'node:test';
import assert from 'node:assert/strict';
const api = () => import('../src/studio-scene.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const item = (id, bbox, extra = {}) => ({ id, label: 'object', caption: 'test', bbox, body: { z: 1, thickness: 0, yaw: 0, anchor: 'world' }, ...extra });
const layout = (items = [item('a', [100, 100, 400, 400])]) => ({ width: 1000, height: 1000, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: { caption: 'Scene' }, items });
const doc = () => ({ kind: 'layout', layout: layout(), caption: { caption: 'Other mode' } });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const finiteTree = value => { if (typeof value === 'number') assert.ok(Number.isFinite(value)); else if (value && typeof value === 'object') Object.values(value).forEach(finiteTree); };

test('scene summary is deterministic detached geometry, excludes hidden, and preserves source', async () => {
  const { studioSceneSummary } = await api(); assert.equal(typeof studioSceneSummary, 'function');
  const input = freeze(layout([item('a', [100, 100, 400, 400]), item('hidden', [100, 100, 500, 500], { hidden: true })]));
  const before = JSON.stringify(input), result = studioSceneSummary(input);
  assert.deepEqual(result.items.map(i => i.id), ['a']);
  assert.deepEqual(result, studioSceneSummary(input));
  assert.deepEqual(result.items[0].position, { horizontal: 'left', vertical: 'top' });
  assert.deepEqual(result.items[0].size, { width: 0.3, height: 0.3, area: 0.09 });
  result.items[0].bbox[0] = 999;
  assert.equal(JSON.stringify(input), before);
  assert.equal(studioSceneSummary(input).items[0].bbox[0], 100);
  finiteTree(result);
});

test('summary matches effective camera projection and distinguishes partial/offscreen state', async () => {
  const { studioSceneSummary } = await api(); assert.equal(typeof studioSceneSummary, 'function');
  const input = layout([item('cut', [-100, 100, 100, 300]), item('outside', [1100, 100, 1300, 300])]);
  const result = studioSceneSummary(input), [cut, outside] = result.items;
  assert.equal(cut.visible, true); assert.equal(cut.partial, true); assert.equal(cut.outside, false);
  assert.deepEqual(cut.raw, [-100, 100, 100, 300]); assert.deepEqual(cut.bbox, [0, 100, 100, 300]);
  assert.equal(outside.visible, false); assert.equal(outside.outside, true);
  assert.ok(result.warnings.some(w => w.code === 'STUDIO_SCENE_OUTSIDE' && w.item_id === 'outside'));
  assert.deepEqual(result.relations, []);
  const zoomed = studioSceneSummary({ ...layout(), camera: { enabled: true, distance: 2 } });
  assert.deepEqual(zoomed.items[0].raw, [300, 300, 450, 450]);
});

test('relations report bbox-only overlap and world depth, not exact object occlusion', async () => {
  const { studioSceneSummary } = await api(); assert.equal(typeof studioSceneSummary, 'function');
  const input = layout([item('front', [100, 100, 400, 400]), item('back', [250, 250, 550, 550], { body: { z: 2, thickness: 0, yaw: 0, anchor: 'world' } }), item('hidden', [100, 100, 400, 400], { hidden: true })]);
  const result = studioSceneSummary(input);
  const overlap = result.relations.find(r => r.type === 'bbox-overlap');
  assert.deepEqual(overlap, { type: 'bbox-overlap', a: 'front', b: 'back', overlap_bbox: [250, 250, 400, 400], intersection_area: 22500 });
  assert.ok(result.relations.some(r => r.type === 'nearer-than' && r.a === 'front' && r.b === 'back'));
  assert.equal(result.approximation.basis, 'projected-bbox-and-blockout-depth');
  assert.equal(result.approximation.exact_occlusion, false);
  assert.equal(result.approximation.truncated, false);
});

test('separate boxes express only nearer-than proxy depth, never front/behind occlusion', async () => {
  const { studioSceneSummary } = await api();
  const result = studioSceneSummary(layout([item('near', [100, 100, 300, 300]), item('far', [700, 100, 900, 300], { body: { z: 2, thickness: 0, yaw: 0, anchor: 'world' } })]));
  assert.ok(result.relations.some(r => r.type === 'nearer-than' && r.a === 'near' && r.b === 'far'));
  assert.ok(result.relations.every(r => r.type !== 'in-front-of' && r.type !== 'bbox-overlap'));
});

test('screen and backdrop anchors never invent real world depth order', async () => {
  const { studioSceneSummary } = await api(); assert.equal(typeof studioSceneSummary, 'function');
  const result = studioSceneSummary(layout([item('world', [100, 100, 400, 400]), item('screen', [100, 100, 400, 400], { body: { z: 20, thickness: 0, yaw: 0, anchor: 'screen' } }), item('backdrop', [100, 100, 400, 400], { body: { z: 30, thickness: 0, yaw: 0, anchor: 'backdrop' } })]));
  for (const i of result.items.filter(i => i.anchor !== 'world')) assert.equal(i.depth, null);
  assert.ok(result.relations.every(r => r.type !== 'nearer-than'));
  assert.equal(result.relations.filter(r => r.type === 'bbox-overlap').length, 3);
});

test('relations and warnings are bounded deterministically for 128 overlapping items', async () => {
  const { studioSceneSummary } = await api(); assert.equal(typeof studioSceneSummary, 'function');
  const input = layout(Array.from({ length: 128 }, (_, i) => item('i' + i, [100, 100, 400, 400])));
  const result = studioSceneSummary(input);
  assert.equal(result.items.length, 128); assert.equal(result.relations.length, 64);
  assert.equal(result.approximation.truncated, true);
  assert.ok(result.warnings.some(w => w.code === 'STUDIO_SCENE_RELATIONS_TRUNCATED'));
  assert.deepEqual(result, studioSceneSummary(input));
  assert.ok(JSON.stringify(result).length < 100000);
});

test('invalid or nonfinite geometry is rejected and behind-camera summary remains finite', async () => {
  const { studioSceneSummary } = await api(); assert.equal(typeof studioSceneSummary, 'function');
  for (const input of [{ ...layout(), width: Infinity }, layout([item('bad', [0, 0, NaN, 1])]), { ...layout(), camera: { fov: 0 } }]) {
    assert.throws(() => studioSceneSummary(input), e => e.code === 'STUDIO_INVALID_INPUT');
  }
  const behind = studioSceneSummary({ ...layout(), camera: { enabled: true, pan_z: 10 } });
  assert.equal(behind.items[0].visible, false); finiteTree(behind);
});

test('geometry key ignores captions names shared and object property insertion order', async () => {
  const { studioGeometryKey } = await api(); assert.equal(typeof studioGeometryKey, 'function');
  const before = freeze(doc()), after = structuredClone(before);
  after.layout.items[0].caption = 'Different action'; after.layout.items[0].name = 'Renamed';
  after.layout.summary.caption = 'Different scene'; after.caption.caption = 'Different caption';
  after.shared = { style: 'Changed style', bindings: [] };
  const key = studioGeometryKey(before);
  assert.equal(studioGeometryKey(after), key); assert.equal(typeof key, 'string');
  const reversed = value => Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)])) : value;
  assert.equal(studioGeometryKey(reversed(before)), key);
});

test('geometry key includes dimensions camera perspective identity order bbox body hidden depth and inference label', async () => {
  const { studioGeometryKey } = await api(); assert.equal(typeof studioGeometryKey, 'function');
  const source = doc(); source.layout.items.push(item('b', [500, 100, 700, 400]));
  const baseline = studioGeometryKey(source);
  const changes = [d => d.layout.width++, d => d.layout.height++, d => d.kind = 'caption', d => d.layout.camera = { orbit: 20 },
    d => d.layout.perspective = { horizon_y: 300 }, d => d.layout.items.reverse(), d => d.layout.items[0].id = 'new',
    d => d.layout.items[0].bbox[0]++, d => d.layout.items[0].body.z++, d => d.layout.items[0].hidden = true,
    d => d.layout.items[0].depth = 'bg', d => d.layout.items[0].label = 'text'];
  for (const change of changes) { const next = structuredClone(source); change(next); assert.notEqual(studioGeometryKey(next), baseline); }
  const bad = doc(); bad.layout.camera = { orbit: NaN };
  assert.throws(() => studioGeometryKey(bad), e => e.code === 'STUDIO_INVALID_INPUT');
});
