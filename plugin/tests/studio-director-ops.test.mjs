import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STUDIO_CAMERA_DEFAULTS,
  projectStudioLayout,
  studioCameraFrame,
  studioBody,
} from '../src/studio-camera.mjs';
import { validateStudioDoc } from '../src/studio-domain.mjs';
import * as ops from '../client/studio-director-ops.mjs';

const box = (id = 'a', bbox = [384, 384, 640, 640], extra = {}) => ({
  id, label: 'object', caption: 'A cube', bbox,
  body: { z: 1, thickness: 0.2, yaw: 0, anchor: 'world' }, ...extra,
});
const makeLayout = (items = [box()], camera = {}) => ({
  width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy',
  summary: { caption: 'A scene' }, items, camera: { enabled: true, ...camera },
});
const close = (actual, expected, epsilon = 1e-6) => {
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
function freeze(value) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(freeze); }
  return value;
}
const errorCode = (code) => (error) => error.code === code;
function assertValidLayout(l) {
  assert.doesNotThrow(() => validateStudioDoc({ kind: 'layout', layout: l, caption: { caption: '' } }));
}

test('studioCameraFrame returns detached position/right/down/forward/focal/pivot and uses base camera when disabled', () => {
  assert.equal(typeof studioCameraFrame, 'function');
  const hero = box('hero', [256, 256, 768, 768], { label: 'character', body: { z: 1.5, thickness: 0.3, yaw: 0, anchor: 'world' } });
  const disabled = freeze(makeLayout([hero], { enabled: false, orbit: 45, pitch: 20, distance: 2, pan_x: 1 }));
  const baseFrame = studioCameraFrame(disabled);
  assert.equal(baseFrame.pivot, 1.5);
  close(baseFrame.position, [0, 0, 0]);
  close(baseFrame.right, [1, 0, 0]);
  close(baseFrame.down, [0, 1, 0]);
  close(baseFrame.forward, [0, 0, 1]);
  close(baseFrame.focal, 512 / Math.tan(25 * Math.PI / 180));

  // Mutating returned arrays must not affect subsequent calls
  baseFrame.position[0] = 999;
  baseFrame.right[0] = 999;
  const baseFrame2 = studioCameraFrame(disabled);
  close(baseFrame2.position, [0, 0, 0]);
  close(baseFrame2.right, [1, 0, 0]);

  const active = freeze(makeLayout([hero], { enabled: true, orbit: 90, pitch: 0, distance: 2, pan_x: 0.2, pan_z: 0.5 }));
  const frame = studioCameraFrame(active);
  assert.equal(frame.pivot, 1.5);
  // orbit 90: forward = [-1, 0, 0], target = [0.2*1.5, 0, 1.5*1.5] = [0.3, 0, 2.25]
  // position = target - forward * 2 * 1.5 = [0.3 + 3, 0, 2.25] = [3.3, 0, 2.25]
  close(frame.forward, [-1, 0, 0]);
  close(frame.position, [3.3, 0, 2.25]);
});

test('STUDIO_VIEW_PRESETS exposes 13 named camera patches with CN labels and independent data', () => {
  const { STUDIO_VIEW_PRESETS } = ops;
  assert.ok(Array.isArray(STUDIO_VIEW_PRESETS));
  assert.equal(STUDIO_VIEW_PRESETS.length, 13);
  const ids = new Set();
  for (const preset of STUDIO_VIEW_PRESETS) {
    assert.equal(typeof preset.id, 'string');
    assert.equal(typeof preset.label, 'string');
    assert.ok(preset.label.length >= 2);
    assert.ok(!ids.has(preset.id));
    ids.add(preset.id);
    assert.equal(typeof preset.patch, 'object');
  }
  const hasMatch = (pred) => STUDIO_VIEW_PRESETS.some((p) => pred(p.patch));
  assert.ok(hasMatch((p) => Object.keys(p).length === 0));
  assert.ok(hasMatch((p) => p.pitch === 15 && Object.keys(p).length === 1));
  assert.ok(hasMatch((p) => p.pitch === 40 && Object.keys(p).length === 1));
  assert.ok(hasMatch((p) => p.pitch === 78 && p.distance === 1.15));
  assert.ok(hasMatch((p) => p.pitch === -30 && Object.keys(p).length === 1));
  assert.ok(hasMatch((p) => p.orbit === -45 && Object.keys(p).length === 1));
  assert.ok(hasMatch((p) => p.orbit === 45 && Object.keys(p).length === 1));
  assert.ok(hasMatch((p) => p.orbit === 90 && Object.keys(p).length === 1));
  assert.ok(hasMatch((p) => p.orbit === 180 && Object.keys(p).length === 1));
  assert.ok(hasMatch((p) => p.roll === 15 && Object.keys(p).length === 1));
  assert.ok(hasMatch((p) => p.fov === 85 && p.distance === 0.55));
  assert.ok(hasMatch((p) => p.fov === 22 && p.distance === 2.4));
  assert.ok(hasMatch((p) => p.distance === 0.55 && Object.keys(p).length === 1));
});

