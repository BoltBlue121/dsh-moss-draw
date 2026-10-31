import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STUDIO_CAMERA_DEFAULTS,
  projectStudioLayout,
  captureStudioFraming,
  followStudioCamera,
  translateStudioItems,
  moveStudioItems,
} from '../src/studio-camera.mjs';
import { validateStudioDoc } from '../src/studio-domain.mjs';

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
const size = (bounds) => Math.sqrt((bounds[2] - bounds[0]) * (bounds[3] - bounds[1]));
const union = (projected, ids) => {
  const raws = ids.map((id) => projected.items[id].raw);
  return [
    Math.min(...raws.map((r) => r[0])),
    Math.min(...raws.map((r) => r[1])),
    Math.max(...raws.map((r) => r[2])),
    Math.max(...raws.map((r) => r[3])),
  ];
};
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

test('captureStudioFraming selects largest visible character by default, else largest visible world, else largest in-front offscreen world', () => {
  const charScene = freeze(layout([
    box('huge-obj', [100, 100, 900, 900], { label: 'object' }),
    box('small-char', [400, 400, 500, 500], { label: 'character' }),
    box('big-char', [300, 300, 600, 600], { label: 'character' }),
    box('off-char', [2000, 2000, 3000, 3000], { label: 'character' }),
    box('hidden-char', [0, 0, 1024, 1024], { label: 'character', hidden: true }),
  ]));
  const ids = [];
  const framedChar = captureStudioFraming(charScene, ids);
  assert.deepEqual(ids, []);
  assert.deepEqual(framedChar, { ids: ['big-char'], cx: 450, cy: 450, size: 300 });
  finiteJSON(framedChar);

  const worldScene = freeze(layout([
    box('small', [400, 400, 500, 500]),
    box('large', [200, 200, 700, 600]),
    box('off-huge', [2000, 2000, 4000, 4000]),
  ]));
  const framedWorld = captureStudioFraming(worldScene);
  assert.deepEqual(framedWorld, { ids: ['large'], cx: 450, cy: 400, size: Math.sqrt(500 * 400) });

  const offscreenScene = freeze(layout([
    box('off-small', [1500, 200, 1700, 400]),
    box('off-big', [-900, 100, -300, 500]),
    box('screen', [0, 0, 1024, 1024], { body: { z: 1, thickness: 0, yaw: 0, anchor: 'screen' } }),
  ]));
  const framedOff = captureStudioFraming(offscreenScene);
  assert.deepEqual(framedOff, { ids: ['off-big'], cx: -600, cy: 300, size: Math.sqrt(600 * 400) });
});

