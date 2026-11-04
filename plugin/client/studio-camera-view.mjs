import {
  STUDIO_CAMERA_DEFAULTS, STUDIO_CUBE_EDGES, studioBody,
  captureStudioFraming, translateStudioItems, rebaseStudioCamera,
} from '../src/studio-camera.mjs';
import { estimateStudioBody, estimateStudioLayoutBodies, alignStudioGroupDepth } from '../src/studio-body.mjs';
import { moveStudioVisual } from './studio-layout.mjs';
import { studioDocSchemaVersion } from '../src/studio-doc-version.mjs';
import { createStudioObserverView } from './studio-observer-view.mjs';
import { createStudioRigView } from './studio-rig-view.mjs';
import { projectStudioComposition } from '../src/studio-composition.mjs';
import {
  STUDIO_VIEW_PRESETS, studioPresetPatch, applyStudioCameraChange, frameStudioView,
  studioTopView, cameraFromTopPoint, returnStudioItemsToView, studioCameraReadout,
} from './studio-director-ops.mjs';

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const wrap = n => ((n + 180) % 360 + 360) % 360 - 180;
const errorText = e => `${e.code ? e.code + ': ' : ''}${e.message ?? e}`;
const snapshot = (model, state) => model.getSnapshot?.() ?? state;
const stop = e => { e.preventDefault?.(); e.stopPropagation?.(); };
const textEntry = target => /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target?.tagName ?? '')
  || target?.isContentEditable || Boolean(target?.closest?.('input,textarea,select,button,[contenteditable]:not([contenteditable="false"])'));
const button = (h, label, action, disabled = false, props = {}) =>
  h('button', { type: 'button', onClick: action, disabled, ...props }, label);
const checkbox = (h, label, checked, change, disabled = false) => h('label', { key: label },
  h('input', { type: 'checkbox', 'aria-label': label, checked, disabled, onChange: e => change(e.target.checked) }), label);

function numeric(h, act, label, value, min, max, step, change, disabled = false) {
  return h('label', { key: label, className: 'mps-field' }, h('span', null, label), h('input', {
    'aria-label': label, type: 'number', value, min, max, step, disabled,
    onChange: e => {
      if (disabled) return;
      act(() => {
        const raw = e.target.value, n = Number(raw);
        if (!String(raw).trim() || !Number.isFinite(n) || n < min || n > max) {
          throw new Error(`${label}须为 ${min} 至 ${max} 的有限数值。`);
        }
        change(n);
      });
    },
  }));
}

// Shared PURE renderer: CameraView's legacy consumers do not execute h(Component).
// Hooks belong in the two public component wrappers, never in this function.
function renderBodyFields(h, { model, state, item, act }) {
  if (!item) return h('p', { className: 'mps-muted' }, '选择一个对象编辑体块。');
  let body;
  try { body = studioBody(item, state.draft.doc.layout); }
  catch (e) { return h('p', { role: 'alert' }, errorText(e)); }
  const disabled = Boolean(item.locked || state.editingBlocked);
  const patch = fields => {
    if (disabled) return;
    const current = snapshot(model, state), layout = current.draft.doc.layout;
    const target = layout.items.find(i => i.id === item.id);
    if (!target || target.locked || current.editingBlocked) return;
    model.patchItem(item.id, { body: { ...studioBody(target, layout), ...fields } });
  };
  return h('div', { className: 'mps-body-inspector' },
    h('div', { className: 'mps-body-header' }, h('strong', null, item.name || item.id),
      button(h, '重估此项体块', () => act(() => {
        if (disabled) return;
        const current = snapshot(model, state), layout = current.draft.doc.layout;
        const target = layout.items.find(i => i.id === item.id);
        if (!target || target.locked || current.editingBlocked) return;
        const { body: _old, ...withoutBody } = target;
        model.patchItem(item.id, { body: estimateStudioBody(withoutBody, layout) });
      }), disabled)),
    h('div', { className: 'mps-body-fields' },
      numeric(h, act, '体块 远近', body.z, .001, 100, .05, z => patch({ z }), disabled),
      numeric(h, act, '体块 厚度', body.thickness, 0, 10, .05, thickness => patch({ thickness }), disabled),
      numeric(h, act, '体块 朝向', body.yaw, -360, 360, 1, yaw => patch({ yaw }), disabled),
      h('label', { className: 'mps-field' }, h('span', null, '锚定'), h('select', {
        'aria-label': '体块 锚定', value: body.anchor, disabled,
        onChange: e => act(() => {
          if (!['world', 'screen', 'backdrop'].includes(e.target.value)) throw new Error('无效体块锚定。');
          patch({ anchor: e.target.value });
        }),
      }, ...['world', 'screen', 'backdrop'].map(a => h('option', { key: a, value: a }, a))))));
}

