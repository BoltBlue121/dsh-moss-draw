import test from 'node:test';
import assert from 'node:assert/strict';
import { studioCameraFrame } from '../src/studio-camera.mjs';
const api = () => import('../client/studio-observer-view.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const nodes = tree => { const all = []; const visit = node => { if (node && typeof node === 'object') { all.push(node); node.children?.forEach(visit); } }; visit(tree); return all; };
function harness() {
  const slots = [], refs = [], effects = []; let cursor = 0, refCursor = 0;
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(c => c !== null && c !== undefined && c !== false) }),
    useState(init) { const i = cursor++; if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init; return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }]; },
    useRef(init) { const i = refCursor++; if (!(i in refs)) refs[i] = { current: init }; return refs[i]; },
    useEffect(fn) { effects.push(fn); },
  };
  return { React, render(Component, props) { cursor = 0; refCursor = 0; return Component(props); }, cleanups() { return effects.map(fn => fn()).filter(fn => typeof fn === 'function'); } };
}
function environment() {
  const state = { page: { page_id: 'page-a', revision: 1 }, editingBlocked: false, draft: { doc: { kind: 'layout', layout: {
    width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: { caption: 'Scene' },
    camera: { enabled: true, orbit: 10, pitch: 5 }, items: [{ id: 'box', label: 'object', bbox: [300, 300, 700, 700], caption: 'Box', body: { z: 1, thickness: .4, yaw: 0, anchor: 'world' } }],
  }, caption: { caption: '' } } } };
  const patches = [], forbidden = [];
  const model = { getSnapshot: () => state, patchCamera: patch => { patches.push(structuredClone(patch)); state.draft.doc.layout.camera = { ...state.draft.doc.layout.camera, ...patch }; },
    beginGesture: () => forbidden.push('beginGesture'), endGesture: () => forbidden.push('endGesture'), takeControl: () => forbidden.push('takeControl'), select: () => forbidden.push('select') };
  return { state, model, patches, forbidden };
}
const dom = () => ({ setPointerCapture() {}, releasePointerCapture() {}, getBoundingClientRect: () => ({ width: 600, height: 360 }), focus() {} });
const event = (x, y, extra = {}) => ({ clientX: x, clientY: y, pointerId: 1, button: 0, currentTarget: dom(), preventDefault() {}, stopPropagation() {}, ...extra });
const find = (tree, label) => nodes(tree).find(n => n.props['aria-label'] === label);
const button = (tree, label) => nodes(tree).find(n => n.type === 'button' && n.children.includes(label));
const lines = tree => nodes(tree).filter(n => n.props['data-observer-edge']).map(n => [n.props.x1, n.props.y1, n.props.x2, n.props.y2]);