test('captureStudioFraming measures unclipped raw union, allows locked targets, and rejects hidden/screen/backdrop/unknown/near-plane targets', () => {
  const input = freeze(layout([
    box('left', [-100, 200, 100, 600], { locked: true }),
    box('right', [500, 300, 700, 700], { body: { z: 2, thickness: 0.2, yaw: 15, anchor: 'world' } }),
    box('screen', [0, 0, 100, 100], { body: { z: 1, thickness: 0, yaw: 0, anchor: 'screen' } }),
    box('backdrop', [0, 0, 1024, 1024], { body: { z: 3, thickness: 0, yaw: 0, anchor: 'backdrop' } }),
    box('hidden', [200, 200, 400, 400], { hidden: true }),
  ]));
  const snapshot = JSON.stringify(input);
  const goal = captureStudioFraming(input, ['left', 'right', 'screen']);
  assert.deepEqual(goal.ids, ['left', 'right']);
  close([goal.cx, goal.cy, goal.size], [300, 450, Math.sqrt(800 * 500)]);
  assert.equal(JSON.stringify(input), snapshot);

  assert.throws(() => captureStudioFraming(input, ['unknown']), errorCode('STUDIO_ITEM_NOT_FOUND'));
  assert.throws(() => captureStudioFraming(input, ['screen', 'backdrop']), errorCode('STUDIO_FOLLOW_UNAVAILABLE'));
  assert.throws(() => captureStudioFraming(input, ['hidden']), errorCode('STUDIO_FOLLOW_UNAVAILABLE'));

  // Moved camera makes character visible / changes largest visible world priority
  const movedCamScene = freeze(layout([
    box('off-char', [1500, 300, 1900, 800], { label: 'character', body: { z: 1, thickness: 0, yaw: 0, anchor: 'world' } }),
    box('center-obj', [400, 400, 600, 600], { label: 'object', body: { z: 1, thickness: 0, yaw: 0, anchor: 'world' } }),
  ], { pan_x: 1.1 }));
  assert.equal(projectStudioLayout(movedCamScene).items['off-char'].visible, true);
  assert.deepEqual(captureStudioFraming(movedCamScene).ids, ['off-char']);

  // Singular baseline edge-on target fails with STUDIO_FOLLOW_UNAVAILABLE even when camera is at baseline
  const edgeOnBase = layout([box('a', undefined, { body: { z: 1, thickness: 0, yaw: 90, anchor: 'world' } })]);
  assert.throws(() => captureStudioFraming(edgeOnBase, ['a']), errorCode('STUDIO_FOLLOW_UNAVAILABLE'));
  assert.throws(() => captureStudioFraming(edgeOnBase), errorCode('STUDIO_FOLLOW_UNAVAILABLE'));

  const nearPlane = layout([box('a', [400, 400, 624, 624], { body: { z: 1, thickness: 1, yaw: 0, anchor: 'world' } })], { pan_z: 0.95 });
  assert.throws(() => captureStudioFraming(nearPlane, ['a']), errorCode('STUDIO_FOLLOW_UNAVAILABLE'));
  const behind = layout([box('a')], { pan_z: 2 });
  assert.throws(() => captureStudioFraming(behind, ['a']), errorCode('STUDIO_FOLLOW_UNAVAILABLE'));
});

test('followStudioCamera with keepSize preserves union center and size across orbit, pitch, roll, and FOV changes and roundtrips', () => {
  const input = freeze(layout([
    box('hero', [320, 260, 560, 780], { label: 'character', locked: true, body: { z: 1.1, thickness: 0.3, yaw: 18, anchor: 'world' } }),
    box('prop', [580, 440, 720, 660], { body: { z: 1.6, thickness: 0.25, yaw: -24, anchor: 'world' } }),
    box('bg', [100, 120, 920, 880], { body: { z: 3.2, thickness: 0.2, yaw: 0, anchor: 'world' } }),
  ], { enabled: false }));
  const snapshot = JSON.stringify(input);

  const singleGoal = captureStudioFraming(input, ['hero']);
  const multiGoal = captureStudioFraming(input, ['hero', 'prop']);

  for (const goal of [singleGoal, multiGoal]) {
    for (const patch of [
      { orbit: 28, pitch: -14, roll: 9, fov: 62, pan_z: 0.1 },
      { orbit: -35, pitch: 22, roll: -18, fov: 38 },
      { orbit: 50, pitch: 0, roll: 0, fov: 50 },
    ]) {
      const followed = followStudioCamera(input, patch, goal, { keepSize: true });
      assert.equal(followed.camera.enabled, true);
      for (const [k, v] of Object.entries(patch)) close(followed.camera[k], v, 1e-12);
      assert.deepEqual(followed.items, input.items);
      assert.deepEqual(Object.keys(followed.camera).sort(), Object.keys(STUDIO_CAMERA_DEFAULTS).sort());

      const projected = projectStudioLayout(followed);
      const u = union(projected, goal.ids);
      close(center(u), [goal.cx, goal.cy], 0.05);
      close(size(u), goal.size, Math.max(0.05, goal.size * 0.0001));
      finiteJSON(followed);

      const roundtrip = followStudioCamera(followed, { orbit: 0, pitch: 0, roll: 0, fov: 50, pan_z: 0 }, goal, { keepSize: true });
      const rtUnion = union(projectStudioLayout(roundtrip), goal.ids);
      close(center(rtUnion), [goal.cx, goal.cy], 0.05);
      close(size(rtUnion), goal.size, Math.max(0.05, goal.size * 0.0001));
    }
  }
  assert.equal(JSON.stringify(input), snapshot);
});