test('applyStudioCameraChange handles follow+keepSize, keepSize:false, manual pan/distance recapture, disable clear, and unavailable target notice', () => {
  const { applyStudioCameraChange } = ops;
  const input = freeze(makeLayout([
    box('hero', [350, 280, 650, 760], { label: 'character', body: { z: 1.2, thickness: 0.25, yaw: 10, anchor: 'world' } }),
    box('bg', [120, 180, 900, 860], { body: { z: 2.8, thickness: 0.2, yaw: 0, anchor: 'world' } }),
  ]));
  const goal = { ids: ['hero'], cx: 500, cy: 520, size: Math.sqrt(300 * 480) };

  // 1. Active follow with orbit/pitch/fov keeps center + size
  const step1 = applyStudioCameraChange(input, { orbit: 25, pitch: -12, fov: 60 }, { follow: goal, keepSize: true });
  assertValidLayout(step1.layout);
  assert.deepEqual(step1.follow, goal);
  const p1 = projectStudioLayout(step1.layout).items.hero.raw;
  close(center(p1), [goal.cx, goal.cy], 0.05);
  close(size(p1), goal.size, 0.05);

  // 2. Distance patch with keepSize:true is a manual distance change -> applies patch directly and recaptures new size
  const step2 = applyStudioCameraChange(step1.layout, { distance: 1.8 }, { follow: step1.follow, keepSize: true });
  assertValidLayout(step2.layout);
  close(step2.layout.camera.distance, 1.8, 1e-9);
  assert.ok(step2.follow && step2.follow.size < goal.size - 10);

  // 3. Distance patch with keepSize:false keeps center via follow solver while adopting new distance
  const step3 = applyStudioCameraChange(input, { orbit: 20, distance: 1.6 }, { follow: goal, keepSize: false });
  assertValidLayout(step3.layout);
  close(step3.layout.camera.distance, 1.6, 1e-9);
  const p3 = projectStudioLayout(step3.layout).items.hero.raw;
  close(center(p3), [goal.cx, goal.cy], 0.05);

  // 4. Explicit pan_x / pan_y or manual:true applies patch and recaptures goal
  const step4 = applyStudioCameraChange(input, { pan_x: 0.25 }, { follow: goal, keepSize: true });
  assertValidLayout(step4.layout);
  close(step4.layout.camera.pan_x, 0.25, 1e-9);
  assert.ok(step4.follow && Math.abs(step4.follow.cx - goal.cx) > 10);

  // 5. enabled:false clears follow
  const step5 = applyStudioCameraChange(step1.layout, { enabled: false }, { follow: step1.follow, keepSize: true });
  assert.equal(step5.layout.camera.enabled, false);
  assert.equal(step5.follow, null);

  // 6. Unavailable/hidden follow target clears follow and returns notice instead of keeping stale goal
  const hiddenHeroLayout = freeze({
    ...input,
    items: input.items.map((item) => item.id === 'hero' ? { ...item, hidden: true } : item),
  });
  const step6 = applyStudioCameraChange(hiddenHeroLayout, { orbit: 15 }, { follow: goal, keepSize: true });
  assertValidLayout(step6.layout);
  assert.equal(step6.follow, null);
  assert.equal(typeof step6.notice, 'string');
  assert.ok(step6.notice.length > 0);
});

