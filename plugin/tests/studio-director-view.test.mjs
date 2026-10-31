import assert from 'node:assert/strict';
import test from 'node:test';
import * as directorView from '../client/studio-camera-view.mjs';
const { createStudioCameraView, createStudioBodyInspector } = directorView;
import { projectStudioLayout, studioCameraFrame } from '../src/studio-camera.mjs';
import { validateStudioDoc } from '../src/studio-domain.mjs';
import { createStudioModel } from '../client/studio-model.mjs';

function createStatefulHarness() {
  const states = [];
  const refs = [];
  const effects = [];
  let cursor = 0;
  let refCursor = 0;
  const React = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useState: (init) => {
      const idx = cursor++;
      if (!(idx in states)) {
        states[idx] = typeof init === 'function' ? init() : init;
      }
      const setState = (next) => {
        states[idx] = typeof next === 'function' ? next(states[idx]) : next;
      };
      return [states[idx], setState];
    },
    useRef: (init) => {
      const idx = refCursor++;
      if (!(idx in refs)) {
        refs[idx] = { current: init };
      }
      return refs[idx];
    },
    useEffect: (fn) => {
      effects.push(fn);
    },
  };
  return {
    React,
    render: (Component, props) => {
      cursor = 0;
      refCursor = 0;
      return Component(props);
    },
    runEffects: () => effects.map((fn) => fn()).filter((c) => typeof c === 'function'),
  };
}

function nodes(tree) {
  const result = [];
  const walk = (n) => {
    if (n && typeof n === 'object') {
      result.push(n);
      n.children?.forEach(walk);
    }
  };
  walk(tree);
  return result;
}

const makeBox = (id = 'hero', bbox = [320, 260, 620, 760], extra = {}) => ({
  id,
  name: id,
  label: 'character',
  caption: 'Hero character',
  bbox,
  body: { z: 1.2, thickness: 0.3, yaw: 10, anchor: 'world' },
  ...extra,
});

const makeScene = (items = [makeBox()], camera = {}) => ({
  width: 1024,
  height: 1024,
  bbox_coord_space: 'abs',
  bbox_format: 'xyxy',
  summary: { caption: 'Scene' },
  items,
  camera: { enabled: true, ...camera },
});

function createMockEnv(initialLayout = makeScene(), selected = ['hero']) {
  const state = {
    draft: {
      title: 'Page',
      doc: {
        kind: 'layout',
        layout: structuredClone(initialLayout),
        caption: { caption: '' },
      },
    },
    selected: [...selected],
    editingBlocked: false,
  };
  let gestures = 0;
  let cancelledGestures = 0;
  let disposed = false;
  const model = {
    getSnapshot: () => state,
    patchCamera: (patch) => {
      state.draft.doc.layout.camera = { ...state.draft.doc.layout.camera, ...structuredClone(patch) };
      validateStudioDoc(state.draft.doc);
    },
    updateLayout: (fn) => {
      const next = typeof fn === 'function' ? fn(structuredClone(state.draft.doc.layout)) : structuredClone(fn);
      state.draft.doc.layout = next;
      validateStudioDoc(state.draft.doc);
    },
    patchItem: (id, patch) => {
      const item = state.draft.doc.layout.items.find((i) => i.id === id);
      if (!item) throw new Error('STUDIO_ITEM_NOT_FOUND');
      if (item.locked) throw new Error('STUDIO_LOCKED');
      Object.assign(item, structuredClone(patch));
      validateStudioDoc(state.draft.doc);
    },
    select: (id, append = false, within = false) => {
      if (!append) state.selected = [id];
      else if (!state.selected.includes(id)) state.selected = [...state.selected, id];
    },
    beginGesture: () => { gestures++; },
    endGesture: (cancel = false) => { gestures--; if (cancel) cancelledGestures++; },
    dispose: () => { disposed = true; },
  };
  return {
    state,
    model,
    getGestures: () => gestures,
    getCancelled: () => cancelledGestures,
    isDisposed: () => disposed,
  };
}

function eventAt(x = 100, y = 100, extra = {}) {
  return { button: 0, pointerId: 1, clientX: x, clientY: y, preventDefault() {}, stopPropagation() {}, ...extra };
}
function domRect(width = 650, height = 650) {
  return { getBoundingClientRect: () => ({ left: 10, top: 20, width, height }),
    setPointerCapture() {}, releasePointerCapture() {}, focus() {} };
}
const byLabel = (tree, label) => nodes(tree).find(n => n.props['aria-label'] === label);
const byItem = (tree, id, attr = 'data-camera-item') => nodes(tree).find(n => n.props[attr] === id);
const clickLabel = (tree, label) => nodes(tree).find(n => n.type === 'button' && n.children.includes(label)).props.onClick();

async function realEnv(layout = makeScene()) {
  const calls = [];
  const model = createStudioModel({ request: async action => {
    calls.push(action);
    assert.equal(action, 'studioGetPage', 'Director must not invoke generation, LLM, GPU, compile or save RPCs');
    return { page_id: 'p', series_id: 's', revision: 1, title: 'P', proposals: [],
      doc: { kind: 'layout', layout: structuredClone(layout), caption: { caption: '' } } };
  } });
  await model.open('p');
  model.select(layout.items[0].id);
  const harness = createStatefulHarness(), Director = createStudioCameraView(harness.React);
  return { model, calls, harness, render: props => harness.render(Director, { model, state: model.getSnapshot(), ...props }) };
}