test('followStudioCamera with keepSize:false preserves exact distance and solves center only', () => {
  const input = freeze(layout([
    box('hero', [350, 300, 650, 750], { label: 'character', body: { z: 1.2, thickness: 0.25, yaw: 10, anchor: 'world' } }),
  ], { distance: 1.4 }));
  const goal = captureStudioFraming(input, ['hero']);
  const followed = followStudioCamera(input, { orbit: 25, pitch: 12, distance: 2.2, fov: 65 }, goal, { keepSize: false });
  assert.equal(followed.camera.distance, 2.2);
  assert.equal(followed.camera.orbit, 25);
  assert.equal(followed.camera.pitch, 12);
  assert.equal(followed.camera.fov, 65);
  assert.deepEqual(followed.items, input.items);

  const projected = projectStudioLayout(followed);
  const raw = projected.items.hero.raw;
  close(center(raw), [goal.cx, goal.cy], 0.05);
  assert.ok(Math.abs(size(raw) - goal.size) > 10, 'area is allowed to change when keepSize is false');
});

test('followStudioCamera rejects invalid goals/inputs and fails cleanly without partial mutation when unsolvable', () => {
  const input = freeze(layout([box('a', [384, 384, 640, 640], { body: { z: 1, thickness: 0.2, yaw: 0, anchor: 'world' } })]));
  const snapshot = JSON.stringify(input);
  const validGoal = captureStudioFraming(input, ['a']);

  for (const badGoal of [
    null,
    { ...validGoal, cx: NaN },
    { ...validGoal, cy: Infinity },
    { ...validGoal, size: 0 },
    { ...validGoal, size: -10 },
    { ...validGoal, ids: [] },
    { ...validGoal, ids: 'a' },
  ]) {
    assert.throws(() => followStudioCamera(input, { orbit: 10 }, badGoal), errorCode('STUDIO_INVALID_INPUT'));
  }
  assert.throws(() => followStudioCamera(input, { orbit: NaN }, validGoal), errorCode('STUDIO_INVALID_INPUT'));
  assert.throws(() => followStudioCamera(input, { fov: 180 }, validGoal), errorCode('STUDIO_INVALID_INPUT'));
  assert.throws(() => followStudioCamera(input, { distance: -1 }, validGoal), errorCode('STUDIO_INVALID_INPUT'));
  assert.throws(() => followStudioCamera(input, { orbit: 10 }, { ...validGoal, ids: ['missing'] }), errorCode('STUDIO_ITEM_NOT_FOUND'));

  const screenInput = freeze(layout([box('s', [100, 100, 300, 300], { body: { z: 1, thickness: 0, yaw: 0, anchor: 'screen' } })]));
  assert.throws(() => followStudioCamera(screenInput, { orbit: 10 }, { ids: ['s'], cx: 200, cy: 200, size: 200 }), errorCode('STUDIO_FOLLOW_UNAVAILABLE'));

  // Mixed world + screen in followStudioCamera goal rejects unsupported anchor
  const mixedInput = freeze(layout([
    box('w', [384, 384, 640, 640]),
    box('s', [100, 100, 300, 300], { body: { z: 1, thickness: 0, yaw: 0, anchor: 'screen' } }),
  ]));
  assert.throws(() => followStudioCamera(mixedInput, { orbit: 10 }, { ids: ['w', 's'], cx: 300, cy: 300, size: 300 }), errorCode('STUDIO_FOLLOW_UNAVAILABLE'));

  // Largeorbit recovery: 120° orbit where initial pan places target behind camera recovers via seeds
  const offCenter = freeze(layout([
    box('hero', [700, 300, 920, 750], { label: 'character', body: { z: 2.2, thickness: 0.3, yaw: 0, anchor: 'world' } }),
  ]));
  const offGoal = captureStudioFraming(offCenter, ['hero']);
  const recovered = followStudioCamera(offCenter, { orbit: 120, pitch: 20, fov: 45 }, offGoal, { keepSize: true });
  const recUnion = union(projectStudioLayout(recovered), ['hero']);
  close(center(recUnion), [offGoal.cx, offGoal.cy], 0.05);
  close(size(recUnion), offGoal.size, Math.max(0.05, offGoal.size * 0.0001));

  // Impossible huge size within distance 0.01..100 or behind camera with keepSize:false
  assert.throws(
    () => followStudioCamera(input, { orbit: 0 }, { ...validGoal, size: 1e7 }, { keepSize: true }),
    errorCode('STUDIO_FOLLOW_UNAVAILABLE'),
  );
  assert.throws(
    () => followStudioCamera(input, { pan_z: 5 }, validGoal, { keepSize: false }),
    errorCode('STUDIO_FOLLOW_UNAVAILABLE'),
  );
  assert.equal(JSON.stringify(input), snapshot);
});

