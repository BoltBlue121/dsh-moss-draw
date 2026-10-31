import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CAMERA, validateCamera, validateBody, bodyFromBox,
  projectBody, projectLayout, cameraDescription,
} from '../src/workbench-camera.mjs';

const canvas = Object.freeze({ width: 1000, height: 1000 });
const frontBody = Object.freeze({ x: 0, y: 0, z: 0, width: 2, height: 1, depth: 0, yaw: 0 });
function close(actual, expected, tolerance = 1e-9) {
  assert.ok(Number.isFinite(actual), `Expected finite value, got ${actual}`);
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} differs from ${expected}`);
}
function boxClose(actual, expected, tolerance = 1e-9) {
  assert.equal(actual?.length, 4);
  actual.forEach((value, index) => close(value, expected[index], tolerance));
}
function invalid(operation) {
  assert.throws(operation, (error) => error.code === 'INVALID_INPUT');
}
function freezeDeep(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

test('partial camera defaults are complete, detached and cannot alter future projections', () => {
  const input = { orbit: 30 };
  const camera = validateCamera(input);
  assert.deepEqual(camera, { orbit: 30, pitch: 0, roll: 0, distance: 5, fov: 50, pan_x: 0, pan_y: 0, pan_z: 0 });
  camera.distance = 10;
  assert.deepEqual(input, { orbit: 30 });
  assert.equal(validateCamera({}).distance, 5);
  assert.ok(Object.isFrozen(DEFAULT_CAMERA));
});

test('camera rejects unknown keys, coercion, nonfinite and out-of-range fields', () => {
  for (const camera of [null, [], 'camera', { typo: 0 }, { fov: '50' }, { fov: NaN }, { distance: Infinity },
    { distance: 0 }, { distance: 0.099 }, { distance: 100.001 }, { fov: 9.999 }, { fov: 120.001 },
    { orbit: 180.001 }, { orbit: -180.001 }, { pitch: 85.001 }, { pitch: -85.001 },
    { roll: 180.001 }, { roll: -180.001 }, { pan_x: -100.001 }, { pan_y: 100.001 }, { pan_z: Infinity },
    { fov: undefined }]) invalid(() => validateCamera(camera));
  for (const camera of [
    { orbit: -180, pitch: -85, roll: -180, distance: 0.1, fov: 10, pan_x: -100, pan_y: -100, pan_z: -100 },
    { orbit: 180, pitch: 85, roll: 180, distance: 100, fov: 120, pan_x: 100, pan_y: 100, pan_z: 100 },
  ]) assert.deepEqual(validateCamera(camera), camera);
});

test('body validator fills only optional depth fields and rejects malformed geometry', () => {
  const body = { x: 1, y: -2, width: 3, height: 4 };
  assert.deepEqual(validateBody(body), { ...body, z: 0, depth: 0, yaw: 0 });
  assert.notStrictEqual(validateBody(body), body);
  for (const value of [null, [], {}, { ...frontBody, width: 0 }, { ...frontBody, height: -1 },
    { ...frontBody, depth: -1 }, { ...frontBody, x: NaN }, { ...frontBody, z: Infinity },
    { ...frontBody, width: '2' }, { ...frontBody, yaw: 181 }, { ...frontBody, unknown: 0 }]) {
    invalid(() => validateBody(value));
  }
});

test('default camera roundtrips half-open full-frame, one-pixel and asymmetric boxes without drift', () => {
  for (const size of [{ width: 1000, height: 1000 }, { width: 1536, height: 864 }, { width: 720, height: 1280 }]) {
    for (const box of [[0, 0, size.width, size.height], [0, 0, 1, 1],
      [size.width - 1, size.height - 1, size.width, size.height], [73, 49, 611, 701], [2.25, 3.5, 29.75, 30.5]]) {
      const body = bodyFromBox(box, size);
      assert.equal(body.z, 0);
      assert.equal(body.depth, 0);
      assert.equal(body.yaw, 0);
      const projected = projectBody(body, DEFAULT_CAMERA, size);
      boxClose(projected.box, box, 1e-8);
      assert.equal(projected.visible, true);
      assert.equal(projected.clipped, false);
      assert.equal(projected.reason, null);
    }
  }
});

test('bodyFromBox uses centered world y-up coordinates and optional independent body depth', () => {
  const body = bodyFromBox([250, 250, 750, 750], canvas, { z: -2, depth: 1, yaw: 30 });
  close(body.x, 0);
  close(body.y, 0);
  close(body.width, 2.331538290774993);
  close(body.height, 2.331538290774993);
  assert.deepEqual({ z: body.z, depth: body.depth, yaw: body.yaw }, { z: -2, depth: 1, yaw: 30 });
  assert.ok(bodyFromBox([500, 0, 600, 100], canvas).y > 0);
});

test('box and canvas validation rejects degenerate, nonfinite and excessive geometry', () => {
  for (const box of [null, [], [0, 0, 1], [0, 0, 0, 1], [0, 2, 1, 1], [0, 0, Infinity, 1], ['0', 0, 1, 1]]) {
    invalid(() => bodyFromBox(box, canvas));
  }
  for (const size of [null, { width: 0, height: 10 }, { width: 1.5, height: 10 },
    { width: 3000, height: 2000 }, { width: Infinity, height: 1 }]) {
    invalid(() => bodyFromBox([0, 0, 1, 1], size));
    invalid(() => projectBody(frontBody, {}, size));
  }
  invalid(() => bodyFromBox([0, 0, 10, 10], canvas, { distance: 2 }));
});

test('positive horizontal pan moves static bodies left; vertical pan moves them down', () => {
  boxClose(projectBody(frontBody, { fov: 90, pan_x: 1 }, canvas).box, [300, 450, 500, 550]);
  boxClose(projectBody(frontBody, { fov: 90, pan_y: 1 }, canvas).box, [400, 550, 600, 650]);
});

test('vertical FOV and distance determine the perspective size without changing body coordinates', () => {
  boxClose(projectBody(frontBody, { fov: 90 }, canvas).box, [400, 450, 600, 550]);
  boxClose(projectBody(frontBody, { fov: 90, distance: 10 }, canvas).box, [450, 475, 550, 525]);
  boxClose(projectBody({ ...frontBody, z: -5 }, { fov: 90 }, canvas).box, [450, 475, 550, 525]);
  boxClose(projectBody(frontBody, { fov: 90, pan_z: 5 }, canvas).box, [450, 475, 550, 525]);
  const wide = projectBody(frontBody, { fov: 120 }, canvas).box;
  const narrow = projectBody(frontBody, { fov: 10 }, canvas).box;
  assert.ok(wide[2] - wide[0] < 200);
  assert.ok(narrow[2] - narrow[0] > 200);
});

test('cuboid returns eight ordered corners and twelve independent wireframe edges', () => {
  const projected = projectBody({ ...frontBody, height: 2, depth: 2 }, { fov: 90 }, canvas);
  const expected = [
    [416.6666666666667, 416.6666666666667, 6], [583.3333333333333, 416.6666666666667, 6],
    [583.3333333333333, 583.3333333333333, 6], [416.6666666666667, 583.3333333333333, 6],
    [375, 375, 4], [625, 375, 4], [625, 625, 4], [375, 625, 4],
  ];
  assert.equal(projected.corners.length, 8);
  projected.corners.forEach((corner, i) => corner.forEach((value, j) => close(value, expected[i][j])));
  assert.deepEqual(projected.edges, [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]);
  boxClose(projected.box, [375, 375, 625, 625]);
});

test('positive orbit places camera on positive x while preserving a right-handed frame', () => {
  const projected = projectBody({ ...frontBody, height: 2, depth: 2 }, { fov: 90, orbit: 90 }, canvas);
  close(projected.corners[0][0], 583.3333333333333);
  close(projected.corners[0][1], 416.6666666666667);
  close(projected.corners[0][2], 6);
  close(projected.corners[1][0], 625);
  close(projected.corners[1][2], 4);
});

test('positive pitch raises camera and positive roll turns the screen clockwise', () => {
  // At pitch 60, world (0,1,0) has screen-up 0.5 and view depth 5 - sqrt(3)/2.
  const pitched = projectBody({ x: 1, y: 0, width: 2, height: 2, depth: 0 }, { fov: 90, pitch: 60 }, canvas);
  close(pitched.corners[0][0], 500);
  close(pitched.corners[0][1], 439.52551130119135);
  close(pitched.corners[0][2], 4.133974596215562);
  boxClose(projectBody({ ...frontBody, x: 1 }, { fov: 90, roll: 90 }, canvas).box, [450, 500, 550, 700]);
});

test('body yaw rotates cuboid geometry about its own center, not the camera target', () => {
  const projected = projectBody({ x: 0, y: 0, width: 2, height: 2, depth: 4, yaw: 90 }, { fov: 90 }, canvas);
  close(projected.corners[0][0], 250);
  close(projected.corners[0][1], 375);
  close(projected.corners[0][2], 4);
  close(projected.corners[1][0], 333.3333333333333);
  close(projected.corners[1][2], 6);
});

test('near-plane crossing is explicit and cannot yield an auto-acceptable bounding box', () => {
  const projected = projectBody({ ...frontBody, z: 4.99, depth: 0.04 }, { fov: 90 }, canvas);
  assert.equal(projected.visible, true);
  assert.equal(projected.clipped, true);
  assert.equal(projected.reason, 'near-plane');
  assert.equal(projected.box, null);
  assert.equal(projected.corners.length, 8);
  assert.equal(projected.edges.length, 12);
  assert.ok(projected.corners.some(([x]) => x === null));
  assert.ok(projected.corners.some(([x]) => Number.isFinite(x)));
  for (const corner of projected.corners) for (const value of corner) assert.ok(value === null || Number.isFinite(value));
});

test('camera-plane and behind-camera bodies use null screen coordinates, never NaN or mirrored boxes', () => {
  for (const z of [5, 6]) {
    const projected = projectBody({ ...frontBody, z }, {}, canvas);
    assert.equal(projected.visible, false);
    assert.equal(projected.clipped, true);
    assert.equal(projected.reason, 'behind-camera');
    assert.equal(projected.box, null);
    for (const corner of projected.corners) assert.deepEqual(corner, [null, null, 5 - z]);
  }
  const tooNear = projectBody({ ...frontBody, z: 4.995 }, {}, canvas);
  assert.equal(tooNear.visible, false);
  assert.equal(tooNear.clipped, true);
  assert.equal(tooNear.reason, 'near-plane');
});

test('near plane includes its exact boundary but rejects a point strictly in front of it', () => {
  // 0.1 - 0.09 is slightly greater than 0.01 in IEEE754, avoiding a rounded-below fixture.
  const boundary = projectBody({ ...frontBody, z: 0.09 }, { distance: 0.1 }, canvas);
  assert.equal(boundary.clipped, false);
  assert.ok(boundary.corners.every((corner) => corner[2] >= 0.01));
  const inside = projectBody({ ...frontBody, z: 0.091 }, { distance: 0.1 }, canvas);
  assert.equal(inside.clipped, true);
});

test('out-of-frame boxes remain unmodified and prevent layout acceptance', () => {
  const box = [-40, 30, 1100, 800];
  const result = projectLayout([{ id: 'wide', box }], {}, canvas);
  boxClose(result.regions[0].box, box, 1e-8);
  assert.equal(result.regions[0].visible, true);
  assert.equal(result.regions[0].clipped, false);
  assert.equal(result.valid, false);
});

test('layout preserves region identity, lock, group and detached original body metadata', () => {
  const input = freezeDeep([
    { id: 'first', box: [100, 200, 400, 800], group: 'pair', locked: true, body: { x: 0, y: 0, width: 2, height: 1 }, references: [1, 2] },
    { id: 'second', box: [600, 200, 800, 800], group: 'pair', locked: false },
  ]);
  const result = projectLayout(input, freezeDeep({ fov: 90 }), canvas);
  assert.equal(result.valid, true);
  assert.deepEqual(result.regions.map(({ id, group, locked }) => ({ id, group, locked })), [
    { id: 'first', group: 'pair', locked: true }, { id: 'second', group: 'pair', locked: false },
  ]);
  boxClose(result.regions[0].box, [400, 450, 600, 550]);
  result.regions[0].body.x = 10;
  result.regions[0].references.push(3);
  assert.equal(input[0].body.x, 0);
  assert.deepEqual(input[0].references, [1, 2]);
  assert.deepEqual(input[0].box, [100, 200, 400, 800]);
});

test('layout rejects clipped and degenerate projections without silently repairing inputs', () => {
  assert.equal(projectLayout([{ id: 'front', box: [100, 100, 200, 200] }], {}, canvas).valid, true);
  assert.equal(projectLayout([{ id: 'near', box: [100, 100, 200, 200], body: { ...frontBody, z: 5 } }], {}, canvas).valid, false);
  const edgeOn = projectLayout([{ id: 'edge', box: [100, 100, 200, 200], body: frontBody }], { orbit: 90 }, canvas);
  assert.equal(edgeOn.valid, false);
  assert.equal(edgeOn.regions[0].box, null);
  assert.equal(edgeOn.regions[0].reason, 'degenerate');
  invalid(() => projectLayout(null, {}, canvas));
  invalid(() => projectLayout([{ box: [0, 0, 10, 10] }], {}, canvas));
  invalid(() => projectLayout([{ id: 'a', box: [0, 0, 10, 10] }, { id: 'a', box: [0, 0, 10, 10] }], {}, canvas));
});

test('all API outputs are detached and no projection mutates frozen inputs or other outputs', () => {
  const input = freezeDeep({ box: [50, 100, 900, 800], options: { depth: 1, yaw: 20 }, camera: { orbit: 20, pitch: 30, roll: -45 } });
  const body = freezeDeep(bodyFromBox(input.box, canvas, input.options));
  const first = projectBody(body, input.camera, canvas);
  const second = projectBody(body, input.camera, canvas);
  assert.deepEqual(first, second);
  first.corners[0][0] = 999;
  first.edges[0][0] = 7;
  assert.notEqual(second.corners[0][0], 999);
  assert.deepEqual(second.edges[0], [0, 1]);
  assert.deepEqual(projectBody(body, input.camera, canvas), second);
});

test('full-frame default layouts accept numerical boundary noise but never real out-of-bounds boxes', () => {
  for (const size of [canvas, { width: 1536, height: 864 }, { width: 720, height: 1280 }]) {
    const full = [0, 0, size.width, size.height];
    const result = projectLayout([{ id: 'full', box: full }], {}, size);
    assert.equal(result.valid, true);
    boxClose(result.regions[0].box, full, 1e-8);
  }
  const outside = projectLayout([{ id: 'outside', box: [-0.000001, 0, 1000, 1000] }], {}, canvas);
  assert.equal(outside.valid, false);
  assert.ok(outside.regions[0].box[0] < 0);
});

test('edge-on flat bodies remain degenerate after a screen-space roll', () => {
  const projected = projectBody(frontBody, { orbit: 90, roll: 45 }, canvas);
  assert.equal(projected.box, null);
  assert.equal(projected.visible, false);
  assert.equal(projected.reason, 'degenerate');
});

test('body world bounds are inclusive, finite and never clamped or coerced', () => {
  assert.deepEqual(validateBody({ x: -1000, y: 1000, z: -1000, width: 1000, height: 1000, depth: 1000, yaw: -180 }),
    { x: -1000, y: 1000, z: -1000, width: 1000, height: 1000, depth: 1000, yaw: -180 });
  for (const change of [{ x: 1000.1 }, { y: -1000.1 }, { z: 1000.1 }, { width: 1000.1 },
    { height: 1000.1 }, { depth: 1000.1 }, { yaw: -180.1 }, { z: undefined }, { depth: null }]) {
    invalid(() => validateBody({ ...frontBody, ...change }));
  }
  for (const value of [new Date(), new Number(3), Object.assign(Object.create({ orbit: 3 }), {})]) {
    invalid(() => validateCamera(value));
  }
  invalid(() => validateCamera({ [Symbol('unknown')]: 0 }));
  assert.equal(projectLayout([], {}, canvas).valid, false);
});

test('translated orbit target and body together leave relative projections unchanged', () => {
  const view = { orbit: 35, pitch: -20, roll: 15, fov: 90 };
  const original = projectBody({ ...frontBody, depth: 2 }, view, canvas);
  const translated = projectBody({ ...frontBody, x: 7, y: -3, z: 2, depth: 2 }, { ...view, pan_x: 7, pan_y: -3, pan_z: 2 }, canvas);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 3; j++) close(translated.corners[i][j], original.corners[i][j]);
});

test('camera extremes produce finite or explicitly absent geometry, never NaN', () => {
  for (const camera of [
    { orbit: -180, pitch: -85, roll: -180, distance: 0.1, fov: 10, pan_x: -100, pan_y: -100, pan_z: -100 },
    { orbit: 180, pitch: 85, roll: 180, distance: 100, fov: 120, pan_x: 100, pan_y: 100, pan_z: 100 },
    { orbit: 90, pitch: 85, roll: 90, distance: 0.1, fov: 10 },
  ]) {
    const result = projectBody({ x: 1000, y: -1000, z: 1000, width: 1000, height: 1000, depth: 1000, yaw: 180 }, camera, canvas);
    assert.equal(result.corners.length, 8);
    for (const corner of result.corners) for (const value of corner) assert.ok(value === null || Number.isFinite(value));
    if (result.box) assert.ok(result.box.every(Number.isFinite));
  }
});

test('a sparse region array cannot bypass validation and appear acceptable', () => {
  invalid(() => projectLayout(new Array(1), {}, canvas));
});

test('description gives bounded English camera parameters and only a blockout limitation', () => {
  const description = cameraDescription({ orbit: 30, pitch: -10, roll: 5, fov: 60, pan_x: 2 });
  assert.equal(typeof description, 'string');
  assert.ok(description.length < 500);
  assert.match(description, /orbit.*30/i);
  assert.match(description, /pitch.*-10/i);
  assert.match(description, /roll.*5/i);
  assert.match(description, /(?:FOV|field of view).*60/i);
  assert.match(description, /blockout/i);
  assert.match(description, /not.*(?:reconstruct|image)/i);
  invalid(() => cameraDescription({ fov: 0 }));
});