test('observer orbit pan and wheel change only local geometry, never doc revision task or model gestures', async () => {
  const { createStudioObserverView } = await api(); assert.equal(typeof createStudioObserverView, 'function');
  const env = environment(), h = harness(), C = createStudioObserverView(h.React), before = structuredClone(env.state);
  let tree = h.render(C, env), svg = find(tree, '独立场景观察视口'), original = lines(tree);
  assert.equal(original.length, 12);
  svg.props.onPointerDown(event(10, 10)); svg.props.onPointerMove(event(80, 40)); svg.props.onPointerUp(event(80, 40));
  tree = h.render(C, env); assert.notDeepEqual(lines(tree), original);
  svg = find(tree, '独立场景观察视口'); svg.props.onPointerDown(event(20, 20, { shiftKey: true })); svg.props.onPointerMove(event(50, 50)); svg.props.onPointerUp(event(50, 50));
  svg.props.onWheel({ deltaY: 100, deltaMode: 0, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(env.state, before); assert.deepEqual(env.patches, []); assert.deepEqual(env.forbidden, []);
  tree = h.render(C, env); button(tree, '重置观察视图').props.onClick();
  assert.deepEqual(env.state, before); assert.deepEqual(env.patches, []);
});

test('observer exposes original output camera position and direction and explicit apply writes once', async () => {
  const { createStudioObserverView } = await api(); assert.equal(typeof createStudioObserverView, 'function');
  const env = environment(), h = harness(), C = createStudioObserverView(h.React);
  let tree = h.render(C, env), svg = find(tree, '独立场景观察视口');
  const output = find(tree, '输出相机位置与方向'); assert.ok(output);
  const frame = studioCameraFrame(env.state.draft.doc.layout);
  assert.deepEqual(JSON.parse(output.props['data-position']), frame.position);
  assert.deepEqual(JSON.parse(output.props['data-direction']), frame.forward);
  svg.props.onPointerDown(event(10, 10)); svg.props.onPointerMove(event(60, 20)); svg.props.onPointerUp(event(60, 20));
  tree = h.render(C, env); await button(tree, '把观察角度应用为输出镜头').props.onClick();
  assert.equal(env.patches.length, 1); assert.equal(env.patches[0].enabled, true);
  assert.ok(Number.isFinite(env.patches[0].orbit)); assert.notEqual(env.patches[0].orbit, 10);
  assert.deepEqual(env.forbidden, []);
});

test('blocked apply fails closed at handler time but read-only navigation remains available', async () => {
  const { createStudioObserverView } = await api(); assert.equal(typeof createStudioObserverView, 'function');
  const env = environment(), h = harness(), C = createStudioObserverView(h.React);
  const initial = h.render(C, env), apply = button(initial, '把观察角度应用为输出镜头');
  env.state.editingBlocked = true;
  await apply.props.onClick(); assert.deepEqual(env.patches, []);
  let tree = h.render(C, env); assert.equal(button(tree, '把观察角度应用为输出镜头').props.disabled, true);
  const before = lines(tree), svg = find(tree, '独立场景观察视口');
  svg.props.onPointerDown(event(10, 10)); svg.props.onPointerMove(event(50, 30)); svg.props.onPointerUp(event(50, 30));
  tree = h.render(C, env); assert.notDeepEqual(lines(tree), before); assert.deepEqual(env.patches, []); assert.deepEqual(env.forbidden, []);
});

test('stale page or revision cancels observer gestures and stale handlers never apply to new page', async () => {
  const { createStudioObserverView } = await api(); assert.equal(typeof createStudioObserverView, 'function');
  for (const change of [s => s.page.page_id = 'page-b', s => s.page.revision++]) {
    const env = environment(), h = harness(), C = createStudioObserverView(h.React);
    const tree = h.render(C, env), svg = find(tree, '独立场景观察视口'), apply = button(tree, '把观察角度应用为输出镜头');
    svg.props.onPointerDown(event(10, 10)); change(env.state);
    svg.props.onPointerMove(event(200, 200)); await apply.props.onClick();
    assert.deepEqual(env.patches, []); assert.deepEqual(env.forbidden, []);
    const refreshed = h.render(C, env); const fresh = harness(), freshTree = fresh.render(createStudioObserverView(fresh.React), env);
    assert.deepEqual(lines(refreshed), lines(freshTree));
  }
});

test('observer ignores other pointer IDs, releases capture, and unmount has no model side effects', async () => {
  const { createStudioObserverView } = await api(); assert.equal(typeof createStudioObserverView, 'function');
  const env = environment(), h = harness(), C = createStudioObserverView(h.React);
  let released = 0;
  const tree = h.render(C, env), svg = find(tree, '独立场景观察视口'), initial = lines(tree);
  const target = { ...dom(), releasePointerCapture() { released++; } };
  svg.props.onPointerDown(event(10, 10, { currentTarget: target }));
  svg.props.onPointerMove(event(100, 100, { pointerId: 2 }));
  assert.deepEqual(lines(h.render(C, env)), initial);
  svg.props.onLostPointerCapture(event(10, 10)); assert.ok(released >= 1);
  for (const cleanup of h.cleanups()) cleanup();
  assert.deepEqual(env.forbidden, []); assert.deepEqual(env.patches, []);
});

test('observer registers a nonpassive native wheel listener and deduplicates React delivery', async () => {
  const { createStudioObserverView } = await api();
  const env = environment(), h = harness(), C = createStudioObserverView(h.React), tree = h.render(C, env), svg = find(tree, '独立场景观察视口');
  let listener, options, removed = 0;
  assert.ok(svg.props.ref);
  svg.props.ref.current = { addEventListener(type, fn, opts) { if (type === 'wheel') { listener = fn; options = opts; } }, removeEventListener(type, fn) { if (type === 'wheel' && fn === listener) removed++; } };
  const cleanup = h.cleanups(); assert.equal(options.passive, false);
  const native = { deltaY: 100, deltaMode: 0, preventDefault() {}, stopPropagation() {} };
  listener(native); const once = lines(h.render(C, env));
  svg.props.onWheel({ ...native, nativeEvent: native }); assert.deepEqual(lines(h.render(C, env)), once);
  cleanup.forEach(fn => fn()); assert.equal(removed, 1); assert.deepEqual(env.patches, []);
});

test('real Studio model has zero undo or RPC effects during navigation and one undo on explicit apply', async () => {
  const { createStudioObserverView } = await api(); const { createStudioModel } = await import('../client/studio-model.mjs');
  const calls = [], source = environment().state.draft.doc;
  const model = createStudioModel({ request: async action => { calls.push(action); assert.equal(action, 'studioGetPage'); return { page_id: 'p', series_id: 's', revision: 1, title: 'P', proposals: [], doc: structuredClone(source) }; } });
  await model.open('p'); const before = structuredClone(model.getSnapshot().draft.doc);
  const h = harness(), C = createStudioObserverView(h.React), render = () => h.render(C, { model, state: model.getSnapshot() });
  let tree = render(), svg = find(tree, '独立场景观察视口');
  svg.props.onPointerDown(event(10, 10)); svg.props.onPointerMove(event(60, 30)); svg.props.onPointerUp(event(60, 30));
  assert.equal(model.getSnapshot().undo.length, 0); assert.equal(model.getSnapshot().dirty, false); assert.deepEqual(model.getSnapshot().draft.doc, before);
  tree = render(); await button(tree, '把观察角度应用为输出镜头').props.onClick();
  assert.equal(model.getSnapshot().undo.length, 1); assert.equal(model.getSnapshot().dirty, true); assert.deepEqual(calls, ['studioGetPage']);
  model.undo(); assert.deepEqual(model.getSnapshot().draft.doc, before); model.dispose();
});

test('description-only changes preserve local orbit but geometry changes invalidate stale controls', async () => {
  const { createStudioObserverView } = await api(); const env = environment(), h = harness(), C = createStudioObserverView(h.React);
  let tree = h.render(C, env), svg = find(tree, '独立场景观察视口');
  svg.props.onPointerDown(event(0, 0)); svg.props.onPointerMove(event(90, 10)); svg.props.onPointerUp(event(90, 10));
  tree = h.render(C, env); const navigated = lines(tree);
  env.state.draft.doc.layout.items[0].caption = 'New description';
  assert.deepEqual(lines(h.render(C, env)), navigated);
  env.state.draft.doc.layout.items[0].bbox[0]++;
  await button(tree, '把观察角度应用为输出镜头').props.onClick(); assert.equal(env.patches.length, 0);
});

test('nested observer keyboard events cannot bubble into the real Director output controls; Tab stays available', async () => {
  const { createStudioCameraView } = await import('../client/studio-camera-view.mjs');
  const { createStudioModel } = await import('../client/studio-model.mjs');
  const source = environment().state.draft.doc, calls = [];
  const model = createStudioModel({ request: async action => { calls.push(action); assert.equal(action, 'studioGetPage'); return { page_id: 'p', series_id: 's', revision: 1, title: 'P', proposals: [], doc: structuredClone(source) }; } });
  await model.open('p');
  const h = harness(), Director = createStudioCameraView(h.React); let exits = 0;
  const root = h.render(Director, { model, state: model.getSnapshot(), onExit: () => exits++ });
  const observerElement = nodes(root).find(node => typeof node.type === 'function' && node.type.name === 'StudioObserver');
  assert.ok(observerElement, 'The real Director must contain the observer component');
  // Expand the actual nested component without resetting hook cursors; dispatch child->ancestor like DOM bubbling.
  const observer = observerElement.type(observerElement.props), svg = find(observer, '独立场景观察视口');
  const before = structuredClone(model.getSnapshot().draft.doc);
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', '+', '=', '-', 'F', 'A', 'M', 'Escape']) {
    let stopped = false, prevented = false;
    const e = { key, target: { tagName: 'svg' }, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
    svg.props.onKeyDown(e);
    if (!stopped) root.props.onKeyDown(e);
    assert.deepEqual(model.getSnapshot().draft.doc, before, `${key} must not modify the output document through the ancestor`);
    assert.equal(stopped, true, `${key} must stop at observer`); assert.equal(prevented, true);
    assert.equal(model.getSnapshot().undo.length, 0); assert.equal(exits, 0);
  }
  let stopped = false, prevented = false;
  const tab = { key: 'Tab', target: { tagName: 'svg' }, preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } };
  svg.props.onKeyDown(tab); if (!stopped) root.props.onKeyDown(tab);
  assert.equal(stopped, false); assert.equal(prevented, false); assert.deepEqual(calls, ['studioGetPage']);
  model.dispose();
});

test('observer pointerdown focuses its own SVG without scrolling or changing the model', async () => {
  const { createStudioObserverView } = await api(); const env = environment(), h = harness();
  const svg = find(h.render(createStudioObserverView(h.React), env), '独立场景观察视口');
  const focusCalls = [], target = { ...dom(), focus(options) { focusCalls.push(options); } };
  svg.props.onPointerDown(event(10, 10, { currentTarget: target })); svg.props.onPointerUp(event(10, 10));
  assert.deepEqual(focusCalls, [{ preventScroll: true }]); assert.deepEqual(env.patches, []); assert.deepEqual(env.forbidden, []);
});

test('observer hides hidden objects and labels screen/backdrop anchors as nonphysical', async () => {
  const { createStudioObserverView } = await api(); assert.equal(typeof createStudioObserverView, 'function');
  const env = environment(); env.state.draft.doc.layout.items.push({ id: 'hidden', label: 'object', bbox: [1, 1, 50, 50], hidden: true }, { id: 'screen', label: 'text', bbox: [1, 1, 50, 50] });
  const h = harness(), tree = h.render(createStudioObserverView(h.React), env);
  assert.equal(nodes(tree).filter(n => n.props['data-observer-item'] === 'hidden').length, 0);
  assert.match(JSON.stringify(tree), /screen\/backdrop.*真实深度|真实深度.*screen\/backdrop/);
});