test('follow toggle, keepSize toggle, retarget selected, recapture current, and visible goal crosshair work without mutating on render', () => {
  const harness = createStatefulHarness();
  const Director = createStudioCameraView(harness.React);
  const env = createMockEnv(makeScene([
    makeBox('hero', [320, 260, 620, 760]),
    makeBox('prop', [680, 420, 860, 680], { label: 'object', body: { z: 1.8, thickness: 0.25, yaw: 0, anchor: 'world' } }),
  ]), ['hero']);

  const beforeRender = JSON.stringify(env.state.draft.doc);
  let tree = harness.render(Director, { model: env.model, state: env.state });
  assert.equal(JSON.stringify(env.state.draft.doc), beforeRender, 'render must not mutate document');

  let all = nodes(tree);
  const followToggle = all.find((n) => n.type === 'input' && n.props['aria-label'] === '跟随主体');
  assert.ok(followToggle, 'expected 跟随主体 checkbox');
  assert.equal(followToggle.props.checked, false);

  // Enable follow -> captures selected 'hero' and renders crosshair
  followToggle.props.onChange({ target: { checked: true } });
  tree = harness.render(Director, { model: env.model, state: env.state });
  all = nodes(tree);
  assert.ok(all.find((n) => n.props['data-follow-crosshair']), 'expected visible follow crosshair when follow is active');

  // Orbit change with follow + keepSize keeps hero center & size
  const beforeHero = projectStudioLayout(env.state.draft.doc.layout).items.hero.raw;
  const beforeCenter = [(beforeHero[0] + beforeHero[2]) / 2, (beforeHero[1] + beforeHero[3]) / 2];
  const beforeSize = Math.sqrt((beforeHero[2] - beforeHero[0]) * (beforeHero[3] - beforeHero[1]));

  const orbitInput = all.find((n) => n.props['aria-label'] === '相机 环绕');
  orbitInput.props.onChange({ target: { value: '30' } });
  tree = harness.render(Director, { model: env.model, state: env.state });

  const afterHero = projectStudioLayout(env.state.draft.doc.layout).items.hero.raw;
  const afterCenter = [(afterHero[0] + afterHero[2]) / 2, (afterHero[1] + afterHero[3]) / 2];
  const afterSize = Math.sqrt((afterHero[2] - afterHero[0]) * (afterHero[3] - afterHero[1]));
  assert.ok(Math.hypot(afterCenter[0] - beforeCenter[0], afterCenter[1] - beforeCenter[1]) < 0.1);
  assert.ok(Math.abs(afterSize - beforeSize) < 0.2);

  // Toggle keepSize off -> changing distance keeps center while changing size
  all = nodes(tree);
  const keepSizeToggle = all.find((n) => n.type === 'input' && n.props['aria-label'] === '保持画面占比');
  assert.ok(keepSizeToggle);
  keepSizeToggle.props.onChange({ target: { checked: false } });
  tree = harness.render(Director, { model: env.model, state: env.state });

  all = nodes(tree);
  const distInput = all.find((n) => n.props['aria-label'] === '相机 距离');
  distInput.props.onChange({ target: { value: '1.8' } });
  tree = harness.render(Director, { model: env.model, state: env.state });
  assert.equal(env.state.draft.doc.layout.camera.distance, 1.8);
  const zoomed = projectStudioLayout(env.state.draft.doc.layout).items.hero.raw;
  assert.ok(Math.hypot((zoomed[0] + zoomed[2]) / 2 - beforeCenter[0], (zoomed[1] + zoomed[3]) / 2 - beforeCenter[1]) < .1);
  assert.ok(Math.abs(Math.sqrt((zoomed[2] - zoomed[0]) * (zoomed[3] - zoomed[1])) - beforeSize) > 20);

  // Retarget to selected 'prop'
  env.state.selected = ['prop'];
  tree = harness.render(Director, { model: env.model, state: env.state });
  all = nodes(tree);
  const retargetBtn = all.find((n) => n.type === 'button' && n.children.includes('改跟选中'));
  assert.ok(retargetBtn);
  retargetBtn.props.onClick();
  tree = harness.render(Director, { model: env.model, state: env.state });
  all = nodes(tree);
  const crosshair = all.find((n) => n.props['data-follow-crosshair']);
  assert.equal(crosshair.props['data-follow-ids'], 'prop');

  // Recapture current button updates goal metrics
  const recaptureBtn = all.find((n) => n.type === 'button' && n.children.includes('重捕当前构图'));
  assert.ok(recaptureBtn);
  recaptureBtn.props.onClick();
  tree = harness.render(Director, { model: env.model, state: env.state });
  const previousGoal = nodes(tree).find(n => n.props['data-follow-crosshair']).props['data-follow-cx'];
  byLabel(tree, '相机 横移').props.onChange({ target: { value: '.2' } });
  tree = harness.render(Director, { model: env.model, state: env.state });
  const manualGoal = nodes(tree).find(n => n.props['data-follow-crosshair']);
  assert.notEqual(manualGoal.props['data-follow-cx'], previousGoal, 'manual pan recaptures rather than fighting follow');
  const liveProp = projectStudioLayout(env.state.draft.doc.layout).items.prop.raw;
  assert.ok(Math.abs(manualGoal.props['data-follow-cx'] - (liveProp[0] + liveProp[2]) / 2) < .01);

  byLabel(tree, '启用3D相机').props.onChange({ target: { checked: false } });
  tree = harness.render(Director, { model: env.model, state: env.state });
  assert.equal(nodes(tree).some(n => n.props['data-follow-crosshair']), false);
  env.state.selected = [];
  byLabel(tree, '跟随主体').props.onChange({ target: { checked: true } });
  tree = harness.render(Director, { model: env.model, state: env.state });
  assert.equal(nodes(tree).find(n => n.props['data-follow-crosshair']).props['data-follow-ids'], 'hero', 'empty selection captures default character');
  env.state.draft.doc.layout.items[0].hidden = true;
  byLabel(tree, '相机 环绕').props.onChange({ target: { value: '5' } });
  tree = harness.render(Director, { model: env.model, state: env.state });
  assert.equal(nodes(tree).some(n => n.props['data-follow-crosshair']), false);
  assert.ok(nodes(tree).some(n => n.props.role === 'alert' && /跟随/.test(n.children.join(''))), 'lost targets are visibly released');
});

