import { STUDIO_CAMERA_DEFAULTS, STUDIO_CUBE_EDGES, studioBody, studioCameraFrame, studioWorldCube } from '../src/studio-camera.mjs';
import { studioGeometryKey } from '../src/studio-scene.mjs';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const wrap = n => ((n + 180) % 360 + 360) % 360 - 180;
const stop = event => { event.preventDefault?.(); event.stopPropagation?.(); };
const entry = target => /^(INPUT|TEXTAREA|SELECT|BUTTON)$/.test(target?.tagName ?? '') || target?.isContentEditable;
const current = (model, state) => model.getSnapshot?.() ?? state;
function binding(state) {
  const doc = state.draft?.doc;
  return doc?.kind === 'layout' ? JSON.stringify([state.page?.page_id ?? null, state.page?.revision ?? null, studioGeometryKey(doc)]) : null;
}
function initialCamera() {
  return { ...STUDIO_CAMERA_DEFAULTS, enabled: true, orbit: -28, pitch: 18, distance: 2.8 };
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function projectPoint(point, frame, layout) {
  const relative = point.map((value, i) => value - frame.position[i]);
  const depth = dot(relative, frame.forward);
  if (!(depth >= 0.0001)) return null;
  const result = { x: layout.width / 2 + frame.focal * dot(relative, frame.right) / depth,
    y: layout.height / 2 + frame.focal * dot(relative, frame.down) / depth };
  return Number.isFinite(result.x) && Number.isFinite(result.y) ? result : null;
}

/** Local navigation never calls model mutation/selection/gesture/takeover methods. */
export function createStudioObserverView(React) {
  const h = React.createElement;
  return function StudioObserver({ model, state }) {
    let token = null, bindingError = '';
    try { token = binding(state); } catch (error) { bindingError = error.message; }
    const [local, setLocal] = React.useState(() => ({ token, camera: initialCamera() }));
    const [notice, setNotice] = React.useState('');
    const camera = local.token === token ? local.camera : initialCamera();
    const cameraRef = React.useRef(camera), drag = React.useRef(null), alive = React.useRef(true), applying = React.useRef(false);
    const svgRef = React.useRef(null), wheelRef = React.useRef(null), wheelSeen = React.useRef(new WeakSet());
    cameraRef.current = camera;
    const validBinding = () => {
      try { return alive.current && token !== null && binding(current(model, state)) === token; }
      catch { return false; }
    };
    function end(event = {}) {
      const gesture = drag.current;
      if (!gesture || (event.pointerId !== undefined && gesture.pointerId !== event.pointerId)) return;
      drag.current = null;
      try { gesture.svg.releasePointerCapture?.(gesture.pointerId); } catch { /* Browser already released capture. */ }
    }
    function navigate(next) {
      if (!validBinding()) { end(); return; }
      cameraRef.current = next;
      setLocal({ token, camera: next });
    }
    React.useEffect(() => { end(); }, [token, model]);
    React.useEffect(() => { alive.current = true; return () => { alive.current = false; end(); }; }, [model]);
    React.useEffect(() => {
      const svg = svgRef.current;
      if (!svg?.addEventListener) return;
      const listener = event => wheelRef.current?.(event);
      svg.addEventListener('wheel', listener, { passive: false });
      return () => svg.removeEventListener('wheel', listener);
    }, []);
    function start(event) {
      if (!validBinding() || drag.current || ![0, 1, 2].includes(event.button ?? 0) || entry(event.target)) return;
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      stop(event);
      const svg = event.currentTarget, rect = svg.getBoundingClientRect();
      svg.focus?.({ preventScroll: true });
      drag.current = { token, model, pointerId: event.pointerId, svg, x: event.clientX, y: event.clientY,
        camera: { ...cameraRef.current }, width: Math.max(1, rect.width), height: Math.max(1, rect.height),
        pan: event.shiftKey || event.button === 1 || event.button === 2 };
      try { svg.setPointerCapture?.(event.pointerId); } catch { end(); }
    }
    function move(event) {
      const gesture = drag.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (!validBinding() || gesture.token !== token || gesture.model !== model) { end(); return; }
      if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
      stop(event);
      const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y, before = gesture.camera;
      navigate(gesture.pan ? { ...before,
        pan_x: clamp(before.pan_x - dx / gesture.width * before.distance, -100, 100),
        pan_y: clamp(before.pan_y - dy / gesture.height * before.distance, -100, 100) }
        : { ...before, orbit: wrap(before.orbit + dx * .3), pitch: clamp(before.pitch - dy * .3, -85, 85) });
    }
    function wheel(event) {
      if (!validBinding() || entry(event.target)) return;
      const native = event.nativeEvent ?? event;
      if (wheelSeen.current.has(native)) return;
      wheelSeen.current.add(native);
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1);
      if (!Number.isFinite(delta)) return;
      stop(event); end();
      const before = cameraRef.current;
      navigate({ ...before, distance: clamp(before.distance * Math.exp(clamp(delta * .001, -1, 1)), .01, 100) });
    }
    wheelRef.current = wheel;
    async function apply() {
      if (!validBinding() || current(model, state).editingBlocked || applying.current || typeof model.patchCamera !== 'function') return;
      end(); applying.current = true; setNotice('');
      try {
        // One ordinary human mutation: existing model owns takeover, undo and CAS scheduling.
        await model.patchCamera({ ...cameraRef.current, enabled: true });
      } catch (error) { if (alive.current) setNotice(`${error.code ? error.code + ': ' : ''}${error.message ?? error}`); }
      finally { applying.current = false; }
    }
    const layout = state.draft?.doc?.layout;
    let geometry = [], output = null, marker = null, geometryError = bindingError, anchored = 0;
    try {
      if (token && layout) {
        output = studioCameraFrame(layout);
        const observer = studioCameraFrame({ ...layout, camera });
        geometry = layout.items.filter(item => !item.hidden).flatMap(item => {
          const body = studioBody(item, layout);
          if (body.anchor !== 'world') { anchored++; return []; }
          const world = studioWorldCube(item, body, layout);
          return [{ id: item.id, points: world.points.map(point => projectPoint(point, observer, layout)) }];
        });
        marker = [output.position, output.position.map((value, i) => value + output.forward[i] * output.pivot * .5)]
          .map(point => projectPoint(point, observer, layout));
      }
    } catch (error) { geometryError = `${error.code ? error.code + ': ' : ''}${error.message}`; }
    const width = layout?.width ?? 1024, height = layout?.height ?? 768;
    const readable = vector => vector.map(value => Number(value.toFixed(3))).join(', ');
    return h('section', { className: 'mps-observer mps-card', 'aria-label': '独立场景观察' },
      h('h3', null, '观察场景（不改输出镜头）'),
      h('p', { className: 'mps-muted' }, '拖动旋转，Shift/右键拖动平移，滚轮缩放；仅本地观察，不改Doc、不接管任务。体块不是人物3D重建。'),
      h('svg', { ref: svgRef, viewBox: `0 0 ${width} ${height}`, style: { width: '100%', maxHeight: '360px', minHeight: '200px', background: '#121825', touchAction: 'none' },
        preserveAspectRatio: 'xMidYMid meet', tabIndex: 0, 'aria-label': '独立场景观察视口',
        onPointerDown: start, onPointerMove: move, onPointerUp: end, onPointerCancel: end, onLostPointerCapture: end,
        onContextMenu: stop, onWheel: wheel,
        onKeyDown: event => {
          // This view is nested inside Director: its shortcuts must never reach output controls.
          const key = event.key.toLowerCase();
          if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', '+', '=', '-', 'f', 'a', 'm', 'escape'].includes(key)) {
            stop(event);
            if (key === 'escape') end();
          }
        },
      }, geometry.map((item, index) => h('g', { key: item.id, 'data-observer-item': item.id },
        STUDIO_CUBE_EDGES.map(([a, b], i) => {
          const from = item.points[a], to = item.points[b];
          return from && to ? h('line', { key: i, 'data-observer-edge': `${item.id}:${i}`, x1: from.x, y1: from.y, x2: to.x, y2: to.y,
            stroke: ['#50c7b6', '#f5bb67', '#b99bf4'][index % 3], strokeWidth: 2, vectorEffect: 'non-scaling-stroke' }) : null;
        }))),
      marker?.[0] ? h('g', { 'aria-label': '输出相机标记' }, h('circle', { cx: marker[0].x, cy: marker[0].y, r: 7, fill: '#ffb55a' }),
        marker[1] ? h('line', { x1: marker[0].x, y1: marker[0].y, x2: marker[1].x, y2: marker[1].y, stroke: '#ffb55a', strokeWidth: 4, vectorEffect: 'non-scaling-stroke' }) : null) : null),
      output ? h('p', { 'aria-label': '输出相机位置与方向', 'data-position': JSON.stringify(output.position), 'data-direction': JSON.stringify(output.forward), className: 'mps-muted' },
        `输出相机位置 (${readable(output.position)}) · 方向 (${readable(output.forward)})${marker?.[0] ? ' · 橙色点/线' : ' · 标记在观察视口后方'}`) : null,
      h('p', { className: 'mps-muted' }, `screen/backdrop 锚定不代表真实深度，不作为世界体块显示（${anchored}项）。`),
      h('div', { className: 'mps-row' },
        h('button', { type: 'button', onClick: () => { end(); navigate(initialCamera()); }, disabled: !token }, '重置观察视图'),
        h('button', { type: 'button', onClick: apply, disabled: !token || Boolean(geometryError) || Boolean(state.editingBlocked) || typeof model.patchCamera !== 'function' }, '把观察角度应用为输出镜头')),
      notice || geometryError ? h('p', { role: 'alert' }, notice || geometryError) : null);
  };
}