test('followStudioCamera recovers feasible distance/pan seeds across pan_z, deep subjects, and near-bound candidates while honoring keepSize:false', () => {
  // Exact review repro (I1): flat center character at z=1, pan_z: 10 requires distance=11 (>8 default seed ceiling)
  const flatChar = freeze(layout([
    box('a', [384, 384, 640, 640], { label: 'character', body: { z: 1, thickness: 0, yaw: 0, anchor: 'world' } }),
  ]));
  const flatSnapshot = JSON.stringify(flatChar);
  const flatGoal = captureStudioFraming(flatChar);
  assert.deepEqual(flatGoal, { ids: ['a'], cx: 512, cy: 512, size: 256 });

  const solved11 = followStudioCamera(flatChar, { pan_z: 10 }, flatGoal, { keepSize: true });
  close(solved11.camera.pan_z, 10, 1e-12);
  close(solved11.camera.distance, 11, 1e-4);
  close([solved11.camera.pan_x, solved11.camera.pan_y], [0, 0], 1e-4);
  const cap11 = captureStudioFraming(solved11, ['a']);
  close([cap11.cx, cap11.cy], [flatGoal.cx, flatGoal.cy], 0.05);
  close(cap11.size, flatGoal.size, Math.max(0.05, flatGoal.size * 0.0001));
  assert.doesNotThrow(() => validateStudioDoc({ kind: 'layout', layout: solved11, caption: { caption: '' } }));

  // keepSize:false cannot change distance, so pan_z:10 with default distance=1 remains behind camera and fails cleanly
  assert.throws(
    () => followStudioCamera(flatChar, { pan_z: 10 }, flatGoal, { keepSize: false }),
    errorCode('STUDIO_FOLLOW_UNAVAILABLE'),
  );
  assert.equal(JSON.stringify(flatChar), flatSnapshot);

  // Near-bound / high-depth candidates: pan_z: 90 (requires distance=91 near 100 bound) and multi-depth scene with high depth target
  const solved91 = followStudioCamera(flatChar, { pan_z: 90, orbit: 15, pitch: -10 }, flatGoal, { keepSize: true });
  assert.ok(solved91.camera.distance > 80 && solved91.camera.distance <= 100);
  const cap91 = captureStudioFraming(solved91, ['a']);
  close([cap91.cx, cap91.cy], [flatGoal.cx, flatGoal.cy], 0.05);
  close(cap91.size, flatGoal.size, Math.max(0.05, flatGoal.size * 0.0001));
  assert.doesNotThrow(() => validateStudioDoc({ kind: 'layout', layout: solved91, caption: { caption: '' } }));

  const deepTargetScene = freeze(layout([
    box('fg-pivot', [300, 300, 700, 700], { label: 'character', body: { z: 1, thickness: 0.2, yaw: 0, anchor: 'world' } }),
    box('deep-obj', [650, 220, 890, 560], { body: { z: 45, thickness: 0.2, yaw: 12, anchor: 'world' } }),
  ]));
  const deepGoal = captureStudioFraming(deepTargetScene, ['deep-obj']);
  const solvedDeep = followStudioCamera(deepTargetScene, { orbit: -25, pitch: 12, pan_z: 30 }, deepGoal, { keepSize: true });
  const capDeep = captureStudioFraming(solvedDeep, ['deep-obj']);
  close([capDeep.cx, capDeep.cy], [deepGoal.cx, deepGoal.cy], 0.05);
  close(capDeep.size, deepGoal.size, Math.max(0.05, deepGoal.size * 0.0001));
  assert.doesNotThrow(() => validateStudioDoc({ kind: 'layout', layout: solvedDeep, caption: { caption: '' } }));
});