test('frameStudioView supports smart, fit, subject, center, and fill modes while preserving angles/FOV/roll', () => {
  const { frameStudioView } = ops;
  const scene = freeze(makeLayout([
    box('hero', [380, 300, 620, 740], { label: 'character', body: { z: 1.2, thickness: 0.25, yaw: 15, anchor: 'world' } }),
    box('prop', [720, 460, 880, 680], { body: { z: 1.6, thickness: 0.2, yaw: 0, anchor: 'world' } }),
  ], { orbit: 28, pitch: -10, roll: 6, fov: 55, pan_x: 1.5, distance: 1.3 }));

  // 1. subject mode restores base original bbox center + sqrt(area) for default subject ('hero')
  const subjFramed = frameStudioView(scene, 'subject');
  assertValidLayout(subjFramed);
  for (const k of ['orbit', 'pitch', 'roll', 'fov']) close(subjFramed.camera[k], scene.camera[k]);
  const baseProj = projectStudioLayout({ ...scene, camera: { enabled: false } });
  const baseHeroRaw = baseProj.items.hero.raw;
  const subjProj = projectStudioLayout(subjFramed).items.hero.raw;
  close(center(subjProj), center(baseHeroRaw), 0.1);
  close(size(subjProj), size(baseHeroRaw), 0.5);

  // 2. center mode centers target at (W/2, H/2) without changing distance
  const centerFramed = frameStudioView(scene, 'center');
  assertValidLayout(centerFramed);
  close(centerFramed.camera.distance, scene.camera.distance, 1e-9);
  const centerProj = projectStudioLayout(centerFramed).items.hero.raw;
  close(center(centerProj), [512, 512], 0.1);

  // 3. fit mode centers all visible worlds and fits union to ~0.88W / 0.88H inside canvas
  const fitFramed = frameStudioView(scene, 'fit');
  assertValidLayout(fitFramed);
  const fitProj = projectStudioLayout(fitFramed);
  const fitUnion = union(fitProj, ['hero', 'prop']);
  close(center(fitUnion), [512, 512], 1.0);
  const fitSpan = Math.max((fitUnion[2] - fitUnion[0]) / 1024, (fitUnion[3] - fitUnion[1]) / 1024);
  close(fitSpan, 0.88, 0.03);
  assert.ok(fitUnion[0] >= 0 && fitUnion[1] >= 0 && fitUnion[2] <= 1024 && fitUnion[3] <= 1024);

  // 4. fill mode fits selected/target union to ~0.70W / 0.70H centered
  const fillFramed = frameStudioView(scene, 'fill', ['prop']);
  assertValidLayout(fillFramed);
  const fillProj = projectStudioLayout(fillFramed);
  const fillRaw = fillProj.items.prop.raw;
  close(center(fillRaw), [512, 512], 1.0);
  const fillSpan = Math.max((fillRaw[2] - fillRaw[0]) / 1024, (fillRaw[3] - fillRaw[1]) / 1024);
  close(fillSpan, 0.70, 0.03);

  // 5. smart mode keeps base original framing if inside canvas, or falls back to fit if outside canvas
  const smartNormal = frameStudioView(scene, 'smart');
  assertValidLayout(smartNormal);
  const smartUnion = union(projectStudioLayout(smartNormal), ['hero', 'prop']);
  assert.ok(smartUnion[0] >= 0 && smartUnion[1] >= 0 && smartUnion[2] <= 1024 && smartUnion[3] <= 1024);

  // Edge base item that would clip at base goal falls back to fit in smart mode
  const edgeScene = freeze(makeLayout([
    box('wide1', [10, 200, 300, 800], { body: { z: 1, thickness: 0.4, yaw: 0, anchor: 'world' } }),
    box('wide2', [750, 200, 1018, 800], { body: { z: 2.2, thickness: 0.4, yaw: 0, anchor: 'world' } }),
  ], { orbit: 35, pitch: 15, roll: 12 }));
  const smartFallback = frameStudioView(edgeScene, 'smart');
  const sfProj = projectStudioLayout(smartFallback);
  const sfUnion = union(sfProj, ['wide1', 'wide2']);
  assert.ok(sfUnion[0] >= 0 && sfUnion[1] >= 0 && sfUnion[2] <= 1024 && sfUnion[3] <= 1024);
});

