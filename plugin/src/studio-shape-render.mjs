/**
 * Pure browser-safe preview renderer selection, v2 shape fidelity, ring reading and
 * the deterministic scanline polygon fill shared by the Host PNG preview and the
 * read-only client preview.
 *
 * No external packages, no Node globals, no I/O. Callers validate the complete Doc
 * first (`validateStudioDoc`); this module only decides how an already-validated
 * document is drawn. A shape is never replaced by its rectangle: the ring is either
 * drawn from its real polygon data or the caller renders the v1 bbox path on purpose.
 */

import {studioDocSchemaVersion} from './studio-doc-version.mjs';
import {studioCameraMoved} from './studio-camera.mjs';

const RENDERERS = Object.freeze({1: 'layout-bbox-v1', 2: 'layout-polygon-v2'});

// The one refusal string shared by the compile check and the Host preview error, so the
// two call sites cannot drift into nearby-but-different conditions.
export const STUDIO_SHAPE_CAMERA_CODE='STUDIO_SHAPE_CAMERA_UNSUPPORTED';
export const STUDIO_SHAPE_CAMERA_MESSAGE='Shapes cannot be compiled with a moved camera; reset the camera or remove the shapes.';

function invalid(path, message) {
  const error = new TypeError(`${path}: ${message}`);
  error.code = 'STUDIO_INVALID_INPUT';
  throw error;
}

/** The frozen renderer name for a validated Doc; unknown schema versions are refused. */
export function studioPreviewRenderer(doc) {
  const version = studioDocSchemaVersion(doc);
  const renderer = RENDERERS[version];
  if (!renderer) invalid('doc.schema_version', `unsupported preview renderer for schema version ${version}`);
  return renderer;
}

/**
 * What the model actually receives for a validated Doc.
 * Only an active shape on a Layout activates geometry: caption branches and hidden
 * items keep their data but report `none`. A disclosed bbox-only limit, never a mask.
 */
export function studioShapeFidelity(doc) {
  const version = studioDocSchemaVersion(doc);
  if (version !== 2 || doc.kind !== 'layout') return 'none';
  const layout = doc.layout;
  if (!layout || typeof layout !== 'object' || !Array.isArray(layout.items)) return 'none';
  return layout.items.some(item => item && typeof item === 'object'
    && item.hidden !== true && Object.hasOwn(item, 'shape')) ? 'bbox-only' : 'none';
}

/**
 * The single camera/geometry refusal: a v2 Layout with an active shape under a moved
 * camera. Compile turns it into one check, the Host preview throws it, and the client
 * shows it instead of substituting the rectangle. Default, disabled and hidden cases
 * never match, and v1 has no shape geometry to project.
 */
export function studioShapeCameraBlocked(doc) {
  if (doc === null || typeof doc !== 'object') return false;
  if (studioDocSchemaVersion(doc) !== 2 || doc.kind !== 'layout') return false;
  return studioCameraMoved(doc.layout) && doc.layout.items.some(item=>
    !item.hidden && item.role!=='panel' && Object.hasOwn(item,'shape'));
}

/**
 * Detached polygon ring for one item. A missing shape is `null` (never the
 * rectangle bbox); unknown shape kinds are refused instead of silently ignored.
 */
export function studioItemRing(item) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) invalid('item', 'expected an item object');
  if (!Object.hasOwn(item, 'shape')) return null;
  const shape = item.shape;
  if (shape === null || typeof shape !== 'object' || Array.isArray(shape)) invalid('item.shape', 'expected a plain shape object');
  if (shape.kind !== 'polygon') invalid('item.shape.kind', `unsupported shape kind ${String(shape.kind)}`);
  const ring = shape.ring;
  if (!Array.isArray(ring) || ring.length < 3) invalid('item.shape.ring', 'expected a polygon ring with at least three points');
  return ring.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 2) invalid(`item.shape.ring[${index}]`, 'expected an [x, y] pair');
    return [point[0], point[1]];
  });
}

/** Describe an explicit, validated panel in page coordinates. At the middle
 * column identify real intersecting edges only. A vertex at that column has
 * no single edge slope, so a diamond gets no invented top or bottom angle. */