test('presets (13), autoFrame modes (5), readout, and stage overlays (mask, thirds, safe 90%, wireframe, horizon/vp) work', () => {
  const harness = createStatefulHarness();
  const Director = createStudioCameraView(harness.React);
  const env = createMockEnv(makeScene([
    makeBox('hero', [350, 280, 650, 760]),
    makeBox('prop', [700, 440, 880, 680], { label: 'object', body: { z: 1.8, thickness: 0.25, yaw: 0, anchor: 'world' } }),
  ], { pitch: 15, orbit: 20 }));

  let tree = harness.render(Director, { model: env.model, state: env.state });
  let all = nodes(tree);

  // Readout present
  const readoutNode = all.find((n) => n.props['data-camera-readout']);
  assert.ok(readoutNode, 'expected camera readout');
  assert.match(JSON.stringify(readoutNode), /mm/);

  // 13 preset buttons or select options reachable
  const presetButtons = all.filter((n) => n.props['data-camera-preset']);
  assert.equal(presetButtons.length, 13, 'expected all 13 view presets');
  const birdEye = presetButtons.find((n) => n.props['data-camera-preset'] === 'top-down');
  birdEye.props.onClick();
  assert.equal(env.state.draft.doc.layout.camera.pitch, 78);

  // 5 autoFrame modes
  tree = harness.render(Director, { model: env.model, state: env.state });
  all = nodes(tree);
  const frameModeSelect = all.find((n) => n.props['aria-label'] === '自动取景模式');
  assert.ok(frameModeSelect, 'expected 自动取景模式 select');
  assert.equal(frameModeSelect.children.length, 5);

  frameModeSelect.props.onChange({ target: { value: 'center' } });
  tree = harness.render(Director, { model: env.model, state: env.state });
  all = nodes(tree);
  const autoFrameBtn = all.find((n) => n.type === 'button' && n.children.includes('自动取景'));
  autoFrameBtn.props.onClick();
  const centeredHero = projectStudioLayout(env.state.draft.doc.layout).items.hero.raw;
  assert.ok(Math.hypot((centeredHero[0] + centeredHero[2]) / 2 - 512, (centeredHero[1] + centeredHero[3]) / 2 - 512) < 1);

  // Stage overlay toggles: mask, thirds, safe90, wireframe, horizon/vp
  tree = harness.render(Director, { model: env.model, state: env.state });
  all = nodes(tree);
  for (const label of ['画外遮罩', '三分线', '90%安全框', '体块线框', '地平线与灭点']) {
    const toggle = all.find((n) => n.type === 'input' && n.props['aria-label'] === label);
    assert.ok(toggle, `expected overlay toggle ${label}`);
  }
  const docBeforeOverlays = JSON.stringify(env.state.draft.doc);
  for (const [label, attr] of [['画外遮罩', 'data-stage-mask'], ['三分线', 'data-stage-thirds'], ['90%安全框', 'data-stage-safe']]) {
    byLabel(tree, label).props.onChange({ target: { checked: true } });
    tree = harness.render(Director, { model: env.model, state: env.state });
    assert.ok(nodes(tree).some(n => n.props[attr]), `${label} visibly changes stage geometry`);
  }
  assert.ok(nodes(tree).some(n => n.props['data-cube-edge']));
  byLabel(tree, '体块线框').props.onChange({ target: { checked: false } });
  byLabel(tree, '地平线与灭点').props.onChange({ target: { checked: false } });
  tree = harness.render(Director, { model: env.model, state: env.state });
  assert.equal(nodes(tree).some(n => n.props['data-cube-edge'] || n.props['data-stage-horizon'] || n.props['data-stage-vp']), false);
  assert.equal(JSON.stringify(env.state.draft.doc), docBeforeOverlays);

  // Inputs reject blank, NaN and schema-out-of-range values atomically, never clamp them silently.
  for (const bad of ['', 'Infinity', '181']) {
    byLabel(tree, '相机 环绕').props.onChange({ target: { value: bad } });
    tree = harness.render(Director, { model: env.model, state: env.state });
    assert.equal(JSON.stringify(env.state.draft.doc), docBeforeOverlays);
    assert.ok(nodes(tree).some(n => n.props.role === 'alert'));
  }
  const rh = createStatefulHarness(), RebaseView = createStudioCameraView(rh.React);
  const re = createMockEnv(makeScene([makeBox('hero')], { orbit: 15, distance: 1.2 }));
  const projectedBefore = projectStudioLayout(re.state.draft.doc.layout).items.hero.bbox;
  const previousConfirm = globalThis.confirm;
  try {
    globalThis.confirm = () => true;
    clickLabel(rh.render(RebaseView, { model: re.model, state: re.state }), '定为基准');
    assert.equal(re.state.draft.doc.layout.camera.enabled, true, 'rebase keeps the helper enabled identity camera contract');
    assert.equal(re.state.draft.doc.layout.camera.orbit, 0);
    assert.ok(re.state.draft.doc.layout.items[0].bbox.every((v, i) => Math.abs(v - projectedBefore[i]) < .01));
  } finally {
    if (previousConfirm === undefined) delete globalThis.confirm;
    else globalThis.confirm = previousConfirm;
  }
});