test('studioTopView and cameraFromTopPoint map real baseline world XZ and compute orbit/distance from top point', () => {
  const { studioTopView, cameraFromTopPoint } = ops;
  const scene = freeze(makeLayout([
    box('hero', [256, 256, 768, 768], { label: 'character', locked: true, body: { z: 2, thickness: 0.5, yaw: 30, anchor: 'world' } }),
    box('screen', [0, 0, 100, 100], { body: { z: 1, thickness: 0, yaw: 0, anchor: 'screen' } }),
  ], { enabled: true, orbit: 30, pitch: 15, distance: 1.5, pan_x: 0.1, pan_z: 0.2 }));

  const top = studioTopView(scene);
  assert.equal(top.items.length, 1);
  const f0 = 512 / Math.tan(25 * Math.PI / 180);
  const item = top.items[0];
  assert.equal(item.id, 'hero');
  assert.equal(item.locked, true);
  close(item.x, 0);
  close(item.z, 2);
  close(item.width, 512 * 2 / f0);
  close(item.depth, (512 * 2 / f0) * 0.5);
  close(item.yaw, 30);

  // Camera position from readonly frame
  const roFrame = studioCameraFrame(scene);
  close(top.frame.position, roFrame.position);

  // cameraFromTopPoint: place camera at a new XZ point and verify resulting layout's camera position matches target X/Z ray
  const targetPoint = top.target; // [pan_x * pivot, pan_y * pivot, (1 + pan_z) * pivot]
  const patch = cameraFromTopPoint(scene, targetPoint[0] + 1.5, targetPoint[2] - 1.5);
  assert.equal(patch.enabled, true);
  close(patch.orbit, 45, 1e-4);
  assert.ok(patch.distance >= 0.2 && patch.distance <= 5);

  // Rejects nonfinite or zero-distance top points cleanly
  assert.throws(() => cameraFromTopPoint(scene, NaN, 0), errorCode('STUDIO_INVALID_INPUT'));
});

test('returnStudioItemsToView translates out-of-frame items into view with fixed physical camera and preserves physical size and locks', () => {
  const { returnStudioItemsToView } = ops;
  const scene = freeze(makeLayout([
    box('pivot', [350, 300, 650, 750], { label: 'character', locked: true, body: { z: 1.2, thickness: 0.2, yaw: 0, anchor: 'world' } }),
    box('lost', [2400, 1800, 2700, 2200], { group: 'g', body: { z: 2.0, thickness: 0.3, yaw: 20, anchor: 'world' } }),
    box('lost2', [2650, 1850, 2800, 2100], { group: 'g', body: { z: 2.4, thickness: 0.2, yaw: -10, anchor: 'world' } }),
    box('offScreen', [1400, 1200, 1600, 1300], { body: { z: 1, thickness: 0, yaw: 0, anchor: 'screen' } }),
  ], { enabled: true, orbit: 35, pitch: -12, roll: 5, distance: 1.4, pan_x: -0.2, pan_y: 0.1 }));

  const beforeFrame = studioCameraFrame(scene);
  const f0 = 512 / Math.tan(25 * Math.PI / 180);
  const physW1 = (scene.items[1].bbox[2] - scene.items[1].bbox[0]) * scene.items[1].body.z / f0;
  const physH1 = (scene.items[1].bbox[3] - scene.items[1].bbox[1]) * scene.items[1].body.z / f0;

  assert.equal(projectStudioLayout(scene).items.lost.visible, false);

  const returned = returnStudioItemsToView(scene, ['lost']);
  assertValidLayout(returned);

  // Physical camera position & orientation remain fixed
  const afterFrame = studioCameraFrame(returned);
  close(afterFrame.position, beforeFrame.position, 1e-5);
  close(afterFrame.forward, beforeFrame.forward, 1e-7);
  // Locked item untouched
  assert.deepEqual(returned.items[0], scene.items[0]);

  // Returned items are now visible and inside canvas
  const proj = projectStudioLayout(returned);
  assert.equal(proj.items.lost.visible, true);
  assert.equal(proj.items.lost2.visible, true);
  assert.equal(proj.items.lost.partial, false);
  assert.equal(proj.items.lost2.partial, false);
  const u = union(proj, ['lost', 'lost2']);
  close(center(u), [512, 512], 5);

  // Physical size W = w * z / f0 preserved
  const item1After = returned.items[1];
  close((item1After.bbox[2] - item1After.bbox[0]) * item1After.body.z / f0, physW1, 1e-4);
  close((item1After.bbox[3] - item1After.bbox[1]) * item1After.body.z / f0, physH1, 1e-4);

  // Screen/backdrop items can 2D shift inside canvas without changing camera or world items
  const returnedScreen = returnStudioItemsToView(scene, ['offScreen']);
  assertValidLayout(returnedScreen);
  const screenBox = returnedScreen.items[3].bbox;
  assert.ok(screenBox[0] >= 0 && screenBox[1] >= 0 && screenBox[2] <= 1024 && screenBox[3] <= 1024);
  assert.deepEqual(returnedScreen.items[1], scene.items[1]);

  // Locked target fails atomically with STUDIO_LOCKED
  assert.throws(() => returnStudioItemsToView(scene, ['pivot']), errorCode('STUDIO_LOCKED'));
});

