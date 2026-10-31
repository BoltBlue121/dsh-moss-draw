import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  STUDIO_CAMERA_DEFAULTS, STUDIO_CUBE_EDGES, studioCameraMoved, studioBody,
  estimateStudioBodies, projectStudioLayout, rebaseStudioCamera,
  frameStudioCamera, moveStudioItems, studioCameraText,
} from '../src/studio-camera.mjs';

const box = (id = 'a', bbox = [384, 384, 640, 640], extra = {}) => ({
  id, label: 'object', caption: 'A cube', bbox,
  body: { z: 1, thickness: 0, yaw: 0, anchor: 'world' }, ...extra,
});
const layout = (items = [box()], camera = {}) => ({
  width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
  summary: { caption: 'A scene' }, items, camera: { enabled: true, ...camera },
});
const close = (actual, expected, epsilon = 1e-7) => {
  if (Array.isArray(expected)) {
    assert.equal(actual.length, expected.length);
    actual.forEach((value, index) => close(value, expected[index], epsilon));
  } else assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} != ${expected} ±${epsilon}`);
};
const center = (bounds) => [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2];
function finiteJSON(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), `nonfinite: ${value}`);
  else if (value && typeof value === 'object') Object.values(value).forEach(finiteJSON);
  assert.doesNotThrow(() => JSON.stringify(value));
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}
const errorCode = (code) => (error) => error.code === code;

test('base and disabled cameras preserve arbitrary bodies and the original document', () => {
  for (const enabled of [false, true]) for (const yaw of [-180, -90, -37, 0, 63, 90, 180]) {
    for (const thickness of [0, 0.3, 3]) {
      const input = freeze(layout([box('a', [117.25, 93.5, 812.75, 921], {
        body: { z: 0.15, thickness, yaw, anchor: 'world' },
      })], { enabled, ...(enabled ? {} : { orbit: 60, distance: 0.2 }) }));
      const snapshot = JSON.stringify(input);
      const projected = projectStudioLayout(input);
      close(projected.items.a.raw, [117.25, 93.5, 812.75, 921]);
      close(projected.items.a.bbox, [117.25, 93.5, 812.75, 921]);
      assert.equal(projected.items.a.visible, true);
      assert.equal(studioCameraMoved(input), false);
      assert.equal(JSON.stringify(input), snapshot);
      finiteJSON(projected);
    }
  }
});

test('cube edges form the twelve unique edges over eight corner indices', () => {
  assert.equal(STUDIO_CUBE_EDGES.length, 12);
  const degrees = Array(8).fill(0);
  const edges = new Set();
  for (const [a, b] of STUDIO_CUBE_EDGES) {
    assert.ok(a !== b && a >= 0 && b < 8);
    degrees[a]++; degrees[b]++;
    edges.add([a, b].sort().join(','));
  }
  assert.equal(edges.size, 12);
  assert.deepEqual(degrees, Array(8).fill(3));
});

test('distance and vertical FOV use the 50 degree identity camera, not legacy distance five', () => {
  close(projectStudioLayout(layout(undefined, { distance: 2 })).items.a.raw, [448, 448, 576, 576]);
  const scale = Math.tan(25 * Math.PI / 180) / Math.tan(50 * Math.PI / 180);
  close(projectStudioLayout(layout(undefined, { fov: 100 })).items.a.raw,
    [512 - 128 * scale, 512 - 128 * scale, 512 + 128 * scale, 512 + 128 * scale]);
  const wide = { ...layout(undefined, { distance: 2 }), width: 2048 };
  close(projectStudioLayout(wide).items.a.raw, [704, 448, 832, 576]);
});

test('positive camera pan moves the scene left/up; positive pan-z moves it closer', () => {
  const focal = 512 / Math.tan(25 * Math.PI / 180);
  close(center(projectStudioLayout(layout(undefined, { pan_x: 0.1, pan_y: 0.2 })).items.a.raw),
    [512 - 0.1 * focal, 512 - 0.2 * focal]);
  close(projectStudioLayout(layout(undefined, { pan_z: 0.5 })).items.a.raw, [256, 256, 768, 768]);
});

test('orbit creates signed near/far parallax around the largest visible character pivot', () => {
  const input = layout([
    box('pivot', [256, 256, 768, 768], { label: 'character' }),
    box('near', [480, 480, 544, 544], { body: { z: 0.5, thickness: 0, yaw: 0, anchor: 'world' } }),
    box('far', [480, 480, 544, 544], { body: { z: 2, thickness: 0, yaw: 0, anchor: 'world' } }),
    box('hidden', [0, 0, 1024, 1024], { label: 'character', hidden: true, body: { z: 9, thickness: 0, yaw: 0, anchor: 'world' } }),
  ], { orbit: 30 });
  const result = projectStudioLayout(input);
  assert.ok(center(result.items.near.raw)[0] < 512);
  assert.ok(center(result.items.far.raw)[0] > 512);
  close(result.items.pivot.depth, 1);
  close(result.items.near.depth, 1 - Math.cos(Math.PI / 6) * 0.5);
  close(result.items.far.depth, 1 + Math.cos(Math.PI / 6));
});

test('pitch has y-down parallax and roll rotates the image counterclockwise', () => {
  const input = layout([
    box('pivot', [256, 256, 768, 768], { label: 'character' }),
    box('near', [480, 480, 544, 544], { body: { z: 0.5, thickness: 0, yaw: 0, anchor: 'world' } }),
  ], { pitch: 30 });
  assert.ok(center(projectStudioLayout(input).items.near.raw)[1] > 512);
  const rolled = projectStudioLayout(layout([box('a', [600, 400, 700, 500])], { roll: 90 }));
  close(rolled.items.a.raw, [400, 324, 500, 424]);
  finiteJSON(rolled.horizon);
});

test('text, explicit screen and covering backdrop retain fixed pixel boxes', () => {
  const input = layout([
    box('screen', [10, 10, 120, 120], { body: { z: 1, thickness: 2, yaw: 70, anchor: 'screen' } }),
    { id: 'text', label: 'text', caption: 'title', text: 'Title', bbox: [50, 50, 400, 100] },
    { id: 'bg', label: 'object', caption: 'sky', bbox: [0, 0, 1024, 1024] },
  ], { orbit: 80, pitch: 60, pan_x: 2, fov: 10 });
  const result = projectStudioLayout(input);
  for (const item of input.items) close(result.items[item.id].raw, item.bbox);
  assert.equal(result.items.text.anchor, 'screen');
  assert.equal(result.items.bg.anchor, 'backdrop');
  assert.deepEqual(result.order, ['bg', 'screen', 'text']);
});

test('body estimation is detached, respects explicit bodies and locked content', () => {
  const missing = { id: 'new', label: 'character', caption: 'person', bbox: [400, 100, 624, 900] };
  const input = freeze(layout([box(), missing, { ...missing, id: 'locked', locked: true }]));
  const estimate = estimateStudioBodies(input);
  assert.deepEqual(estimate.items[0], input.items[0]);
  assert.equal(estimate.items[1].body.anchor, 'world');
  assert.ok(estimate.items[1].body.z > 0 && estimate.items[1].body.z < 2);
  assert.deepEqual(estimate.items[2], input.items[2]);
  assert.notEqual(estimate, input);
  assert.notEqual(estimate.items[0], input.items[0]);
  assert.equal(studioBody({ ...missing, depth: 'bg' }, input).z, 2.5);
  assert.notDeepEqual(estimateStudioBodies(input, { onlyMissing: false }).items[0].body, input.items[0].body);
});

test('raw bounds are separate from clipped compiler bounds and visibility thresholds', () => {
  const result = projectStudioLayout(layout([
    box('part', [-100, 100, 100, 300]), box('tiny', [1020, 100, 1100, 300]),
    box('off', [1200, 100, 1400, 300]), box('hidden', [100, 100, 300, 300], { hidden: true }),
    box('thinFraction', [-1000, 400, 10, 500]),
  ]));
  close(result.items.part.raw, [-100, 100, 100, 300]);
  close(result.items.part.bbox, [0, 100, 100, 300]);
  assert.equal(result.items.part.visible, true);
  assert.equal(result.items.part.partial, true);
  for (const id of ['tiny', 'off', 'hidden', 'thinFraction']) assert.equal(result.items[id].visible, false);
});

test('near-plane crossings produce null corners but finite raw bounds; fully behind is invisible', () => {
  const partial = projectStudioLayout(layout([box('a', [400, 400, 624, 624], {
    body: { z: 1, thickness: 1, yaw: 0, anchor: 'world' },
  })], { pan_z: 0.95 }));
  assert.equal(partial.items.a.partial, true);
  assert.ok(partial.items.a.corners.some((point) => point === null));
  finiteJSON(partial);
  const behind = projectStudioLayout(layout(undefined, { pan_z: 2 }));
  assert.equal(behind.items.a.visible, false);
  assert.ok(behind.items.a.corners.every((point) => point === null));
  finiteJSON(behind);
});

test('prototype-sensitive ids remain ordinary records, including JSON serialization', () => {
  const result = projectStudioLayout(layout([box('__proto__'), box('constructor')]));
  assert.equal(Object.getPrototypeOf(result.items), null);
  assert.equal(result.items.__proto__.id, '__proto__');
  assert.equal(JSON.parse(JSON.stringify(result)).items.__proto__.id, '__proto__');
});

test('base layer order is preserved; moved layers use anchor bands and 12 percent world hysteresis', () => {
  const entries = [
    box('screen', undefined, { body: { z: 1, thickness: 0, yaw: 0, anchor: 'screen' } }),
    box('front', undefined, { body: { z: 1, thickness: 0, yaw: 0, anchor: 'world' } }),
    box('close', undefined, { body: { z: 1.05, thickness: 0, yaw: 0, anchor: 'world' } }),
    box('far', undefined, { body: { z: 3, thickness: 0, yaw: 0, anchor: 'world' } }),
    box('bg', undefined, { body: { z: 3, thickness: 0, yaw: 0, anchor: 'backdrop' } }),
  ];
  assert.deepEqual(projectStudioLayout(layout(entries)).order, entries.map((entry) => entry.id));
  assert.deepEqual(projectStudioLayout(layout(entries, { pan_x: 0.01 })).order,
    ['bg', 'far', 'front', 'close', 'screen']);
});

test('rebase bakes clipped boxes, preserves hidden items and resets to enabled identity', () => {
  const input = freeze(layout([box(), box('off', [3000, 384, 3256, 640]), box('hidden', undefined, { hidden: true })], { distance: 2 }));
  const rebased = rebaseStudioCamera(input);
  close(rebased.items[0].bbox, [448, 448, 576, 576]);
  assert.equal(rebased.items.find((item) => item.id === 'off').hidden, true);
  assert.equal(rebased.items.find((item) => item.id === 'hidden').hidden, true);
  assert.equal(rebased.items.length, 3);
  assert.deepEqual(rebased.camera, { ...STUDIO_CAMERA_DEFAULTS, enabled: true });
  close(projectStudioLayout(rebased).items.a.raw, [448, 448, 576, 576]);
  assert.equal(input.camera.distance, 2);
});

test('rebase refuses to modify or reorder locked items atomically', () => {
  const input = freeze(layout([box('a', undefined, { locked: true })], { distance: 2 }));
  assert.throws(() => rebaseStudioCamera(input), errorCode('STUDIO_LOCKED'));
  assert.doesNotThrow(() => rebaseStudioCamera(layout([box('a', undefined, { locked: true })])));
});

test('frame brings an out-of-frame world subject back with padding and preserves user angles', () => {
  const input = freeze(layout([box('a', [1600, 300, 1900, 700])], { orbit: 8, pitch: 3, roll: 4, fov: 55 }));
  assert.equal(projectStudioLayout(input).items.a.visible, false);
  const framed = frameStudioCamera(input, ['a']);
  assert.deepEqual(framed, frameStudioCamera(input, ['a']));
  for (const key of ['orbit', 'pitch', 'roll', 'fov']) assert.equal(framed.camera[key], input.camera[key]);
  const projected = projectStudioLayout(framed).items.a;
  assert.equal(projected.visible, true);
  assert.ok(projected.raw[0] >= 25 && projected.raw[1] >= 25 && projected.raw[2] <= 999 && projected.raw[3] <= 999);
  assert.ok(framed.camera.distance >= 0.2 && framed.camera.distance <= 5);
  assert.ok(Math.abs(framed.camera.pan_x) <= 3 && Math.abs(framed.camera.pan_y) <= 3);
  assert.throws(() => frameStudioCamera(layout([box('a', [15000, 15000, 16000, 16000])]), ['a']),
    errorCode('STUDIO_FRAME_UNAVAILABLE'));
});

test('frame searches new bounded pan seeds when every distance at the initial pan is behind', () => {
  const input = freeze(layout([box('a', [3100, 412, 3300, 612])], { orbit: 75, distance: 1, pan_x: -3 }));
  const knownValid = projectStudioLayout({ ...input, camera: { ...input.camera, distance: 0.2, pan_x: 2.65 } }).items.a;
  assert.equal(knownValid.visible, true);
  close(knownValid.raw, [339.6246, 186.3025, 409.4387, 837.6975], 0.0001);
  assert.ok(knownValid.raw[0] >= 40 && knownValid.raw[2] <= 984 && knownValid.raw[1] >= 40 && knownValid.raw[3] <= 984);
  assert.equal(projectStudioLayout(input).items.a.visible, false);
  const framed = frameStudioCamera(input, ['a']);
  assert.deepEqual(framed, frameStudioCamera(input, ['a']));
  const view = projectStudioLayout(framed).items.a;
  assert.equal(view.visible, true);
  assert.equal(view.partial, false);
  assert.ok(view.raw[0] >= 40 && view.raw[2] <= 984 && view.raw[1] >= 40 && view.raw[3] <= 984);
  assert.ok(framed.camera.distance >= 0.2 && framed.camera.distance <= 5);
  assert.ok(Math.abs(framed.camera.pan_x) <= 3 && Math.abs(framed.camera.pan_y) <= 3);
  assert.equal(framed.camera.orbit, 75);
});

test('screen drag inverts moved-camera projection and has an accurate roundtrip', () => {
  const input = freeze(layout([box('a', [280, 300, 500, 700], {
    body: { z: 1.2, thickness: 0.4, yaw: 33, anchor: 'world' },
  })], { orbit: 22, pitch: -12, roll: 8, distance: 1.3, pan_x: 0.05 }));
  const before = center(projectStudioLayout(input).items.a.raw);
  const moved = moveStudioItems(input, ['a'], 47, -29);
  close(center(projectStudioLayout(moved).items.a.raw), [before[0] + 47, before[1] - 29], 0.02);
  const restored = moveStudioItems(moved, ['a'], -47, 29);
  close(restored.items[0].bbox, input.items[0].bbox, 0.05);
});

test('drag across the pivot visibility threshold preserves the physical camera and supports a roundtrip', () => {
  const input = freeze(layout([
    box('a', [-190, 300, 10, 700], { label: 'character' }),
    box('b', [400, 400, 600, 600], { locked: true, body: { z: 2, thickness: 0, yaw: 0, anchor: 'world' } }),
  ], { distance: 2 }));
  const before = projectStudioLayout(input);
  close(before.items.a.raw, [161, 406, 261, 606]);
  const moved = moveStudioItems(input, ['a'], -5, 0);
  const projected = projectStudioLayout(moved);
  close(projected.items.a.raw, [156, 406, 256, 606], 0.005);
  close(projected.items.b.raw, before.items.b.raw, 1e-8);
  assert.deepEqual(moved.items[1], input.items[1]);
  close(moved.camera.distance, 1);
  close(moved.camera.pan_z, -0.5);
  const restored = moveStudioItems(moved, ['a'], 5, 0);
  close(restored.items[0].bbox, input.items[0].bbox, 0.02);
  close(projectStudioLayout(restored).items.a.raw, before.items.a.raw, 0.005);
  close(projectStudioLayout(restored).items.b.raw, before.items.b.raw, 1e-8);
  close(restored.camera.distance, 2);
  close(restored.camera.pan_z, 0);
  assert.equal(input.camera.pan_z, undefined);
});

test('oblique drag keeps unselected projections stable across a pivot change without new fields', () => {
  const input = freeze(layout([
    box('a', [-190, 300, 10, 700], { label: 'character' }),
    box('b', [400, 400, 600, 600], { body: { z: 2, thickness: 0.4, yaw: 25, anchor: 'world' } }),
  ], { distance: 2, orbit: 20, pitch: 10, roll: 5, pan_x: 0.1, pan_y: -0.1, pan_z: 0.2 }));
  const before = projectStudioLayout(input);
  const moved = moveStudioItems(input, ['a'], -20, 7);
  const projected = projectStudioLayout(moved);
  close(center(projected.items.a.raw), [center(before.items.a.raw)[0] - 20, center(before.items.a.raw)[1] + 7], 0.005);
  close(projected.items.b.raw, before.items.b.raw, 1e-8);
  assert.ok(moved.items[0].bbox[2] < 6, 'fixture must actually change the inferred pivot');
  assert.deepEqual(Object.keys(moved).sort(), Object.keys(input).sort());
  assert.ok(Object.keys(moved.camera).every((key) => Object.hasOwn(STUDIO_CAMERA_DEFAULTS, key)));
  for (const key of ['orbit', 'pitch', 'roll', 'fov']) close(moved.camera[key], { ...STUDIO_CAMERA_DEFAULTS, ...input.camera }[key]);
  const restored = moveStudioItems(moved, ['a'], 20, -7);
  close(restored.items[0].bbox, input.items[0].bbox, 0.03);
  close(projectStudioLayout(restored).items.b.raw, before.items.b.raw, 1e-8);
});

test('pivot compensation uses equivalent bounded parameters instead of invalid distance values', () => {
  const input = freeze(layout([
    box('a', [-190, 300, 10, 700], { label: 'character', body: { z: 1.5, thickness: 0, yaw: 0, anchor: 'world' } }),
    box('b', [400, 400, 600, 600], { body: { z: 0.01, thickness: 0, yaw: 0, anchor: 'world' } }),
  ], { distance: 1.5 }));
  const before = projectStudioLayout(input);
  const moved = moveStudioItems(input, ['a'], -5, 0);
  const after = projectStudioLayout(moved);
  close(center(after.items.a.raw), [center(before.items.a.raw)[0] - 5, center(before.items.a.raw)[1]], 0.005);
  close(after.items.b.raw, before.items.b.raw, 1e-8);
  assert.ok(moved.camera.distance >= 0.01 && moved.camera.distance <= 100);
  for (const key of ['pan_x', 'pan_y', 'pan_z']) assert.ok(Math.abs(moved.camera[key]) <= 100);
  const restored = moveStudioItems(moved, ['a'], 5, 0);
  close(restored.items[0].bbox, input.items[0].bbox, 0.02);
  close(projectStudioLayout(restored).items.b.raw, before.items.b.raw, 1e-8);
});

test('base and disabled camera records need no pivot compensation during a drag', () => {
  for (const camera of [{ enabled: true }, { enabled: false, orbit: 30, distance: 2 }]) {
    const input = layout([box('a', [-190, 300, 10, 700], { label: 'character' }),
      box('b', [400, 400, 600, 600], { body: { z: 2, thickness: 0, yaw: 0, anchor: 'world' } })], camera);
    const moved = moveStudioItems(input, ['a'], -5, 0);
    close(moved.items[0].bbox, [-195, 300, 5, 700], 0.005);
    assert.deepEqual(moved.camera, input.camera);
    close(projectStudioLayout(moved).items.b.raw, [400, 400, 600, 600]);
  }
});

test('move expands groups, honors individual mode, ignores anchors and freezes all world estimates', () => {
  const missing = { id: 'other', label: 'object', caption: 'other', bbox: [100, 100, 200, 200] };
  const input = freeze(layout([box('a', undefined, { group: 'g' }), box('b', [100, 100, 200, 200], { group: 'g' }),
    box('screen', undefined, { body: { z: 1, thickness: 0, yaw: 0, anchor: 'screen' } }), missing]));
  const moved = moveStudioItems(input, ['a', 'screen'], 30, 20, { freeze: true });
  close(moved.items[0].bbox, [414, 404, 670, 660]);
  close(moved.items[1].bbox, [130, 120, 230, 220]);
  assert.deepEqual(moved.items[2], input.items[2]);
  assert.equal(moved.items[3].body.anchor, 'world');
  // Freeze translates every movable world by one shared world displacement, not equal pixels.
  close((moved.items[3].bbox[0] - 100) * moved.items[3].body.z, 30);
  close((moved.items[3].bbox[1] - 100) * moved.items[3].body.z, 20);
  const single = moveStudioItems(input, ['a'], 30, 20, { individual: true });
  assert.deepEqual(single.items[1], input.items[1]);
  assert.equal(input.items[3].body, undefined);
});

test('locked groups and unavailable drag fail without mutation', () => {
  const input = freeze(layout([box('a', undefined, { group: 'g' }), box('b', undefined, { group: 'g', locked: true })]));
  assert.throws(() => moveStudioItems(input, ['a'], 20, 10), errorCode('STUDIO_LOCKED'));
  assert.throws(() => moveStudioItems(layout(undefined, { pan_z: 2 }), ['a'], 20, 10), errorCode('STUDIO_MOVE_UNAVAILABLE'));
});

test('finite extremes stay JSON safe and malformed numeric input is rejected instead of coerced', () => {
  for (const camera of [
    { orbit: 180, pitch: 85, roll: 60, distance: 0.2, fov: 10, pan_x: 3, pan_y: -3, pan_z: -0.9 },
    { orbit: -180, pitch: -85, roll: -60, distance: 5, fov: 120, pan_x: -3, pan_y: 3, pan_z: 3 },
    { orbit: 90, pitch: 0, roll: 90, distance: 0.01, pan_z: 100 },
  ]) finiteJSON(projectStudioLayout(layout([box('a', [-16000, -15000, 16000, 15000], {
    body: { z: 100, thickness: 10, yaw: 179, anchor: 'world' },
  })], camera)));
  for (const value of [NaN, Infinity, -Infinity, '1']) {
    assert.throws(() => projectStudioLayout(layout(undefined, { distance: value })), errorCode('STUDIO_INVALID_INPUT'));
    assert.throws(() => moveStudioItems(layout(), ['a'], value, 0), errorCode('STUDIO_INVALID_INPUT'));
  }
  assert.throws(() => projectStudioLayout({ ...layout(), width: Infinity }), errorCode('STUDIO_INVALID_INPUT'));
});

test('rebase identity preserves locked fractional coordinates without quantization', () => {
  const input = freeze(layout([box('a', [123.123456789123, 234.234567891234, 456.456789123456, 678.678912345678], { locked: true })]));
  assert.deepEqual(rebaseStudioCamera(input).items[0], input.items[0]);
});

test('group drag preserves relative world positions at different depths', () => {
  const input = layout([box('a', [300, 300, 500, 500], { group: 'g' }),
    box('b', [600, 300, 700, 400], { group: 'g', body: { z: 2, thickness: 0, yaw: 0, anchor: 'world' } })]);
  const moved = moveStudioItems(input, ['a'], 60, 30);
  close(moved.items[0].bbox, [360, 330, 560, 530]);
  close(moved.items[1].bbox, [630, 315, 730, 415]);
});

test('freeze skips locked worlds and the complete locked group while moving other worlds', () => {
  const input = freeze(layout([box('a'), box('b', undefined, { group: 'locked-group' }),
    box('c', undefined, { group: 'locked-group', locked: true }), box('d', undefined, { locked: true })]));
  const moved = moveStudioItems(input, ['a'], 20, 40, { freeze: true });
  close(moved.items[0].bbox, [404, 424, 660, 680]);
  for (let i = 1; i < 4; i++) assert.deepEqual(moved.items[i], input.items[i]);
});

test('singular edge-on baseline is explicit unsupported when moved, not a distorted success', () => {
  const input = layout([box('a', undefined, { body: { z: 1, thickness: 0, yaw: 90, anchor: 'world' } })]);
  close(projectStudioLayout(input).items.a.raw, [384, 384, 640, 640]);
  assert.throws(() => projectStudioLayout({ ...input, camera: { enabled: true, orbit: 20 } }), errorCode('STUDIO_CAMERA_DEGENERATE'));
});

test('frame search respects the exact upper distance bound for oversized subjects', () => {
  const framed = frameStudioCamera(layout([box('a', [-1688, -1688, 2712, 2712])]), ['a']);
  assert.ok(framed.camera.distance <= 5, `distance ${framed.camera.distance} exceeds five`);
  assert.equal(projectStudioLayout(framed).items.a.visible, true);
});

test('baseline near-plane crossing is partial even while identity bounds are preserved', () => {
  const input = layout([box('a', [100, 100, 924, 924], { body: { z: 0.15, thickness: 3, yaw: 0, anchor: 'world' } })]);
  const view = projectStudioLayout(input).items.a;
  close(view.raw, [100, 100, 924, 924]);
  assert.equal(view.partial, true);
  assert.ok(view.corners.some((point) => point === null));
});

test('nonfinite inferred depth is rejected rather than concealed by a clamp', () => {
  const item = { id: 'a', label: 'object', caption: 'subnormal height', bbox: [0, 0, 1, Number.MIN_VALUE] };
  assert.throws(() => projectStudioLayout(layout([item])), errorCode('STUDIO_CAMERA_NUMERIC'));
});

test('hidden singular bodies do not block projecting visible world items', () => {
  const input = layout([box('a'), box('hidden', undefined, {
    hidden: true, body: { z: 1, thickness: 0, yaw: 90, anchor: 'world' },
  })], { distance: 2 });
  const projected = projectStudioLayout(input);
  close(projected.items.a.raw, [448, 448, 576, 576]);
  assert.equal(projected.items.hidden.visible, false);
  assert.equal(projected.items.hidden.corners, null);
  finiteJSON(projected);
});

test('explicit text body anchors override the default screen inference without rewriting fields', () => {
  const world = box('world-text', undefined, { label: 'text', text: 'World title' });
  const screen = { id: 'default-text', label: 'text', caption: 'Title', text: 'Screen title', bbox: [384, 384, 640, 640] };
  const input = freeze(layout([world, screen], { distance: 2 }));
  assert.deepEqual(studioBody(world, input), world.body);
  const result = projectStudioLayout(input);
  close(result.items['world-text'].raw, [448, 448, 576, 576]);
  close(result.items['default-text'].raw, [384, 384, 640, 640]);
});

test('frame recovers a behind-camera subject when bounded distance permits, otherwise explicitly fails', () => {
  const pivot = box('pivot', [256, 256, 768, 768], { label: 'character' });
  const far = box('far', [416, 416, 608, 608], { body: { z: 3, thickness: 0, yaw: 0, anchor: 'world' } });
  const input = freeze(layout([pivot, far], { orbit: 180 }));
  assert.equal(projectStudioLayout(input).items.far.visible, false);
  const framed = frameStudioCamera(input, ['far']);
  assert.equal(framed.camera.orbit, 180);
  assert.equal(projectStudioLayout(framed).items.far.visible, true);
  const impossible = layout([pivot, { ...far, body: { ...far.body, z: 100 } }], { orbit: 180 });
  assert.throws(() => frameStudioCamera(impossible, ['far']), errorCode('STUDIO_FRAME_UNAVAILABLE'));
});

test('pure camera math executes without Node globals or a domain module in a browser-like realm', async () => {
  const source = await readFile(new URL('../src/studio-camera.mjs', import.meta.url), 'utf8');
  const context = vm.createContext({ TextEncoder, input: JSON.parse(JSON.stringify(layout(undefined, { distance: 2 }))) });
  const result = vm.runInContext(`${source.replace(/export /g, '')}\nJSON.stringify(projectStudioLayout(input));`, context);
  close(JSON.parse(result).items.a.raw, [448, 448, 576, 576]);
  assert.equal(vm.runInContext('typeof process + ":" + typeof require', context), 'undefined:undefined');
});

test('128-item numerical sweeps remain finite and camera actions preserve original documents', () => {
  const entries = Array.from({ length: 128 }, (_, i) => box(`item-${i}`, [32 + (i % 8) * 110, 40 + Math.floor(i / 8) * 52,
    112 + (i % 8) * 110, 88 + Math.floor(i / 8) * 52], {
    body: { z: 0.15 + (i % 12), thickness: 0.1 + (i % 4) * 0.9, yaw: (i * 37) % 360 - 180, anchor: 'world' },
  }));
  for (const orbit of [-180, -90, -45, 0, 45, 90, 180]) {
    const input = freeze(layout(entries, { orbit, pitch: 30, roll: -15, distance: 0.2, fov: 120 }));
    const snapshot = JSON.stringify(input);
    const projected = projectStudioLayout(input);
    assert.equal(projected.order.length, 128);
    finiteJSON(projected);
    assert.equal(JSON.stringify(input), snapshot);
  }
  assert.throws(() => projectStudioLayout(layout([...entries, box('129')])), errorCode('STUDIO_INVALID_INPUT'));
});

test('camera text is bounded English assistance, not a reconstruction or geometry guarantee', () => {
  assert.equal(studioCameraText(layout(undefined, { enabled: false, orbit: 30 })), '');
  const text = studioCameraText(layout(undefined, { orbit: 30, pitch: 20, distance: 0.5, fov: 90 }));
  assert.match(text, /camera|view|angle/i);
  assert.ok(text.length < 400);
  assert.doesNotMatch(text, /guarantee|reconstruct|faithful/i);
});