test('FreeCam pointer drag (rotate, Shift/middle/right pan, wheel distance, Alt+wheel FOV) and body move hold fixed vs subject + end recapture', async () => {
  const harness = createStatefulHarness();
  const Director = createStudioCameraView(harness.React);
  const env = createMockEnv(makeScene([
    makeBox('hero', [360, 280, 620, 760]),
    makeBox('bg', [150, 200, 320, 700], { label: 'object', locked: true, body: { z: 2.5, thickness: 0.2, yaw: 0, anchor: 'world' } }),
  ], { orbit: 175, pitch: 80, distance: 1.2 }));

  let tree = harness.render(Director, { model: env.model, state: env.state });
  let all = nodes(tree);
  let svg = all.find((n) => n.props['aria-label'] === '3D镜头调度画布');
  const dom = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 650, height: 650 }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
    focus: () => {},
  };

  // 1. Empty drag rotates camera: orbit wraps across ±180, pitch clamps at ±85
  svg.props.onPointerDown({ button: 0, pointerId: 1, clientX: 100, clientY: 100, currentTarget: dom, preventDefault() {}, stopPropagation() {} });
  svg.props.onPointerMove({ clientX: 140, clientY: 60 });
  svg.props.onPointerUp({ pointerId: 1 });
  assert.ok(env.state.draft.doc.layout.camera.orbit < -160, 'orbit should wrap past +180 to negative');
  assert.equal(env.state.draft.doc.layout.camera.pitch, 85, 'pitch should clamp at 85');
  assert.equal(env.getGestures(), 0);

  // 2. Shift drag (or middle button) pans camera
  const beforePanX = env.state.draft.doc.layout.camera.pan_x ?? 0;
  svg.props.onPointerDown({ button: 0, shiftKey: true, pointerId: 2, clientX: 200, clientY: 200, currentTarget: dom, preventDefault() {}, stopPropagation() {} });
  svg.props.onPointerMove({ clientX: 250, clientY: 180 });
  svg.props.onPointerUp({ pointerId: 2 });
  assert.notEqual(env.state.draft.doc.layout.camera.pan_x, beforePanX);

  // 3. Wheel adjusts distance, Alt+wheel adjusts FOV
  const beforeDist = env.state.draft.doc.layout.camera.distance;
  svg.props.onWheel({ deltaY: 100, altKey: false, preventDefault() {}, stopPropagation() {} });
  assert.ok(env.state.draft.doc.layout.camera.distance > beforeDist);
  const beforeFov = env.state.draft.doc.layout.camera.fov ?? 50;
  svg.props.onWheel({ deltaY: 100, altKey: true, preventDefault() {}, stopPropagation() {} });
  assert.ok(env.state.draft.doc.layout.camera.fov > beforeFov);

  // 4. Body movement with camera follow toggle + active follow goal recaptures goal on drag end
  tree = harness.render(Director, { model: env.model, state: env.state });
  all = nodes(tree);
  const followToggle = all.find((n) => n.type === 'input' && n.props['aria-label'] === '跟随主体');
  followToggle.props.onChange({ target: { checked: true } });
  const modeSelect = all.find((n) => n.props['aria-label'] === '镜头操作模式');
  modeSelect.props.onChange({ target: { value: 'bodies' } });

  tree = harness.render(Director, { model: env.model, state: env.state });
  all = nodes(tree);
  svg = all.find((n) => n.props['aria-label'] === '3D镜头调度画布');
  const itemNode = all.find((n) => n.props['data-camera-item'] === 'hero');
  const beforeGoalCrosshair = all.find((n) => n.props['data-follow-crosshair']);
  const startCx = Number(beforeGoalCrosshair.props['data-follow-cx']);

  itemNode.props.onPointerDown({ button: 0, pointerId: 3, clientX: 300, clientY: 300, currentTarget: { ownerSVGElement: dom }, preventDefault() {}, stopPropagation() {} });
  svg.props.onPointerMove({ clientX: 340, clientY: 310 });
  svg.props.onPointerUp({ pointerId: 3 });

  tree = harness.render(Director, { model: env.model, state: env.state });
  all = nodes(tree);
  const afterGoalCrosshair = all.find((n) => n.props['data-follow-crosshair']);
  assert.ok(Math.abs(Number(afterGoalCrosshair.props['data-follow-cx']) - startCx) > 5, 'body drag end should recapture follow goal to new position');

  // Real Session model: all drag frames are ONE undo, cancellation rolls back,
  // unmount ends only owned gestures, and the sphere never moves bodies.
  const r = await realEnv(makeScene([makeBox('hero')], { orbit: 10, distance: 1.2 }));
  let rt = r.render(), stage = byLabel(rt, '3D镜头调度画布');
  const rd = domRect(), original = structuredClone(r.model.getSnapshot().draft.doc);
  stage.props.onPointerDown(eventAt(100, 100, { currentTarget: rd }));
  stage.props.onPointerMove(eventAt(120, 110));
  rt = r.render(); stage = byLabel(rt, '3D镜头调度画布');
  stage.props.onPointerMove(eventAt(140, 120));
  stage.props.onPointerUp(eventAt());
  assert.equal(r.model.getSnapshot().undo.length, 1);
  r.model.undo();
  assert.deepEqual(r.model.getSnapshot().draft.doc, original);
  rt = r.render(); stage = byLabel(rt, '3D镜头调度画布');
  stage.props.onPointerDown(eventAt(100, 100, { currentTarget: rd }));
  stage.props.onPointerMove(eventAt(150, 130));
  stage.props.onPointerCancel(eventAt());
  assert.deepEqual(r.model.getSnapshot().draft.doc, original);
  assert.equal(r.model.getSnapshot().gestureActive, false);
  stage.props.onPointerDown(eventAt(100, 100, { currentTarget: rd }));
  stage.props.onPointerMove(eventAt(150, 130));
  stage.props.onLostPointerCapture(eventAt());
  assert.deepEqual(r.model.getSnapshot().draft.doc, original);

  byLabel(rt, '镜头操作模式').props.onChange({ target: { value: 'bodies' } });
  rt = r.render();
  const bodiesBefore = structuredClone(r.model.getSnapshot().draft.doc.layout.items);
  const sphere = byLabel(rt, '镜头旋转球');
  assert.ok(sphere, 'camera sphere remains available in bodies mode');
  sphere.props.onPointerDown(eventAt(50, 50, { currentTarget: domRect(120, 120) }));
  sphere.props.onPointerMove(eventAt(80, 30));
  sphere.props.onPointerUp(eventAt());
  assert.equal(r.model.getSnapshot().draft.doc.layout.camera.orbit, 19);
  assert.equal(r.model.getSnapshot().draft.doc.layout.camera.pitch, 6);
  assert.deepEqual(r.model.getSnapshot().draft.doc.layout.items, bodiesBefore);
  assert.equal(r.model.getSnapshot().undo.length, 1);

  // A gesture begun elsewhere in the Session must never be claimed by Director.
  r.model.beginGesture();
  rt = r.render(); stage = byLabel(rt, '3D镜头调度画布');
  const foreignBefore = structuredClone(r.model.getSnapshot().draft.doc);
  stage.props.onPointerDown(eventAt(10, 10, { currentTarget: rd }));
  stage.props.onPointerMove(eventAt(80, 40));
  stage.props.onPointerUp(eventAt());
  assert.equal(r.model.getSnapshot().gestureActive, true, 'do not end a foreign Session gesture');
  assert.deepEqual(r.model.getSnapshot().draft.doc, foreignBefore);
  r.model.endGesture(true);

  // Native non-passive listeners prevent scroll; React fallback sees same event only once.
  const w = await realEnv(); let wt = w.render();
  let nativeWheel, removed = 0, prevented = 0;
  const wd = { ...domRect(), addEventListener(type, fn, options) {
    assert.equal(type, 'wheel'); assert.equal(options.passive, false); nativeWheel = fn;
  }, removeEventListener(type, fn) { assert.equal(type, 'wheel'); assert.equal(fn, nativeWheel); removed++; } };
  const ws = byLabel(wt, '3D镜头调度画布'); ws.props.ref.current = wd;
  const cleanups = w.harness.runEffects();
  const native = { deltaY: 100, target: { tagName: 'svg' }, preventDefault() { prevented++; }, stopPropagation() {} };
  nativeWheel(native);
  const onceDistance = w.model.getSnapshot().draft.doc.layout.camera.distance;
  ws.props.onWheel({ ...native, nativeEvent: native });
  assert.equal(w.model.getSnapshot().draft.doc.layout.camera.distance, onceDistance);
  assert.equal(prevented, 1);
  ws.props.onPointerDown(eventAt(100, 100, { currentTarget: wd }));
  ws.props.onPointerMove(eventAt(140, 100));
  cleanups.forEach(fn => fn());
  assert.equal(removed, 1);
  assert.equal(w.model.getSnapshot().gestureActive, false);
  assert.equal(w.model.getSnapshot().draft.doc.layout.camera.orbit, 0, 'unmount rolls back own unfinished gesture');
  w.model.patchCamera({ orbit: 5 }); // Session remains usable; Director does not dispose it.
  assert.deepEqual(w.calls, ['studioGetPage']);

  // Subject hold physically follows a moved default subject; fixed hold does not.
  for (const holdMode of ['fixed', 'subject']) {
    const b = await realEnv(makeScene([makeBox('hero', [350, 250, 650, 750], { body: { z: 1.5, thickness: 0, yaw: 0, anchor: 'world' } })], { orbit: 10, distance: 1.2 }));
    let bt = b.render();
    byLabel(bt, '镜头操作模式').props.onChange({ target: { value: 'bodies' } });
    byLabel(bt, '体块移动机位').props.onChange({ target: { value: holdMode } });
    bt = b.render();
    const l0 = b.model.getSnapshot().draft.doc.layout;
    const cam0 = studioCameraFrame(l0).position, raw0 = projectStudioLayout(l0).items.hero.raw;
    byItem(bt, 'hero').props.onPointerDown(eventAt(200, 200, { currentTarget: { ownerSVGElement: rd } }));
    const bs = byLabel(bt, '3D镜头调度画布');
    bs.props.onPointerMove(eventAt(230, 210)); bs.props.onPointerUp(eventAt());
    const l1 = b.model.getSnapshot().draft.doc.layout;
    const cam1 = studioCameraFrame(l1).position, raw1 = projectStudioLayout(l1).items.hero.raw;
    assert.notDeepEqual(l1.items[0].bbox, l0.items[0].bbox);
    const cameraDelta = Math.hypot(...cam1.map((v, i) => v - cam0[i]));
    if (holdMode === 'fixed') assert.ok(cameraDelta < 1e-8);
    else {
      assert.ok(cameraDelta > .01);
      assert.ok(Math.hypot(...raw1.map((v, i) => v - raw0[i])) < .1);
    }
    assert.deepEqual(b.calls, ['studioGetPage']);
  }
  // Mixed screen/backdrop selection uses visual movement rather than world-only no-op.
  const mixed = await realEnv(makeScene([
    makeBox('hero'),
    makeBox('title', [100, 100, 300, 150], { label: 'text', text: 'Title', group: 'ui', body: { z: 1, thickness: 0, yaw: 0, anchor: 'screen' } }),
    makeBox('backdrop', [100, 200, 900, 900], { label: 'object', group: 'ui', body: { z: 3, thickness: 0, yaw: 0, anchor: 'backdrop' } }),
    makeBox('locked', [50, 50, 80, 80], { locked: true }),
  ], { orbit: 20 }));
  mixed.model.select('title');
  let mt = mixed.render();
  byLabel(mt, '镜头操作模式').props.onChange({ target: { value: 'bodies' } });
  mt = mixed.render();
  const ms = byLabel(mt, '3D镜头调度画布'), md = domRect(600, 330);
  const mixedBefore = structuredClone(mixed.model.getSnapshot().draft.doc.layout);
  byItem(mt, 'title').props.onPointerDown(eventAt(100, 100, { altKey: true, currentTarget: { ownerSVGElement: md } }));
  ms.props.onPointerMove(eventAt(130, 130)); ms.props.onPointerUp(eventAt());
  const mixedAfter = mixed.model.getSnapshot().draft.doc.layout;
  assert.ok(Math.abs(mixedAfter.items[1].bbox[0] - 100 - 30 * 1024 * 1.3 / 330) < .001);
  assert.equal(mixedAfter.items[1].bbox[0] - 100, mixedAfter.items[1].bbox[1] - 100);
  assert.deepEqual(mixedAfter.items[0], mixedBefore.items[0]);
  assert.deepEqual(mixedAfter.items[2], mixedBefore.items[2]);
  assert.deepEqual(mixedAfter.items[3], mixedBefore.items[3]);
});