test('studioCameraReadout returns Chinese composition readout, 35mm-equivalent focalMm, and framing ratio', () => {
  const { studioCameraReadout } = ops;
  const scene = freeze(makeLayout([box()], { enabled: true, orbit: -30, pitch: 25, roll: 12, distance: 0.7, fov: 50 }));
  const readout = studioCameraReadout(scene);
  assert.equal(typeof readout.text, 'string');
  assert.ok(readout.text.length > 0);
  // 24 / (2 * tan(25 deg)) = 25.734...
  close(readout.focalMm, 24 / (2 * Math.tan(25 * Math.PI / 180)), 0.01);
  // framing = 0.7 * tan(25 deg) / tan(25 deg) = 0.7
  close(readout.framing, 0.7, 1e-6);
});

test('ops reject empty, behind-start unsolvable, zero-distance top points, and impossible returnStudioItemsToView atomically without mutating inputs', () => {
  const { frameStudioView, cameraFromTopPoint, returnStudioItemsToView } = ops;
  const emptyScene = freeze(makeLayout([
    box('txt', [100, 100, 300, 200], { label: 'text', text: 'Title', body: { z: 1, thickness: 0.05, yaw: 0, anchor: 'screen' } }),
    box('hid', [200, 200, 400, 400], { hidden: true }),
  ]));
  const snapEmpty = JSON.stringify(emptyScene);
  assert.throws(() => frameStudioView(emptyScene, 'smart'), errorCode('STUDIO_FRAME_UNAVAILABLE'));
  assert.throws(() => frameStudioView(emptyScene, 'fit'), errorCode('STUDIO_FRAME_UNAVAILABLE'));
  assert.throws(() => frameStudioView(emptyScene, 'subject'), errorCode('STUDIO_FRAME_UNAVAILABLE'));
  assert.equal(JSON.stringify(emptyScene), snapEmpty);

  // Behind-camera start that IS recoverable via frameStudioCamera recovers cleanly in fit/smart
  const behindRecoverable = freeze(makeLayout([
    box('pivot', [256, 256, 768, 768], { label: 'character' }),
    box('far', [416, 416, 608, 608], { body: { z: 3, thickness: 0.2, yaw: 0, anchor: 'world' } }),
  ], { orbit: 180 }));
  const recoveredFit = frameStudioView(behindRecoverable, 'fit', ['far']);
  assertValidLayout(recoveredFit);
  assert.equal(projectStudioLayout(recoveredFit).items.far.visible, true);

  // Zero-distance top point fails cleanly
  const topScene = freeze(makeLayout([box()]));
  const topView = ops.studioTopView(topScene);
  assert.throws(
    () => cameraFromTopPoint(topScene, topView.target[0], topView.target[2]),
    errorCode('STUDIO_CAMERA_UNAVAILABLE'),
  );

  // Impossible returnStudioItemsToView (camera looking backward along -Z from z=-10 so every point in front of camera has z < 0) fails atomically
  const impossibleReturn = freeze(makeLayout([
    box('pivot', [300, 300, 700, 700], { label: 'character', locked: true, body: { z: 1, thickness: 0.2, yaw: 0, anchor: 'world' } }),
    box('target', [2500, 2500, 2700, 2700], { body: { z: 1, thickness: 0.2, yaw: 0, anchor: 'world' } }),
  ], { enabled: true, orbit: 180, distance: 1, pan_z: -12 }));
  const snapImpossible = JSON.stringify(impossibleReturn);
  assert.throws(() => returnStudioItemsToView(impossibleReturn, ['target']), errorCode('STUDIO_MOVE_UNAVAILABLE'));
  assert.equal(JSON.stringify(impossibleReturn), snapImpossible);
});