export function studioPanelShapeDescription(ring) {
  const edges=ring.map((a,i)=>[a,ring[(i+1)%ring.length]]);
  const rectangle=edges.length===4&&edges.every(([a,b])=>a[0]===b[0]||a[1]===b[1]);
  const count=edges.length;
  const badge=rectangle?'轴对齐矩形':count===4?'非轴对齐四边形':count===3?'三角形':`${count} 边多边形`;
  const outline=rectangle?'four-sided axis-aligned rectangular':count===4?'four-sided':count===3?'triangular':`${count}-sided polygonal`;
  const xs=ring.map(p=>p[0]),center=(Math.min(...xs)+Math.max(...xs))/2;
  const hits=[];
  for(const [a,b] of edges){
    const [left,right]=a[0]<=b[0]?[a,b]:[b,a];
    if(center<=left[0]||center>=right[0])continue;
    const dx=right[0]-left[0],dy=right[1]-left[1];
    hits.push({y:left[1]+(center-left[0])*dy/dx,degrees:Math.round(Math.atan2(dy,dx)*1800/Math.PI)/10});
  }
  if(xs.includes(center)||hits.length!==2)return {badge,outline,detail:'',hint:''};
  const [top,bottom]=hits.sort((a,b)=>a.y-b.y).map(hit=>hit.degrees);
  return {badge,outline,detail:`中线处上边 ${top}°，下边 ${bottom}°（从左向右，向下为正）`,
    hint:`At the middle column the upper and lower edges slope ${top} and ${bottom} degrees from left to right (positive downward).`};
}

/**
 * Even-odd scanline fill of one ring in canvas RGBA bytes.
 *
 * The ring is scaled first, then each row samples the pixel centre y + 0.5. Every edge
 * is normalized from its lower-y endpoint to its higher-y endpoint before the crossing
 * is computed, so neither the winding direction nor the start vertex can change the
 * floating-point result; the half-open rule yMin <= sample < yMax keeps horizontal edges
 * and shared vertices from contributing duplicate intersections, and no epsilon is used.
 * Sorted crossings are paired and filled
 * from ceil(xa - 0.5) up to ceil(xb - 0.5) exclusive, clipped to the canvas. RGB is
 * written and the existing alpha is preserved, so no pixel outside the canvas or
 * outside the ring is touched. Concave notches stay unfilled. Returns the pixel count.
 */
export function fillRingScanline(ring, pixels, width, height, rgb, scale = 1) {
  if (!Array.isArray(ring) || ring.length < 3) invalid('ring', 'expected at least three points');
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    invalid('canvas', 'expected positive integer dimensions');
  }
  if (!pixels || typeof pixels.length !== 'number' || pixels.length < width * height * 4) {
    invalid('pixels', 'expected an RGBA buffer for this canvas');
  }
  if (!Array.isArray(rgb) || rgb.length !== 3 || rgb.some(channel => !Number.isFinite(channel))) {
    invalid('rgb', 'expected three finite colour channels');
  }
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0) invalid('scale', 'expected a positive finite scale');
  const points = ring.map((point, index) => {
    if (!Array.isArray(point) || point.length !== 2) invalid(`ring[${index}]`, 'expected an [x, y] pair');
    if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) invalid(`ring[${index}]`, 'expected finite coordinates');
    return [point[0] * scale, point[1] * scale];
  });
  const crosses = new Array(points.length);
  let filled = 0;
  for (let y = 0; y < height; y++) {
    const sample = y + 0.5;
    let count = 0;
    for (let index = 0; index < points.length; index++) {
      const a = points[index], b = points[index + 1 === points.length ? 0 : index + 1];
      const low = a[1] <= b[1] ? a : b, high = low === a ? b : a;
      if (!(low[1] <= sample && sample < high[1])) continue;
      crosses[count++] = low[0] + (sample - low[1]) * (high[0] - low[0]) / (high[1] - low[1]);
    }
    if (count < 2) continue;
    const crossings = crosses.slice(0, count).sort((left, right) => left - right);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const from = Math.max(0, Math.ceil(crossings[index] - 0.5));
      const to = Math.min(width, Math.ceil(crossings[index + 1] - 0.5));
      for (let x = from; x < to; x++) {
        const offset = (y * width + x) * 4;
        pixels[offset] = rgb[0]; pixels[offset + 1] = rgb[1]; pixels[offset + 2] = rgb[2];
        filled++;
      }
    }
  }
  return filled;
}