test('interactive Top SVG draws camera icon, pivot, FOV wedge, far line, and supports camera XZ click/drag and body XZ drag with frozen pointerdown transform', async () => {
  const harness = createStatefulHarness();
  const Director = createStudioCameraView(harness.React);
  const env = createMockEnv(makeScene([
    makeBox('hero', [350, 280, 650, 760], { body: { z: 1.5, thickness: 0.3, yaw: 0, anchor: 'world' } }),
  ], { orbit: 0, pitch: 10, distance: 1.2 }));

  let tree = harness.render(Director, { model: env.model, state: env.state });
  let all = nodes(tree);
  let topSvg = all.find((n) => n.props['aria-label'] === '体块俯视图');
  assert.ok(topSvg);
  assert.ok(all.find((n) => n.props['data-top-camera']), 'expected top camera icon');
  assert.ok(all.find((n) => n.props['data-top-pivot']), 'expected top pivot marker');
  assert.ok(all.find((n) => n.props['data-top-fov-wedge']), 'expected horizontal FOV wedge');
  assert.ok(all.find((n) => n.props['data-top-far-line']), 'expected far line');

  const topDom = {
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 640, height: 380 }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  };

  // 1. Camera mode click/drag in top view updates orbit and distance
  topSvg.props.onPointerDown({ button: 0, pointerId: 10, clientX: 450, clientY: 60, currentTarget: topDom, preventDefault() {}, stopPropagation() {} });
  topSvg.props.onPointerMove({ clientX: 480, clientY: 50 });
  topSvg.props.onPointerUp({ pointerId: 10 });
  assert.ok(env.state.draft.doc.layout.camera.orbit > 10, 'dragging right in top view updates positive orbit');
  assert.equal(env.getGestures(), 0);

  // 2. Body mode drag on block in top view translates item world XZ via translateStudioItems
  tree = harness.render(Director, { model: env.model, state: env.state });
  all = nodes(tree);
  const modeSelect = all.find((n) => n.props['aria-label'] === '镜头操作模式');
  modeSelect.props.onChange({ target: { value: 'bodies' } });

  tree = harness.render(Director, { model: env.model, state: env.state });
  all = nodes(tree);
  topSvg = all.find((n) => n.props['aria-label'] === '体块俯视图');
  const topBlock = all.find((n) => n.props['data-top-item'] === 'hero');
  assert.ok(topBlock, 'expected top view item block');
  const zBefore = env.state.draft.doc.layout.items[0].body.z;

  topBlock.props.onPointerDown({ button: 0, pointerId: 11, clientX: 330, clientY: 160, currentTarget: { ownerSVGElement: topDom }, preventDefault() {}, stopPropagation() {} });
  topSvg.props.onPointerMove({ clientX: 360, clientY: 220 });
  topSvg.props.onPointerUp({ pointerId: 11 });

  const zAfter = env.state.draft.doc.layout.items[0].body.z;
  assert.ok(zAfter > zBefore, 'dragging down (+Z) in top view increases item depth z');

  const r = await realEnv(makeScene([
    makeBox('hero', [350, 280, 650, 760], { group: 'g', body: { z: 1.5, thickness: .3, yaw: 0, anchor: 'world' } }),
    makeBox('prop', [700, 400, 900, 600], { label: 'object', group: 'g', body: { z: 2, thickness: .2, yaw: 0, anchor: 'world' } }),
  ], { orbit: 20, pitch: 10, distance: 1.2 }));
  let rt = r.render(), ts = byLabel(rt, '体块俯视图');
  const cameraIcon = nodes(rt).find(n => n.props['data-top-camera']);
  const coords = cameraIcon.props.transform.match(/translate\(([-.\d]+),([-.\d]+)\)/).slice(1).map(Number);
  const td = domRect(800, 380); // viewBox 320x190 is letterboxed by 80 CSS px left/right
  ts.props.onPointerDown(eventAt(90 + coords[0] * 2, 20 + coords[1] * 2, { currentTarget: td }));
  ts.props.onPointerUp(eventAt());
  assert.ok(Math.abs(r.model.getSnapshot().draft.doc.layout.camera.orbit - 20) < .01, 'absolute XZ click accounts for meet offsets');
  assert.ok(Math.abs(r.model.getSnapshot().draft.doc.layout.camera.distance - 1.2) < .001);

  byLabel(rt, '镜头操作模式').props.onChange({ target: { value: 'bodies' } });
  rt = r.render(); ts = byLabel(rt, '体块俯视图');
  const base = nodes(rt).find(n => n.props['data-top-base']);
  const pivot = nodes(rt).find(n => n.props['data-top-pivot']);
  const worldScale = (pivot.props.cy - base.props.cy) / 1.5;
  const before = structuredClone(r.model.getSnapshot().draft.doc.layout.items);
  const f0 = 512 / Math.tan(25 * Math.PI / 180);
  const oldX = ((before[0].bbox[0] + before[0].bbox[2]) / 2 - 512) * 1.5 / f0;
  const tb = byItem(rt, 'hero', 'data-top-item');
  tb.props.onPointerDown(eventAt(330, 160, { altKey: true, currentTarget: { ownerSVGElement: td } }));
  ts.props.onPointerMove(eventAt(360, 220));
  rt = r.render(); ts = byLabel(rt, '体块俯视图');
  td.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1600, height: 760 });
  ts.props.onPointerMove(eventAt(390, 280));
  ts.props.onPointerUp(eventAt());
  const after = r.model.getSnapshot().draft.doc.layout.items;
  assert.ok(Math.abs(after[0].body.z - (1.5 + 120 * .5 / worldScale)) < 1e-7, 'two moves retain pointerdown world and SVG transforms');
  const newX = ((after[0].bbox[0] + after[0].bbox[2]) / 2 - 512) * after[0].body.z / f0;
  assert.ok(Math.abs(newX - oldX - 60 * .5 / worldScale) < 1e-7);
  assert.deepEqual(after[1], before[1], 'Alt top drag leaves sibling untouched');
  tb.props.onClick?.(eventAt(390, 280, { altKey: true }));
  assert.deepEqual(r.model.getSnapshot().selected, ['hero'], 'post-drag click must not expand Alt selection back to the group');
});