test('followStudioCamera validates domain angle bounds and rejects unknown patch fields atomically while accepting exact boundary angles', () => {
  const input = freeze(layout([
    box('a', [384, 384, 640, 640], { label: 'character', body: { z: 1, thickness: 0, yaw: 0, anchor: 'world' } }),
  ]));
  const snapshot = JSON.stringify(input);
  const goal = captureStudioFraming(input);

  // Out-of-domain angles (orbit/roll outside ±180, pitch outside ±85) and invalid layout.camera angles must reject atomically
  for (const badPatch of [
    { orbit: 360 },
    { orbit: -180.001 },
    { orbit: 180.001 },
    { roll: 360 },
    { roll: -180.001 },
    { roll: 180.001 },
    { pitch: 85.001 },
    { pitch: -85.001 },
    { pitch: 90 },
    { unknownField: 1 },
    { extra: true, orbit: 10 },
  ]) {
    assert.throws(() => followStudioCamera(input, badPatch, goal), errorCode('STUDIO_INVALID_INPUT'));
  }
  const badStoredAngleLayout = freeze({ ...input, camera: { ...input.camera, orbit: 360 } });
  assert.throws(() => followStudioCamera(badStoredAngleLayout, {}, goal), errorCode('STUDIO_INVALID_INPUT'));
  const badStoredFieldLayout = freeze({ ...input, camera: { ...input.camera, unknownMeta: 123 } });
  assert.throws(() => followStudioCamera(badStoredFieldLayout, {}, goal), errorCode('STUDIO_INVALID_INPUT'));
  assert.equal(JSON.stringify(input), snapshot);

  // Exact boundary angles (±180 roll, ±85 pitch, ±180 orbit on symmetric cuboid) are accepted and pass validateStudioDoc
  for (const okPatch of [
    { roll: 180 },
    { roll: -180 },
    { pitch: 85 },
    { pitch: -85 },
  ]) {
    const out = followStudioCamera(input, okPatch, goal, { keepSize: true });
    for (const [k, v] of Object.entries(okPatch)) close(out.camera[k], v, 1e-12);
    const framed = captureStudioFraming(out, ['a']);
    close([framed.cx, framed.cy], [goal.cx, goal.cy], 0.05);
    close(framed.size, goal.size, Math.max(0.05, goal.size * 0.0001));
    assert.doesNotThrow(() => validateStudioDoc({ kind: 'layout', layout: out, caption: { caption: '' } }));
  }

  const cubeScene = freeze(layout([
    box('c', [384, 384, 640, 640], { label: 'character', body: { z: 1, thickness: 0.3, yaw: 0, anchor: 'world' } }),
  ]));
  const cubeGoal = captureStudioFraming(cubeScene, ['c']);
  for (const orbitBound of [180, -180]) {
    const out = followStudioCamera(cubeScene, { orbit: orbitBound, roll: -180 }, cubeGoal, { keepSize: true });
    close(out.camera.orbit, orbitBound, 1e-12);
    close(out.camera.roll, -180, 1e-12);
    const framed = captureStudioFraming(out, ['c']);
    close([framed.cx, framed.cy], [cubeGoal.cx, cubeGoal.cy], 0.05);
    close(framed.size, cubeGoal.size, Math.max(0.05, cubeGoal.size * 0.0001));
    assert.doesNotThrow(() => validateStudioDoc({ kind: 'layout', layout: out, caption: { caption: '' } }));
  }
});