export function createStudioBodyInspector(React) {
  const h = React.createElement;
  return function StudioBodyInspector(props) {
    const [notice, setNotice] = React.useState('');
    const act = fn => { setNotice(''); try { return fn(); } catch (e) { setNotice(errorText(e)); } };
    return h('section', { className: 'mps-body-panel' }, renderBodyFields(h, { ...props, act }),
      notice ? h('p', { role: 'alert', className: 'mps-message' }, notice) : null);
  };
}

// Capture meet letterboxing once per gesture, for both deltas and absolute points.
function svgSpace(svg, width, height) {
  const r = svg.getBoundingClientRect();
  const scale = Math.max(width / Math.max(1, r.width), height / Math.max(1, r.height));
  return { scale, left: (r.left ?? 0) + (r.width - width / scale) / 2,
    top: (r.top ?? 0) + (r.height - height / scale) / 2 };
}

export function createStudioCameraView(React) {
  const h = React.createElement,Observer=createStudioObserverView(React),Rig=createStudioRigView(React);
  return function StudioDirector({ model, state, onExit = () => {}, fullscreen = false }) {
    const layout = state.draft.doc.layout, cam = { ...STUDIO_CAMERA_DEFAULTS, ...layout.camera };
    const ids = state.selected ?? [], selected = ids.length === 1 ? layout.items.find(i => i.id === ids[0]) : null;
    const [notice, setNotice] = React.useState('');
    const [ghost, setGhost] = React.useState(true), [moveMode, setMoveMode] = React.useState('camera');
    const [freeze, setFreeze] = React.useState(false), [hold, setHold] = React.useState('fixed');
    const [follow, setFollow] = React.useState(null), [keepSize, setKeepSize] = React.useState(true);
    const [frameMode, setFrameMode] = React.useState('smart');
    const [overlays, setOverlays] = React.useState({ mask: false, thirds: false, safe: false, wire: true, horizon: true });
    const drag = React.useRef(null), followRef = React.useRef(follow);
    const stageRef = React.useRef(null), topRef = React.useRef(null), wheelRef = React.useRef(null);
    const wheelSeen = React.useRef(new WeakSet());
    const current = () => snapshot(model, state);
    const act = fn => { setNotice(''); try { return fn(); } catch (e) { setNotice(errorText(e)); } };
    const updateFollow = goal => { followRef.current = goal; setFollow(goal); };
    const blocked = Boolean(state.editingBlocked);
    function commitCamera(result) {
      // No new model API required; preserve ordinary patchCamera callers/spies.
      if (!followRef.current && model.patchCamera) model.patchCamera(result.layout.camera);
      else model.updateLayout(() => result.layout);
      updateFollow(result.follow);
      if (result.notice) setNotice(result.notice);
    }
    function changeCamera(patch, options = {}) {
      if (current().editingBlocked) return;
      commitCamera(applyStudioCameraChange(current().draft.doc.layout, patch,
        { follow: followRef.current, keepSize, ...options }));
    }
    function captureSelected() {
      const s = current(), l = s.draft.doc.layout;
      const targets = (s.selected ?? []).filter(id => {
        const item = l.items.find(i => i.id === id);
        return item && !item.hidden && studioBody(item, l).anchor === 'world';
      });
      const result = applyStudioCameraChange(l, { enabled: true });
      const goal = captureStudioFraming(result.layout, targets);
      if (!l.camera?.enabled) commitCamera(result);
      updateFollow(goal);
    }
    function recapture() {
      const goal = followRef.current;
      if (!goal) return;
      try {
        const next = captureStudioFraming(current().draft.doc.layout, goal.ids);
        if (next.ids.length !== goal.ids.length) throw new Error('跟随目标已隐藏或丢失。');
        updateFollow(next);
      } catch (e) { updateFollow(null); setNotice(`已解除跟随：${errorText(e)}`); }
    }
    function autoFrame(targets = current().selected ?? []) {
      if (current().editingBlocked) return;
      const framed = frameStudioView(current().draft.doc.layout, frameMode, targets);
      changeCamera(framed.camera, { manual: true });
    }
    function moveBodies(dx, dy, individual = false, options = {}) {
      if (current().editingBlocked) return;
      const s = current();
      model.updateLayout(l => moveStudioVisual(l, options.ids ?? s.selected ?? [], dx, dy, {
        individual, freeze: (options.freeze ?? freeze) && !individual,
        follow: (options.hold ?? hold) === 'subject', projected: true, grabId: options.grabId ?? null,
        schemaVersion: studioDocSchemaVersion(s.draft.doc),
      }));
    }
    function end(event = {}, cancel = false) {
      const d = drag.current;
      if (!d || (event.pointerId !== undefined && d.pointerId !== undefined && event.pointerId !== d.pointerId)) return;
      drag.current = null;
      d.model.endGesture(cancel);
      if (cancel) updateFollow(d.follow);
      else if (d.kind === 'body' || d.kind === 'top-body') recapture();
      try { d.svg.releasePointerCapture?.(d.pointerId); } catch { /* Already released by the browser. */ }
    }
    function start(event, id, surface = 'stage') {
      if (current().editingBlocked || current().gestureActive || drag.current || ![0, 1, 2].includes(event.button ?? 0)) return;
      stop(event);
      const svg = event.currentTarget.ownerSVGElement ?? event.currentTarget;
      svg.focus?.({ preventScroll: true });
      act(() => {
        if (id && (!(current().selected ?? []).includes(id) || event.shiftKey || event.altKey)) {
          model.select(id, Boolean(event.shiftKey), Boolean(event.altKey));
        }
        const bodyMove = id && moveMode === 'bodies' && (event.button ?? 0) === 0 && surface !== 'gizmo';
        const kind = bodyMove ? (surface === 'top' ? 'top-body' : 'body')
          : surface === 'top' ? 'top-camera'
            : surface !== 'gizmo' && (event.shiftKey || event.button === 1 || event.button === 2) ? 'pan' : 'rotate';
        if (surface === 'top' && !topView) throw new Error('俯视图不可用，请先重置机位。');
        const width = surface === 'top' ? 320 : surface === 'gizmo' ? 120 : layout.width * 1.3;
        const height = surface === 'top' ? 190 : surface === 'gizmo' ? 120 : layout.height * 1.3;
        const space = svgSpace(svg, width, height);
        model.beginGesture();
        drag.current = { kind, svg, model, space, x: event.clientX, y: event.clientY,
          pointerId: event.pointerId, individual: Boolean(event.altKey), freeze, hold, grabId: bodyMove ? id : null,
          ids: [...(current().selected ?? (id ? [id] : []))], follow: followRef.current,
          mapping: surface === 'top' ? { ...topMapping } : null };
        try { svg.setPointerCapture?.(event.pointerId); }
        catch (e) { end(event, true); throw e; }
        if (kind === 'top-camera') topCameraAt(event, drag.current);
      });
    }
    function topCameraAt(event, d) {
      const { space, mapping } = d;
      const x = ((event.clientX - space.left) * space.scale - mapping.originX) / mapping.scale;
      const z = ((event.clientY - space.top) * space.scale - mapping.originY) / mapping.scale;
      changeCamera(cameraFromTopPoint(current().draft.doc.layout, x, z), { manual: true });
    }
    function move(event) {
      const d = drag.current;
      if (!d || (event.pointerId !== undefined && d.pointerId !== undefined && event.pointerId !== d.pointerId)) return;
      if (current().editingBlocked) { end(event, true); return; }
      const dx = event.clientX - d.x, dy = event.clientY - d.y;
      act(() => {
        const c = { ...STUDIO_CAMERA_DEFAULTS, ...current().draft.doc.layout.camera };
        if (d.kind === 'top-camera') topCameraAt(event, d);
        else if (d.kind === 'top-body') model.updateLayout(l => translateStudioItems(l, d.ids,
          [dx * d.space.scale / d.mapping.scale, 0, dy * d.space.scale / d.mapping.scale],
          { individual: d.individual, freeze: d.freeze && !d.individual, follow: d.hold === 'subject' }));
        else if (d.kind === 'body') moveBodies(dx * d.space.scale, dy * d.space.scale, d.individual, d);
        else if (d.kind === 'pan') changeCamera({ enabled: true,
          pan_x: clamp(c.pan_x - dx * d.space.scale / layout.width, -100, 100),
          pan_y: clamp(c.pan_y - dy * d.space.scale / layout.height, -100, 100),
        }, { manual: true });
        else changeCamera({ enabled: true, orbit: wrap(c.orbit + dx * .3), pitch: clamp(c.pitch - dy * .3, -85, 85) });
      });
      d.x = event.clientX; d.y = event.clientY;
    }
    function wheel(event) {
      if (current().editingBlocked || textEntry(event.target)) return;
      const native = event.nativeEvent ?? event;
      if (wheelSeen.current.has(native)) return;
      wheelSeen.current.add(native);
      stop(event);
      act(() => {
        const c = { ...STUDIO_CAMERA_DEFAULTS, ...current().draft.doc.layout.camera };
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
        if (!Number.isFinite(delta)) throw new Error('无效滚轮距离。');
        changeCamera(event.altKey ? { enabled: true, fov: clamp(c.fov + delta * .03, 10, 120) }
          : { enabled: true, distance: clamp(c.distance * Math.exp(clamp(delta * .001, -1, 1)), .2, 5) });
      });
    }
    wheelRef.current = wheel;
    function keyDown(event) {
      if (textEntry(event.target)) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') { stop(event); end({}, true); onExit(); return; }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (!['m', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown', '+', '=', '-', 'a', 'f', 'escape'].includes(key)) return;
      stop(event);
      if (key === 'escape' || key === 'f') { end({}, true); onExit(); return; }
      if (key === 'm') { setMoveMode(value => value === 'camera' ? 'bodies' : 'camera'); return; }
      if (current().editingBlocked) return;
      act(() => {
        const c = { ...STUDIO_CAMERA_DEFAULTS, ...current().draft.doc.layout.camera };
        if (key === 'a') autoFrame();
        else if (['+', '=', '-'].includes(key)) changeCamera({ enabled: true, distance: clamp(c.distance * (key === '-' ? 1.1 : 1 / 1.1), .2, 5) });
        else {
          const dx = key === 'arrowright' ? 1 : key === 'arrowleft' ? -1 : 0;
          const dy = key === 'arrowdown' ? 1 : key === 'arrowup' ? -1 : 0;
          if (moveMode === 'bodies') { moveBodies(dx * (event.shiftKey ? 20 : 5), dy * (event.shiftKey ? 20 : 5)); recapture(); }
          else changeCamera({ enabled: true, orbit: wrap(c.orbit + dx * 3), pitch: clamp(c.pitch - dy * 3, -85, 85) });
        }
      });
    }
    React.useEffect(() => {
      const goal = followRef.current;
      if (!goal) return;
      if (!layout.camera?.enabled) { updateFollow(null); return; }
      try {
        const next = captureStudioFraming(layout, goal.ids);
        if (next.ids.length !== goal.ids.length) throw new Error('跟随目标已隐藏或丢失。');
      } catch (e) { updateFollow(null); setNotice(`已解除跟随：${errorText(e)}`); }
    }, [layout]);
    // One combined cleanup also preserves the older injected React effect contract.
    React.useEffect(() => {
      const elements = [stageRef.current, topRef.current].filter(Boolean);
      const handler = e => wheelRef.current(e);
      for (const el of elements) el.addEventListener?.('wheel', handler, { passive: false });
      return () => {
        for (const el of elements) el.removeEventListener?.('wheel', handler);
        const d = drag.current;
        if (!d) return;
        drag.current = null;
        d.model.endGesture(true);
        try { d.svg.releasePointerCapture?.(d.pointerId); } catch { /* Browser already released it. */ }
      };
    }, [model]);
    const errors = [];
    let projection = { items: {}, order: [], checks: [] }, topView = null, readout = '';
    try { projection = projectStudioComposition(layout); } catch (e) { errors.push(errorText(e)); }
    try { topView = studioTopView(layout); } catch (e) { errors.push(errorText(e)); }
    try { readout = studioCameraReadout(layout).text; } catch (e) { errors.push(errorText(e)); }
    errors.push(...(projection.checks ?? []).map(c => c.message));
    const W = layout.width, H = layout.height;
    // Fit the real camera, base, target and blocks, including negative-Z camera positions.
    let topMapping = null, topContent = [];
    if (topView) {
      const { frame, target, items, hFovDeg } = topView;
      const angle = Math.atan2(frame.forward[0], frame.forward[2]);
      const half = hFovDeg * Math.PI / 360;
      const far = Math.max(.5, Math.hypot(target[0] - frame.position[0], target[2] - frame.position[2]) * 1.5);
      const cp = [frame.position[0], frame.position[2]];
      const left = [cp[0] + Math.sin(angle - half) * far, cp[1] + Math.cos(angle - half) * far];
      const right = [cp[0] + Math.sin(angle + half) * far, cp[1] + Math.cos(angle + half) * far];
      const points = [[0, 0], cp, [target[0], target[2]], left, right];
      for (const b of items) {
        const radius = Math.hypot(b.width, b.depth) / 2;
        points.push([b.x - radius, b.z - radius], [b.x + radius, b.z + radius]);
      }
      const xExtent = Math.max(2.5, ...points.map(p => Math.abs(p[0]) + .3));
      const zMin = Math.min(-.5, ...points.map(p => p[1] - .3));
      const zMax = Math.max(2.5, ...points.map(p => p[1] + .3));
      const scale = Math.min(288 / (2 * xExtent), 158 / (zMax - zMin));
      topMapping = { scale, originX: 160, originY: 16 + (158 - (zMax - zMin) * scale) / 2 - zMin * scale };
      const tx = x => topMapping.originX + x * scale, tz = z => topMapping.originY + z * scale;
      topContent = [
        h('line', { key: 'axis', x1: tx(0), y1: 0, x2: tx(0), y2: 190, stroke: '#34445c', pointerEvents: 'none' }),
        h('polygon', { key: 'wedge', 'data-top-fov-wedge': true, points: [cp, left, right].map(p => `${tx(p[0])},${tz(p[1])}`).join(' '), fill: '#809eff18', stroke: '#809eff88', pointerEvents: 'none' }),
        h('line', { key: 'far', 'data-top-far-line': true, x1: tx(left[0]), y1: tz(left[1]), x2: tx(right[0]), y2: tz(right[1]), stroke: '#809eff', strokeDasharray: '4 3', pointerEvents: 'none' }),
        h('circle', { key: 'base', 'data-top-base': true, cx: tx(0), cy: tz(0), r: 3, fill: '#b4becd', pointerEvents: 'none' }),
        h('circle', { key: 'pivot', 'data-top-pivot': true, cx: tx(target[0]), cy: tz(target[2]), r: 4, fill: 'none', stroke: '#ffe09b', pointerEvents: 'none' }),
        ...items.map(b => h('g', { key: b.id, 'data-top-item': b.id,
          transform: `translate(${tx(b.x)},${tz(b.z)}) rotate(${-b.yaw})`,
          onPointerDown: e => start(e, b.id, 'top'),
        }, h('rect', { x: -b.width * scale / 2, y: -Math.max(3, b.depth * scale) / 2,
          width: Math.max(2, b.width * scale), height: Math.max(3, b.depth * scale),
          fill: ids.includes(b.id) ? '#b69cff66' : '#64b5f633', stroke: b.locked ? '#9ba3b0' : '#64b5f6',
        }), h('title', null, `${b.name} · Z ${b.z.toFixed(2)}${b.locked ? ' · 锁定' : ''}`))),
        h('g', { key: 'camera', 'data-top-camera': true,
          transform: `translate(${tx(cp[0])},${tz(cp[1])}) rotate(${-angle * 180 / Math.PI})`, pointerEvents: 'none',
        }, h('path', { d: 'M -6 -5 L 6 -5 L 6 3 L 10 7 L -10 7 L -6 3 Z', fill: '#b69cff', stroke: '#e7dfff' })),
        h('text', { key: 'legend', x: 8, y: 185, fill: '#bccae0', fontSize: 10, pointerEvents: 'none' }, 'X →   Z ↓ · 点/拖机位；体块模式拖 XZ'),
      ];
    }
    const boxes = [], lines = [];
    for (const id of projection.order) {
      const item = layout.items.find(i => i.id === id), p = projection.items[id];
      if (!item || item.hidden) continue;
      const color = item.label === 'character' ? '#b69cff' : item.label === 'text' ? '#f6ce71' : '#64b5f6';
      if (ghost) {
        const [x, y, r, b] = item.bbox;
        boxes.push(h('rect', { key: 'ghost-' + id, x, y, width: r - x, height: b - y, fill: 'none', stroke: color, opacity: .3, strokeDasharray: '8 5', pointerEvents: 'none' }));
      }
      if (overlays.wire && p.corners) for (const [index, [a, b]] of STUDIO_CUBE_EDGES.entries()) {
        const x = p.corners[a], y = p.corners[b];
        if (x && y) lines.push(h('line', { key: id + '-edge-' + index, 'data-cube-edge': id,
          x1: x.x, y1: x.y, x2: y.x, y2: y.y, stroke: color, strokeWidth: ids.includes(id) ? 3 : 1.5, pointerEvents: 'none' }));
      }
      if (p.visible) {
        const [x, y, r, b] = p.raw ?? p.bbox;
        boxes.push(h('g', { key: id, 'data-camera-item': id, onPointerDown: e => start(e, id) },
          h('rect', { x, y, width: r - x, height: b - y, fill: color, fillOpacity: .12, stroke: color, strokeWidth: ids.includes(id) ? 3 : 1 }),
          h('text', { x: x + 6, y: y + 18, fontSize: 14, fill: '#cbd5ea', pointerEvents: 'none' }, item.name || item.label)));
      }
    }
    const pointerHandlers = {
      onPointerMove: move, onPointerUp: e => end(e), onPointerCancel: e => end(e, true),
      onLostPointerCapture: e => end(e, true), onContextMenu: stop,
    };
    const oof = layout.items.filter(i => !i.hidden && (!projection.items[i.id]?.visible || projection.items[i.id]?.partial));
    const controls = h('div', { className: 'mps-director-controls' },
      h('div', { className: 'mps-camera-toolbar' },
        checkbox(h, '启用3D相机', cam.enabled, value => act(() => changeCamera({ enabled: value })), blocked),
        h('select', { 'aria-label': '镜头操作模式', value: moveMode, onChange: e => setMoveMode(e.target.value) },
          h('option', { value: 'camera' }, '机位：拖动旋转'), h('option', { value: 'bodies' }, '体块：拖动选中项')),
        checkbox(h, '冻结整体移动', freeze, setFreeze),
        h('label', null, '体块移动时 ', h('select', { 'aria-label': '体块移动机位', value: hold, onChange: e => setHold(e.target.value) },
          h('option', { value: 'fixed' }, '固定机位'), h('option', { value: 'subject' }, '机位随主体移动'))),
        button(h, '重置机位', () => act(() => changeCamera({ ...STUDIO_CAMERA_DEFAULTS, enabled: true }, { manual: true })), blocked),
        button(h, '定为基准', () => act(() => {
          if (current().editingBlocked || !globalThis.confirm?.('把当前投影设为新的原框？出画对象隐藏保留，可撤销。')) return;
          model.updateLayout(l => applyStudioCameraChange(rebaseStudioCamera(l), { enabled: true }).layout);
          updateFollow(null);
        }), blocked),
        fullscreen ? button(h, '退出全屏', () => { end({}, true); onExit(); }) : null),
      h('div', { className: 'mps-director-subbar' },
        checkbox(h, '跟随主体', Boolean(follow), value => act(() => value ? captureSelected() : updateFollow(null)), blocked),
        checkbox(h, '保持画面占比', keepSize, setKeepSize),
        button(h, '改跟选中', () => act(captureSelected), blocked),
        button(h, '重捕当前构图', () => act(recapture), blocked || !follow),
        h('label', null, '自动取景 ', h('select', { 'aria-label': '自动取景模式', value: frameMode, onChange: e => setFrameMode(e.target.value) },
          ...[['smart', '智能保留构图'], ['fit', '全部入框'], ['subject', '主体原构图'], ['center', '仅居中'], ['fill', '选中填充']]
            .map(([value, label]) => h('option', { key: value, value }, label)))),
        button(h, '自动取景', () => act(() => autoFrame()), blocked)),
      h('div', { className: 'mps-preset-bar', 'aria-label': '镜头预设' }, ...STUDIO_VIEW_PRESETS.map(p =>
        button(h, p.label, () => act(() => changeCamera(studioPresetPatch(p), { manual: true })), blocked,
          { key: p.id, 'data-camera-preset': p.id }))),
      h('div', { className: 'mps-camera-fields' }, ...[
        ['环绕', 'orbit', -180, 180, 1], ['俯仰', 'pitch', -85, 85, 1], ['滚转', 'roll', -180, 180, 1],
        ['距离', 'distance', .01, 100, .05], ['FOV', 'fov', 10, 120, 1],
        ['横移', 'pan_x', -100, 100, .02], ['纵移', 'pan_y', -100, 100, .02], ['前后移', 'pan_z', -100, 100, .02],
      ].map(([label, key, min, max, step]) => numeric(h, act, '相机 ' + label, cam[key], min, max, step,
        value => changeCamera({ enabled: true, [key]: value }), blocked))),
      h('div', { className: 'mps-overlay-toggles' }, checkbox(h, '原框虚影', ghost, setGhost),
        ...[['mask', '画外遮罩'], ['thirds', '三分线'], ['safe', '90%安全框'], ['wire', '体块线框'], ['horizon', '地平线与灭点']]
          .map(([key, label]) => checkbox(h, label, overlays[key], value => setOverlays(old => ({ ...old, [key]: value }))))));
    const stage = h('svg', { ref: stageRef, className: 'mps-director-canvas',
      viewBox: `${-W * .15} ${-H * .15} ${W * 1.3} ${H * 1.3}`, preserveAspectRatio: 'xMidYMid meet',
      role: 'img', tabIndex: 0, 'aria-label': '3D镜头调度画布',
      onPointerDown: e => start(e), onWheel: wheel, ...pointerHandlers,
    },
      h('rect', { x: 0, y: 0, width: W, height: H, fill: '#182334', stroke: '#65708b' }),
      boxes, lines,
      overlays.mask ? h('path', { 'data-stage-mask': true, d: `M ${-W * .15} ${-H * .15} h ${W * 1.3} v ${H * 1.3} h ${-W * 1.3} Z M 0 0 v ${H} h ${W} v ${-H} Z`, fill: '#05090fe8', fillRule: 'evenodd', pointerEvents: 'none' }) : null,
      overlays.thirds ? [1, 2].flatMap(n => [
        h('line', { key: 'third-x-' + n, 'data-stage-thirds': true, x1: W * n / 3, y1: 0, x2: W * n / 3, y2: H, stroke: '#ffffff55', pointerEvents: 'none' }),
        h('line', { key: 'third-y-' + n, x1: 0, y1: H * n / 3, x2: W, y2: H * n / 3, stroke: '#ffffff55', pointerEvents: 'none' }),
      ]) : null,
      overlays.safe ? h('rect', { 'data-stage-safe': true, x: W * .05, y: H * .05, width: W * .9, height: H * .9, fill: 'none', stroke: '#d6e3a1', strokeDasharray: '8 5', pointerEvents: 'none' }) : null,
      overlays.horizon && projection.horizon ? h('line', { 'data-stage-horizon': true,
        x1: projection.horizon.a.x, y1: projection.horizon.a.y, x2: projection.horizon.b.x, y2: projection.horizon.b.y,
        stroke: '#d7ad67', strokeDasharray: '7 5', pointerEvents: 'none' }) : null,
      overlays.horizon && projection.vp ? h('circle', { 'data-stage-vp': true, cx: projection.vp.x, cy: projection.vp.y, r: 7, fill: 'none', stroke: '#d7ad67', pointerEvents: 'none' }) : null,
      follow ? h('g', { 'data-follow-crosshair': true, 'data-follow-ids': follow.ids.join(','),
        'data-follow-cx': follow.cx, 'data-follow-cy': follow.cy, 'data-follow-size': follow.size,
        transform: `translate(${follow.cx},${follow.cy})`, stroke: '#ffda83', pointerEvents: 'none',
      }, h('circle', { r: 11, fill: 'none' }), h('path', { d: 'M -22 0 H 22 M 0 -22 V 22', fill: 'none' })) : null);
    const gizmo = h('svg', { className: 'mps-camera-gizmo', viewBox: '0 0 120 120', role: 'img', tabIndex: 0,
      'aria-label': '镜头旋转球', 'data-camera-gizmo': true,
      onPointerDown: e => start(e, null, 'gizmo'), ...pointerHandlers,
    }, h('title', null, '拖动球体环绕 / 俯仰；始终控制相机'),
      h('circle', { cx: 60, cy: 60, r: 45, fill: '#25314b', stroke: '#a0b5df' }),
      h('ellipse', { cx: 60, cy: 60, rx: 45, ry: 15, fill: 'none', stroke: '#7186ab' }),
      h('ellipse', { cx: 60, cy: 60, rx: 15, ry: 45, fill: 'none', stroke: '#7186ab' }),
      h('circle', { cx: 60 + Math.sin(cam.orbit * Math.PI / 180) * Math.cos(cam.pitch * Math.PI / 180) * 44,
        cy: 60 - Math.sin(cam.pitch * Math.PI / 180) * 44, r: 6, fill: '#c3a3ff', pointerEvents: 'none' }),
      h('text', { x: 60, y: 117, textAnchor: 'middle', fontSize: 10, fill: '#c9d7ee', pointerEvents: 'none' }, '环绕 / 俯仰'));
    return h('section', { className: `mps-director${fullscreen ? ' mps-director-fullscreen' : ''}`, tabIndex: 0, onKeyDown: keyDown },
      h('details', {className:'mps-observer-container',open:true},h('summary',null,'独立观察场景（不改变输出镜头）'),h(Observer,{model,state})),
      h(Rig,{key:state.page?.page_id,model,state}),
      controls,
      h('p', { className: 'mps-camera-readout', 'data-camera-readout': true }, readout),
      h('p', { className: 'mps-director-help' }, '体块投影辅助，非真实3D重建。空白拖旋转；Shift/中/右键拖平移；滚轮距离，Alt+滚轮 FOV。M 切模式，方向键移动，+/- 距离，A 取景，F/Esc 退出。',
        hold === 'subject' ? '机位随主体移动已开启。' : '机位随主体移动未开启（固定机位）。'),
      notice ? h('p', { role: 'alert', className: 'mps-message' }, notice) : null,
      errors.length ? h('p', { role: 'alert', className: 'mps-message' }, [...new Set(errors)].join('；')) : null,
      h('div', { className: 'mps-director-stage-grid' }, stage,
        h('aside', { className: 'mps-director-side' },
          h('div', { className: 'mps-gizmo-row' }, gizmo, h('p', null, '旋转球始终控制相机。俯视图可直接放置机位，体块模式拖动 XZ。')),
          h('svg', { ref: topRef, className: 'mps-top-camera', viewBox: '0 0 320 190', preserveAspectRatio: 'xMidYMid meet', role: 'img', tabIndex: 0,
            'aria-label': '体块俯视图', onPointerDown: e => start(e, null, 'top'), onWheel: wheel, ...pointerHandlers }, topContent),
          renderBodyFields(h, { model, state, item: selected, act }),
          h('div', { className: 'mps-director-subbar' },
            button(h, '估算体块', () => act(() => { if (!current().editingBlocked) return model.updateLayout(l => estimateStudioLayoutBodies(l, { onlyMissing: true })); }), blocked),
            button(h, '重估全部体块', () => act(() => { if (!current().editingBlocked && globalThis.confirm?.('覆盖全部未锁定体块的人工参数？锁定项保留，可撤销。')) return model.updateLayout(l => estimateStudioLayoutBodies(l, { onlyMissing: false })); }), blocked),
            button(h, '对齐选中景深', () => act(() => { if (!current().editingBlocked) model.updateLayout(l => alignStudioGroupDepth(l, current().selected ?? [])); }), blocked || ids.length < 2)),
          h('div', { className: 'mps-oof-list', 'aria-label': '出画对象' },
            h('strong', null, `出画 / 部分出画（${oof.length}）`), ...oof.map(item => h('div', { key: item.id, className: 'mps-oof-row' },
              h('span', null, item.name || item.id, item.locked ? '（锁定）' : ''),
              button(h, '选择', () => model.select(item.id), false, { 'data-oof-select': item.id }),
              button(h, '为此项取景', () => act(() => autoFrame([item.id])), blocked, { 'data-oof-frame': item.id }),
              button(h, '移回视野', () => act(() => {
                if (item.locked || current().editingBlocked) return;
                model.updateLayout(l => returnStudioItemsToView(l, [item.id]));
                recapture();
              }), blocked || Boolean(item.locked), { 'data-oof-return': item.id })))))));

  };
}