test('out-of-frame list offers select, autoFrame, and returnIntoView while preserving locks; explicit estimate and align depth buttons work', async () => {
  const harness = createStatefulHarness();
  const Director = createStudioCameraView(harness.React);
  const env = createMockEnv(makeScene([
    makeBox('hero', [200, 200, 600, 900], { body: { z: 2.0, thickness: 0.45, yaw: 0, anchor: 'world' } }),
    makeBox('badge', [280, 350, 360, 430], { label: 'object', body: { z: 5.0, thickness: 0.3, yaw: 0, anchor: 'world' } }),
    makeBox('lost', [2400, 1800, 2700, 2200], { label: 'object', body: { z: 2.2, thickness: 0.3, yaw: 0, anchor: 'world' } }),
    makeBox('lockedItem', [100, 100, 250, 300], { label: 'object', locked: true, body: { z: 3.5, thickness: 0.4, yaw: 15, anchor: 'world' } }),
  ], { orbit: 15, distance: 1.2 }), ['hero', 'badge']);

  let tree = harness.render(Director, { model: env.model, state: env.state });
  let all = nodes(tree);

  // Out-of-frame item 'lost' has select, autoFrame ('为此项取景'), and returnIntoView ('移回视野')
  const selectLostBtn = all.find((n) => n.type === 'button' && n.props['data-oof-select'] === 'lost');
  const frameLostBtn = all.find((n) => n.type === 'button' && n.props['data-oof-frame'] === 'lost');
  const returnLostBtn = all.find((n) => n.type === 'button' && n.props['data-oof-return'] === 'lost');
  assert.ok(selectLostBtn && frameLostBtn && returnLostBtn);

  selectLostBtn.props.onClick();
  assert.deepEqual(env.state.selected, ['lost']);

  const beforeCamFrame = studioCameraFrame(env.state.draft.doc.layout);
  returnLostBtn.props.onClick();
  const afterCamFrame = studioCameraFrame(env.state.draft.doc.layout);
  assert.ok(Math.hypot(
    afterCamFrame.position[0] - beforeCamFrame.position[0],
    afterCamFrame.position[1] - beforeCamFrame.position[1],
    afterCamFrame.position[2] - beforeCamFrame.position[2],
  ) < 1e-4, 'returnIntoView must keep physical camera fixed');
  assert.equal(projectStudioLayout(env.state.draft.doc.layout).items.lost.visible, true);

  // Align selected depth button aligns 'badge' to overlapping 'hero'
  env.state.selected = ['hero', 'badge'];
  tree = harness.render(Director, { model: env.model, state: env.state });
  all = nodes(tree);
  const alignBtn = all.find((n) => n.type === 'button' && n.children.includes('对齐选中景深'));
  assert.ok(alignBtn);
  alignBtn.props.onClick();
  const badgeAfterAlign = env.state.draft.doc.layout.items.find((i) => i.id === 'badge');
  assert.equal(badgeAfterAlign.body.z, 1.94);

  // Explicit Estimate button uses estimateStudioLayoutBodies({onlyMissing:false}) and preserves lockedItem
  const reestimateAllBtn = all.find((n) => n.type === 'button' && n.children.includes('重估全部体块'));
  assert.ok(reestimateAllBtn);
  reestimateAllBtn.props.onClick();
  const lockedAfter = env.state.draft.doc.layout.items.find((i) => i.id === 'lockedItem');
  assert.equal(lockedAfter.body.z, 3.5);
  assert.equal(lockedAfter.body.yaw, 15);

  const r = await realEnv(makeScene([
    makeBox('pivot', [300, 300, 700, 700], { locked: true, body: { z: 1, thickness: .2, yaw: 0, anchor: 'world' } }),
    makeBox('target', [2500, 2500, 2700, 2700], { label: 'object', body: { z: 1, thickness: .2, yaw: 0, anchor: 'world' } }),
    makeBox('hidden', [3000, 3000, 3200, 3200], { hidden: true }),
  ], { orbit: 180, distance: 1, pan_z: -12 }));
  let rt = r.render();
  assert.equal(nodes(rt).some(n => n.props['data-oof-return'] === 'hidden'), false, 'hidden objects stay hidden, not return candidates');
  assert.equal(nodes(rt).find(n => n.props['data-oof-return'] === 'pivot').props.disabled, true);
  const beforeFail = structuredClone(r.model.getSnapshot().draft.doc);
  nodes(rt).find(n => n.props['data-oof-return'] === 'target').props.onClick();
  rt = r.render();
  assert.deepEqual(r.model.getSnapshot().draft.doc, beforeFail, 'failed return is atomic through the real model');
  assert.equal(r.model.getSnapshot().undo.length, 0);
  assert.ok(nodes(rt).some(n => n.props.role === 'alert' && /STUDIO_MOVE_UNAVAILABLE/.test(n.children.join(''))), 'Ops errors are visible, not fake-success UI');
  assert.deepEqual(r.calls, ['studioGetPage']);
});