const flatBox = (id, bbox, extra={}) => box(id,bbox,{body:{z:1,thickness:0,yaw:0,anchor:'world'},...extra});
test('return continues past clipped candidate and fits a wide world without changing physical size or camera',()=>{
 const input=freeze(makeLayout([flatBox('wide',[2200,300,3600,700])]));
 const result=ops.returnStudioItemsToView(input,['wide']), projected=projectStudioLayout(result).items.wide;
 assert.equal(projected.visible,true);assert.equal(projected.partial,false);
 assert.ok(projected.raw[0]>=0&&projected.raw[2]<=1024);
 close(studioCameraFrame(result).position,studioCameraFrame(input).position);
 close((result.items[0].bbox[2]-result.items[0].bbox[0])*result.items[0].body.z,1400,0.001);
});
test('return shifts screen items without resizing and rejects oversized implicit backdrop atomically',()=>{
 const input=freeze(makeLayout([flatBox('s',[1200,100,2200,300],{body:{z:1,thickness:0,yaw:0,anchor:'screen'}})],{orbit:30,pitch:10,distance:2}));
 const result=ops.returnStudioItemsToView(input,['s']),b=result.items[0].bbox;
 close([b[2]-b[0],b[3]-b[1]],[1000,200]);assert.ok(b[0]>=0&&b[2]<=1024);
 close(studioCameraFrame(result).position,studioCameraFrame(input).position);
 const backdrop=flatBox('b',[-10,-10,1020,1020]);delete backdrop.body;
 const oversized=freeze(makeLayout([backdrop],{orbit:30,pitch:10,distance:2}));
 assert.equal(studioBody(backdrop,oversized).anchor,'backdrop');
 assert.throws(()=>ops.returnStudioItemsToView(oversized,['b']),errorCode('STUDIO_MOVE_UNAVAILABLE'));
});
test('return keeps hidden group members hidden while translating rigidly and protecting hidden locks',()=>{
 const input=freeze(makeLayout([flatBox('a',[2000,400,2200,600],{group:'g'}),flatBox('b',[2200,400,2300,500],{group:'g',hidden:true})]));
 const result=ops.returnStudioItemsToView(input,['a']);
 assert.equal(projectStudioLayout(result).items.a.partial,false);assert.equal(result.items[1].hidden,true);
 const f0=512/Math.tan(25*Math.PI/180);
 const xyz=i=>[(center(i.bbox)[0]-512)*i.body.z/f0,(center(i.bbox)[1]-512)*i.body.z/f0,i.body.z];
 close(xyz(result.items[1]).map((v,k)=>v-xyz(result.items[0])[k]),xyz(input.items[1]).map((v,k)=>v-xyz(input.items[0])[k]),1e-5);
 const locked=makeLayout(input.items.map(i=>i.id==='b'?{...i,locked:true}:i));
 assert.throws(()=>ops.returnStudioItemsToView(locked,['a']),errorCode('STUDIO_LOCKED'));
});
test('fit and fill report unavailable instead of accepting a tiny wrong-span fallback',()=>{
 const input=freeze(makeLayout([flatBox('tiny',[509,509,515,515])]));
 for(const mode of ['fit','fill'])assert.throws(()=>ops.frameStudioView(input,mode,['tiny']),errorCode('STUDIO_FRAME_UNAVAILABLE'));
});
test('smart preserves completely in-frame baseline near canvas edge without imposing a margin',()=>{
 const input=freeze(makeLayout([flatBox('edge',[5,200,205,800])]));
 const result=ops.frameStudioView(input,'smart');
 close(projectStudioLayout(result).items.edge.raw,[5,200,205,800],0.05);
});