test('translateStudioItems translates world XYZ with fixed physical dimensions, rigid group deltas, and freeze/lock/individual rules', () => {
  const missingBody = { id: 'auto', label: 'object', caption: 'auto', bbox: [100, 100, 200, 300] };
  const input = freeze(layout([
    box('front', [312, 312, 712, 712], { group: 'g', body: { z: 1, thickness: 0.25, yaw: 15, anchor: 'world' } }),
    box('back', [412, 412, 612, 612], { group: 'g', body: { z: 2, thickness: 0.2, yaw: 0, anchor: 'world' } }),
    box('screen', [20, 20, 120, 120], { body: { z: 1, thickness: 0, yaw: 0, anchor: 'screen' } }),
    box('backdrop', [0, 0, 1024, 1024], { body: { z: 4, thickness: 0, yaw: 0, anchor: 'backdrop' } }),
    box('locked', [200, 200, 300, 300], { locked: true, body: { z: 1.5, thickness: 0.2, yaw: 0, anchor: 'world' } }),
    missingBody,
  ], { enabled: false }));
  const snapshot = JSON.stringify(input);
  const f = 512 / Math.tan(25 * Math.PI / 180);

  // Translate group 'g' by [0.2, -0.1, 1.0]
  const translated = translateStudioItems(input, ['front'], [0.2, -0.1, 1.0]);
  assert.equal(JSON.stringify(input), snapshot);
  // Camera was disabled and pivot didn't require enabling -> stays identical
  assert.deepEqual(translated.camera, input.camera);
  // Screen, backdrop, locked, and unselected 'auto' unchanged
  for (const idx of [2, 3, 4, 5]) assert.deepEqual(translated.items[idx], input.items[idx]);

  // front: z 1 -> 2. Physical width/height was 400*1/f, so at z=2 bbox width/height becomes 400 * (1/2) = 200.
  // Physical center was (0, 0, 1) -> (0.2, -0.1, 2) -> screen center (512 + f*0.2/2, 512 + f*(-0.1)/2)
  const frontAfter = translated.items[0];
  close(frontAfter.body.z, 2);
  close(frontAfter.bbox[2] - frontAfter.bbox[0], 200);
  close(frontAfter.bbox[3] - frontAfter.bbox[1], 200);
  close(center(frontAfter.bbox), [512 + f * 0.2 / 2, 512 - f * 0.1 / 2]);

  // back: z 2 -> 3. Physical width/height was 200*2/f, so at z=3 bbox width/height becomes 200 * (2/3).
  // Physical center was (0, 0, 2) -> (0.2, -0.1, 3) -> screen center (512 + f*0.2/3, 512 - f*0.1/3)
  const backAfter = translated.items[1];
  close(backAfter.body.z, 3);
  close(backAfter.bbox[2] - backAfter.bbox[0], 200 * 2 / 3);
  close(backAfter.bbox[3] - backAfter.bbox[1], 200 * 2 / 3);
  close(center(backAfter.bbox), [512 + f * 0.2 / 3, 512 - f * 0.1 / 3]);

  // Individual mode moves only 'front'
  const single = translateStudioItems(input, ['front'], [0.1, 0, 0.5], { individual: true });
  assert.deepEqual(single.items[1], input.items[1]);
  close(single.items[0].body.z, 1.5);

  // Freeze mode moves all unlocked world items (including 'auto' with frozen inferred body), skips locked
  const frozen = translateStudioItems(input, ['front'], [0.1, 0.05, 0.5], { freeze: true });
  assert.deepEqual(frozen.items[4], input.items[4]);
  assert.equal(frozen.items[5].body.anchor, 'world');
  assert.ok(frozen.items[5].body.z > 0.5);

  // Zero delta returns detached copy without phantom camera or body mutation
  const zero = translateStudioItems(input, ['front'], [0, 0, 0], { follow: true });
  assert.deepEqual(zero, input);
  assert.notEqual(zero, input);

  // Locked or invalid z fails
  assert.throws(() => translateStudioItems(input, ['locked'], [0.1, 0, 0]), errorCode('STUDIO_LOCKED'));
  assert.throws(() => translateStudioItems(input, ['front'], [0, 0, -1]), errorCode('STUDIO_MOVE_UNAVAILABLE'));
  assert.throws(() => translateStudioItems(input, ['front'], [0, 0, 100]), errorCode('STUDIO_MOVE_UNAVAILABLE'));
  assert.throws(() => translateStudioItems(input, ['front'], [NaN, 0, 0]), errorCode('STUDIO_INVALID_INPUT'));

  // Locked item inside moving group fails with STUDIO_LOCKED; freeze:true skips locked group
  const lockedGrpScene = freeze(layout([
    box('a', [300, 300, 500, 500], { group: 'lg' }),
    box('b', [500, 300, 700, 500], { group: 'lg', locked: true }),
    box('c', [200, 200, 400, 400]),
  ]));
  assert.throws(() => translateStudioItems(lockedGrpScene, ['a'], [0.1, 0, 0]), errorCode('STUDIO_LOCKED'));
  const frozenLockedGrp = translateStudioItems(lockedGrpScene, ['a'], [0.1, 0, 0], { freeze: true });
  assert.deepEqual(frozenLockedGrp.items[0], lockedGrpScene.items[0]);
  assert.deepEqual(frozenLockedGrp.items[1], lockedGrpScene.items[1]);
  assert.notDeepEqual(frozenLockedGrp.items[2].bbox, lockedGrpScene.items[2].bbox);

  // Disabled camera with non-identity stored values stays disabled and unchanged when follow:false
  const disabledMovedCam = freeze(layout([
    box('hero', [-190, 300, 10, 700], { label: 'character', body: { z: 1, thickness: 0, yaw: 0, anchor: 'world' } }),
    box('bg', [400, 400, 600, 600], { body: { z: 2, thickness: 0, yaw: 0, anchor: 'world' } }),
  ], { enabled: false, orbit: 30, distance: 2 }));
  const translatedDisabled = translateStudioItems(disabledMovedCam, ['hero'], [-0.05, 0, 0], { follow: false });
  assert.deepEqual(translatedDisabled.camera, disabledMovedCam.camera);
});