test('createStudioBodyInspector displays default legacy studioBody without mutating, edits z/thickness/yaw(±360)/anchor, re-estimates single item, and disables when locked', () => {
  const harness = createStatefulHarness();
  assert.equal(typeof createStudioBodyInspector, 'function');
  const Inspector = createStudioBodyInspector(harness.React);

  const unlockedNoBody = { id: 'char1', name: 'Hero', label: 'character', caption: 'hero', bbox: [300, 200, 500, 850] };
  const env = createMockEnv(makeScene([unlockedNoBody]), ['char1']);

  const beforeSnap = JSON.stringify(env.state.draft.doc);
  let tree = harness.render(Inspector, { model: env.model, state: env.state, item: env.state.draft.doc.layout.items[0] });
  assert.equal(JSON.stringify(env.state.draft.doc), beforeSnap, 'inspector render must not mutate item without explicit body');

  let all = nodes(tree);
  const yawInput = all.find((n) => n.props['aria-label'] === '体块 朝向');
  assert.ok(yawInput);
  assert.equal(yawInput.props.min, -360);
  assert.equal(yawInput.props.max, 360);

  // Edit yaw to 270 (full ±360 schema)
  yawInput.props.onChange({ target: { value: '270' } });
  assert.equal(env.state.draft.doc.layout.items[0].body.yaw, 270);

  // Single explicit re-estimate button uses estimateStudioBody
  tree = harness.render(Inspector, { model: env.model, state: env.state, item: env.state.draft.doc.layout.items[0] });
  all = nodes(tree);
  const reestBtn = all.find((n) => n.type === 'button' && n.children.includes('重估此项体块'));
  assert.ok(reestBtn);
  reestBtn.props.onClick();
  assert.equal(env.state.draft.doc.layout.items[0].body.yaw, 0);
  tree = harness.render(Inspector, { model: env.model, state: env.state, item: env.state.draft.doc.layout.items[0] });
  byLabel(tree, '体块 远近').props.onChange({ target: { value: '2' } });
  byLabel(tree, '体块 厚度').props.onChange({ target: { value: '.7' } });
  byLabel(tree, '体块 锚定').props.onChange({ target: { value: 'screen' } });
  assert.deepEqual(env.state.draft.doc.layout.items[0].body, { z: 2, thickness: .7, yaw: 0, anchor: 'screen' });
  const beforeInvalid = JSON.stringify(env.state.draft.doc);
  byLabel(tree, '体块 朝向').props.onChange({ target: { value: '361' } });
  assert.equal(JSON.stringify(env.state.draft.doc), beforeInvalid);

  // Locked item disables all controls
  const lockedItem = { ...env.state.draft.doc.layout.items[0], locked: true };
  tree = harness.render(Inspector, { model: env.model, state: env.state, item: lockedItem });
  all = nodes(tree);
  for (const ctrl of all.filter((n) => ['input', 'select', 'button'].includes(n.type))) {
    assert.equal(ctrl.props.disabled, true);
  }
});

test('keyboard shortcuts handle M/arrows/+/-/A/F/Escape, ignore text inputs, stop propagation, and fullscreen prop toggles class/exit button without disposing model', () => {
  const harness = createStatefulHarness();
  const Director = createStudioCameraView(harness.React);
  const env = createMockEnv(makeScene([makeBox('hero', [350, 280, 650, 760])], { orbit: 0, pitch: 0, distance: 1.0 }));
  let exited = 0;

  let tree = harness.render(Director, { model: env.model, state: env.state, onExit: () => { exited++; }, fullscreen: true });
  assert.match(tree.props.className, /mps-director-fullscreen/);

  const keyHandler = tree.props.onKeyDown;
  assert.equal(typeof keyHandler, 'function');

  // Text entry events are ignored
  let stopped = false;
  keyHandler({
    key: 'm',
    target: { tagName: 'INPUT', closest: (sel) => sel.includes('input') ? {} : null },
    preventDefault() { stopped = true; },
    stopPropagation() { stopped = true; },
  });
  assert.equal(stopped, false);

  // ArrowRight in camera mode adjusts orbit
  keyHandler({
    key: 'ArrowRight',
    target: { tagName: 'SECTION', closest: () => null },
    preventDefault() { stopped = true; },
    stopPropagation() {},
  });
  assert.ok(stopped);
  assert.notEqual(env.state.draft.doc.layout.camera.orbit, 0);

  // '-' increases distance (zoom out), '+' decreases distance (zoom in)
  const d0 = env.state.draft.doc.layout.camera.distance;
  keyHandler({
    key: '-',
    target: { tagName: 'SECTION', closest: () => null },
    preventDefault() {},
    stopPropagation() {},
  });
  assert.ok(env.state.draft.doc.layout.camera.distance > d0);

  // 'M' switches mode to bodies, then ArrowRight moves selected item
  keyHandler({
    key: 'm',
    target: { tagName: 'SECTION', closest: () => null },
    preventDefault() {},
    stopPropagation() {},
  });
  tree = harness.render(Director, { model: env.model, state: env.state, onExit: () => { exited++; }, fullscreen: true });
  const x0 = env.state.draft.doc.layout.items[0].bbox[0];
  tree.props.onKeyDown({
    key: 'ArrowRight',
    target: { tagName: 'SECTION', closest: () => null },
    preventDefault() {},
    stopPropagation() {},
  });
  assert.ok(env.state.draft.doc.layout.items[0].bbox[0] > x0);

  // 'Escape' calls onExit
  tree.props.onKeyDown({
    key: 'Escape',
    target: { tagName: 'SECTION', closest: () => null },
    preventDefault() {},
    stopPropagation() {},
  });
  assert.equal(exited, 1);
  const distanceBeforePlus = env.state.draft.doc.layout.camera.distance;
  tree.props.onKeyDown({ key: '+', target: { tagName: 'SECTION', closest: () => null }, preventDefault() {}, stopPropagation() {} });
  assert.ok(env.state.draft.doc.layout.camera.distance < distanceBeforePlus);
  byLabel(tree, '自动取景模式').props.onChange({ target: { value: 'center' } });
  tree = harness.render(Director, { model: env.model, state: env.state, onExit: () => { exited++; }, fullscreen: true });
  tree.props.onKeyDown({ key: 'a', target: { tagName: 'SECTION', closest: () => null }, preventDefault() {}, stopPropagation() {} });
  const framed = projectStudioLayout(env.state.draft.doc.layout).items.hero.raw;
  assert.ok(Math.hypot((framed[0] + framed[2]) / 2 - 512, (framed[1] + framed[3]) / 2 - 512) < .1);
  tree.props.onKeyDown({ key: 'f', target: { tagName: 'SECTION', closest: () => null }, preventDefault() {}, stopPropagation() {} });
  assert.equal(exited, 2);
  clickLabel(tree, '退出全屏');
  assert.equal(exited, 3);
  for (const target of [{ tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true }, { tagName: 'BUTTON' }]) {
    tree.props.onKeyDown({ key: 'f', target, preventDefault() { assert.fail('must not steal control keys'); }, stopPropagation() { assert.fail('must not stop control keys'); } });
  }
  assert.equal(exited, 3);
  env.state.editingBlocked = true;
  tree = harness.render(Director, { model: env.model, state: env.state });
  const blockedDoc = JSON.stringify(env.state.draft.doc);
  for (const key of ['ArrowRight', '+', 'a']) tree.props.onKeyDown({ key, target: { tagName: 'SECTION' }, preventDefault() {}, stopPropagation() {} });
  assert.equal(JSON.stringify(env.state.draft.doc), blockedDoc);
  assert.equal(byLabel(tree, '相机 环绕').props.disabled, true);

  // Cleanup on unmount does not dispose model
  const cleanups = harness.runEffects();
  cleanups.forEach((fn) => fn());
  assert.equal(env.isDisposed(), false);
});