test('translateStudioItems with follow:false keeps camera physically fixed across pivot depth or visibility changes', () => {
  // Moving the default subject in z changes pivotDepth! Unselected world item projection must stay invariant.
  const input = freeze(layout([
    box('hero', [300, 300, 700, 700], { label: 'character', body: { z: 1, thickness: 0.2, yaw: 0, anchor: 'world' } }),
    box('bg', [200, 250, 450, 600], { locked: true, body: { z: 2.5, thickness: 0.3, yaw: 20, anchor: 'world' } }),
  ], { orbit: 24, pitch: -10, roll: 6, distance: 1.5, pan_x: 0.08, pan_y: -0.04, pan_z: 0.1 }));
  const before = projectStudioLayout(input);

  const moved = translateStudioItems(input, ['hero'], [0.15, -0.05, 0.8], { follow: false });
  const after = projectStudioLayout(moved);
  close(after.items.bg.raw, before.items.bg.raw, 1e-7);
  assert.deepEqual(moved.items[1], input.items[1]);
  for (const key of ['orbit', 'pitch', 'roll', 'fov']) close(moved.camera[key], { ...STUDIO_CAMERA_DEFAULTS, ...input.camera }[key], 1e-12);
});

test('translateStudioItems with follow:true preserves moving default subject framing while background shifts, and keeps camera fixed for non-default subject', () => {
  const input = freeze(layout([
    box('hero', [360, 280, 620, 760], { label: 'character', body: { z: 1.2, thickness: 0.25, yaw: 15, anchor: 'world' } }),
    box('sword', [600, 420, 680, 580], { group: 'hero-grp', body: { z: 1.1, thickness: 0.15, yaw: -10, anchor: 'world' } }),
    box('pillar', [160, 200, 300, 800], { locked: true, body: { z: 2.4, thickness: 0.3, yaw: 5, anchor: 'world' } }),
  ].map((item) => item.id === 'hero' ? { ...item, group: 'hero-grp' } : item), {
    enabled: false,
  }));
  const before = projectStudioLayout(input);
  const beforeUnion = union(before, ['hero', 'sword']);

  const followed = translateStudioItems(input, ['hero'], [0.35, -0.15, 0.6], { follow: true });
  assert.equal(followed.camera.enabled, true);
  for (const key of ['orbit', 'pitch', 'roll', 'fov']) {
    close(followed.camera[key], STUDIO_CAMERA_DEFAULTS[key], 1e-12);
  }
  assert.deepEqual(followed.items[2], input.items[2]);

  const after = projectStudioLayout(followed);
  const afterUnion = union(after, ['hero', 'sword']);
  close(center(afterUnion), center(beforeUnion), 0.05);
  close(size(afterUnion), size(beforeUnion), Math.max(0.05, size(beforeUnion) * 0.0001));
  assert.ok(Math.hypot(
    center(after.items.pillar.raw)[0] - center(before.items.pillar.raw)[0],
    center(after.items.pillar.raw)[1] - center(before.items.pillar.raw)[1],
  ) > 20, 'background projection must shift when camera follows moving subject');

  // Moving a non-default subject with follow:true leaves camera physically fixed (pillar stays fixed when moving another non-default item)
  const sceneWithExtra = freeze(layout([
    box('hero', [360, 280, 620, 760], { label: 'character', body: { z: 1.2, thickness: 0.25, yaw: 15, anchor: 'world' } }),
    box('crate', [700, 500, 820, 640], { body: { z: 1.8, thickness: 0.2, yaw: 0, anchor: 'world' } }),
    box('pillar', [160, 200, 300, 800], { locked: true, body: { z: 2.4, thickness: 0.3, yaw: 5, anchor: 'world' } }),
  ], { orbit: 18, pitch: 8, distance: 1.3 }));
  const beforeExtra = projectStudioLayout(sceneWithExtra);
  const nonDefaultMoved = translateStudioItems(sceneWithExtra, ['crate'], [0.2, 0.1, 0.4], { follow: true });
  const afterExtra = projectStudioLayout(nonDefaultMoved);
  close(afterExtra.items.hero.raw, beforeExtra.items.hero.raw, 1e-7);
  close(afterExtra.items.pillar.raw, beforeExtra.items.pillar.raw, 1e-7);
});

test('moveStudioItems with follow:true keeps default subject framed while shifting background and preserves zero-delta no-mutation', () => {
  const input = freeze(layout([
    box('hero', [380, 300, 620, 740], { label: 'character', body: { z: 1.2, thickness: 0.25, yaw: 20, anchor: 'world' } }),
    box('bg', [150, 200, 320, 700], { locked: true, body: { z: 2.5, thickness: 0.2, yaw: 0, anchor: 'world' } }),
  ], { orbit: 15, pitch: -8, roll: 4, distance: 1.25 }));
  const snapshot = JSON.stringify(input);
  const before = projectStudioLayout(input);

  // Zero movement does not mutate or alter camera
  const zero = moveStudioItems(input, ['hero'], 0, 0, { follow: true });
  assert.deepEqual(zero, input);
  assert.notEqual(zero, input);

  // Follow drag on default subject: subject stays framed at its original screen position/size while world bbox and background projection move
  const dragged = moveStudioItems(input, ['hero'], 80, -40, { follow: true });
  assert.equal(JSON.stringify(input), snapshot);
  assert.notDeepEqual(dragged.items[0].bbox, input.items[0].bbox);
  assert.deepEqual(dragged.items[1], input.items[1]);
  for (const key of ['orbit', 'pitch', 'roll', 'fov']) close(dragged.camera[key], { ...STUDIO_CAMERA_DEFAULTS, ...input.camera }[key], 1e-12);

  const after = projectStudioLayout(dragged);
  close(center(after.items.hero.raw), center(before.items.hero.raw), 0.05);
  close(size(after.items.hero.raw), size(before.items.hero.raw), Math.max(0.05, size(before.items.hero.raw) * 0.0001));
  assert.ok(Math.hypot(
    center(after.items.bg.raw)[0] - center(before.items.bg.raw)[0],
    center(after.items.bg.raw)[1] - center(before.items.bg.raw)[1],
  ) > 15, 'background projection shifts opposite to subject follow drag');

  // Follow drag on non-default subject behaves like fixed camera drag
  const scene2 = freeze(layout([
    box('hero', [380, 300, 620, 740], { label: 'character', body: { z: 1.2, thickness: 0.25, yaw: 20, anchor: 'world' } }),
    box('prop', [700, 450, 840, 650], { body: { z: 1.6, thickness: 0.2, yaw: 0, anchor: 'world' } }),
  ], { orbit: 15, pitch: -8, roll: 4, distance: 1.25 }));
  const before2 = projectStudioLayout(scene2);
  const propDragged = moveStudioItems(scene2, ['prop'], 40, -25, { follow: true });
  const after2 = projectStudioLayout(propDragged);
  close(center(after2.items.prop.raw), [center(before2.items.prop.raw)[0] + 40, center(before2.items.prop.raw)[1] - 25], 0.02);
  close(after2.items.hero.raw, before2.items.hero.raw, 1e-7);
});
