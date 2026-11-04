import {validateStudioDoc} from './studio-domain.mjs';
import {assertStudioShapeTransition} from './studio-doc-version.mjs';
import {studioRoundHalfEven, studioShapeReportJSON} from './studio-shape-exact.mjs';
import {createStudioPolygon, createStudioQuad, createStudioLasso, moveStudioShapeVertex, scaleStudioShape, rotateStudioShape, studioGridRationalFromPx} from './studio-shape-ops.mjs';
import {studioKnifeLineFromLattice, studioKnifeSplit} from './studio-shape-knife.mjs';
import {studioTemplateFrames,studioPanelRowTarget,studioChineseNumberText} from './studio-page-assist.mjs';

const fields = Object.freeze({
  polygon: ['op', 'points', 'id'],
  quad: ['op', 'points', 'id'],
  lasso: ['op', 'points', 'tolerance_px', 'id'],
  knife: ['op', 'target_id', 'start', 'end', 'gutter_px'],
  move_vertex: ['op', 'target_id', 'index', 'to', 'constraint'],
  reset_rect: ['op', 'target_id'],
  scale: ['op', 'target_id', 'pivot', 'scale'],
  rotate: ['op', 'target_id', 'pivot', 'quarter_turns'],
  align_row: ['op','ids','threshold_px'],
  template: ['op','preset','gutter_px'],
  format_numbers: ['op','target_id'],
  widen_bubble: ['op','target_id','min_width_px'],
});

function fail(code, path, reason) {
  const error = new TypeError(`${code}: ${path}: ${reason}`);
  Object.assign(error, {code, path, reason});
  throw error;
}

function ownData(value, key, path) {
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property?.enumerable || !Object.hasOwn(property, 'value')) {
    fail('STUDIO_INVALID_INPUT', path, 'expected_own_data');
  }
  return property.value;
}

function readCommand(value) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    fail('STUDIO_INVALID_INPUT', 'command', 'expected_record');
  }
  const op = ownData(value, 'op', 'command.op');
  if (typeof op !== 'string' || !Object.hasOwn(fields, op)) fail('STUDIO_INVALID_INPUT', 'command.op', 'unknown_op');
  const result = {op};
  for (const key of Reflect.ownKeys(value)) {
    if (!fields[op].includes(key)) fail('STUDIO_INVALID_INPUT', 'command', 'unknown_field');
    result[key] = ownData(value, key, 'command.' + key);
  }
  for (const key of fields[op]) {
    if (key !== 'id' && !Object.hasOwn(result, key)) fail('STUDIO_INVALID_INPUT', 'command.' + key, 'required');
  }
  return result;
}

function nextPanelId(occupied, requested) {
  let id = requested;
  if (id === undefined) {
    let suffix = 1;
    while (occupied.has('panel-' + suffix)) suffix++;
    id = 'panel-' + suffix;
  }
  if (typeof id !== 'string' || !id.trim() || id.length > 80 || occupied.has(id)) {
    fail('STUDIO_PANEL_ID', 'command.id', 'invalid_or_occupied');
  }
  occupied.add(id);
  return id;
}

function panelItem(id, ring, bbox) {
  return {id, label: 'object', role: 'panel', caption: 'Comic panel.', bbox, shape: {kind: 'polygon', ring}};
}

function newShape(command) {
  if (command.op === 'quad') return createStudioQuad(command.points);
  if (command.op === 'lasso') return createStudioLasso(command.points, {tolerance_px: command.tolerance_px});
  return createStudioPolygon(command.points);
}

function knifePoint(value, path) {
  if (!Array.isArray(value) || value.length !== 2 || Reflect.ownKeys(value).length !== 3) {
    fail('STUDIO_INVALID_INPUT', path, 'expected_coordinate_pair');
  }
  return [0, 1].map(index => studioRoundHalfEven(studioGridRationalFromPx(ownData(value, index, path))));
}

function rectRing([left, top, right, bottom]) {
  return [[left, top], [right, top], [right, bottom], [left, bottom]];
}

function editablePanel(layout, id) {
  const index = layout.items.findIndex(item => item.id === id);
  const source = layout.items[index];
  if (!source || source.role !== 'panel' || source.hidden || source.locked) {
    fail('STUDIO_PANEL_TARGET', 'command.target_id', 'expected_visible_unlocked_panel');
  }
  if (source.group && layout.items.some(item => item.group === source.group && item.locked)) {
    fail('STUDIO_PANEL_TARGET', 'command.target_id', 'group_locked');
  }
  return {index, source, ring: source.shape?.ring ?? rectRing(source.bbox)};
}

function knifeSource(layout, id) {
  if (id !== null) return editablePanel(layout,id);
  if (layout.items.some(item => item.role === 'panel' && !item.hidden)) {
    fail('STUDIO_PANEL_TARGET', 'command.target_id', 'select_existing_panel');
  }
  return {index: 0, source: null, ring: rectRing([0, 0, layout.width, layout.height])};
}

function transformPanel(before,command) {
  const {index,source,ring}=editablePanel(before.layout,command.target_id);
  let transformed;
  switch(command.op) {
    case 'move_vertex':
      transformed=moveStudioShapeVertex(ring,command.index,command.to,{constraint:command.constraint});break;
    case 'scale':
      transformed=scaleStudioShape(ring,{pivot:command.pivot,scale:command.scale});break;
    case 'rotate':
      transformed=rotateStudioShape(ring,{pivot:command.pivot,quarter_turns:command.quarter_turns});break;
    case 'reset_rect':
      transformed=createStudioQuad(rectRing(source.bbox));break;
    default:
      fail('STUDIO_INVALID_INPUT','command.op','unknown_transform');
  }
  const nextRing=transformed.ring;
  const same=ring.length===nextRing.length && ring.every(([x,y],i)=>x===nextRing[i][0] && y===nextRing[i][1]);
  const report={report_version:1,op:command.op,status:same?'UNCHANGED':'TRANSFORMED',
    item_id:source.id,geometry:transformed.report};
  if (same) return result(before,[],[],report);
  const item={...source,bbox:transformed.bbox,shape:{kind:'polygon',ring:nextRing}};
  return result(replaceItems(before,index,1,[item]),[item.id],[],report);
}

function orderedPieces(pieces) {
  // A reading key derived from the top edge stays transitive for concave, multi-piece cuts.
  // At a shared corner, prefer the panel with a horizontal top edge extending to the right.
  return pieces.map(piece => {
    const xs = piece.ring.map(point => point[0]);
    const ys = piece.ring.map(point => point[1]);
    const top = Math.min(...ys);
    const topXs = xs.filter((_, index) => ys[index] === top);
    return {piece, bbox: [Math.min(...xs), top, Math.max(...xs), Math.max(...ys)],
      topLeft: Math.min(...topXs), topRight: Math.max(...topXs)};
  }).sort((a, b) => a.bbox[1] - b.bbox[1] || a.topLeft - b.topLeft || b.topRight - a.topRight
    || a.bbox[0] - b.bbox[0]);
}

function result(doc, changed_ids, created_ids, report) {
  return {doc, changed_ids, created_ids, reports: [JSON.parse(studioShapeReportJSON(report))]};
}

function replaceItems(before, index, count, inserted) {
  const items = before.layout.items.slice();
  items.splice(index, count, ...inserted);
  const doc = validateStudioDoc({...before, layout: {...before.layout, items}});
  assertStudioShapeTransition(before, doc, {allow_upgrade: false});
  return doc;
}

function alignRow(before,cmd) {
  const ids=cmd.ids;
  if(!Array.isArray(ids)||ids.length<2||ids.length>128||Reflect.ownKeys(ids).length!==ids.length+1)
    fail('STUDIO_PANEL_TARGET','command.ids','expected_two_or_more_panels');
  const selected=[];
  for(let i=0;i<ids.length;i++)selected.push(editablePanel(before.layout,ownData(ids,String(i),'command.ids')));
  if(new Set(selected.map(x=>x.index)).size!==selected.length)fail('STUDIO_PANEL_TARGET','command.ids','duplicate');
  const y=studioPanelRowTarget(selected.map(x=>x.source),cmd.threshold_px);
  const items=[...before.layout.items],changed=[];
  for(const {index,source,ring} of selected) {
    if(source.bbox[1]===y)continue;
    const adjusted=createStudioPolygon(ring.map(([x,oldY])=>[x,oldY===source.bbox[1]?y:oldY]));
    if(adjusted.bbox[1]!==y)fail('STUDIO_PANEL_TARGET','command.ids','top_edge_would_cross_another_vertex');
    items[index]={...source,bbox:adjusted.bbox,shape:{kind:'polygon',ring:adjusted.ring}};
    changed.push(source.id);
  }
  return result(replaceItems(before,0,items.length,items),changed,[],{op:cmd.op,aligned_y:y});
}

function numberText(before,cmd) {
  const items=before.layout.items,index=items.findIndex(i=>i.id===cmd.target_id),item=items[index];
  if(!item||item.label!=='text'||item.locked||item.hidden||item.group&&items.some(i=>i.group===item.group&&i.locked))
    fail('STUDIO_PANEL_TARGET','command.target_id','expected_visible_unlocked_text');
  if(cmd.op==='widen_bubble'){
    const width=cmd.min_width_px,[l,t,r,b]=item.bbox;
    if(!item.bubble||!Number.isFinite(width)||width<=0||width>before.layout.width)
      fail('STUDIO_PANEL_TARGET','command.min_width_px','expected_bubble_and_valid_width');
    if(r-l>=width)return result(before,[],[],{op:cmd.op,status:'UNCHANGED'});
    const left=Math.max(0,Math.min(before.layout.width-width,(l+r-width)/2));
    return result(replaceItems(before,index,1,[{...item,bbox:[left,t,left+width,b]}]),[item.id],[],{op:cmd.op,status:'WIDENED'});
  }
  const text=studioChineseNumberText(item.text??'');
  if(text===(item.text??''))return result(before,[],[],{op:cmd.op,status:'UNCHANGED'});
  return result(replaceItems(before,index,1,[{...item,text}]),[item.id],[],{op:cmd.op,status:'FORMATTED'});
}

function template(before,cmd) {
  const {layout}=before;
  if(layout.items.some(item=>item.role==='panel'))fail('STUDIO_PANEL_TEMPLATE','layout.items','preserve_existing_panels');
  if(cmd.preset==='blank' && layout.items.length)fail('STUDIO_PANEL_TEMPLATE','layout.items','blank_requires_empty_page');
  const frames=studioTemplateFrames(cmd.preset,layout.width,layout.height,cmd.gutter_px);
  const occupied=new Set(layout.items.flatMap(i=>i.group?[i.id,i.group]:[i.id]));
  const inserted=frames.map(points=>{
    const shape=createStudioQuad(points);
    return panelItem(nextPanelId(occupied),shape.ring,shape.bbox);
  });
  const doc=replaceItems(before,0,0,inserted);
  if(inserted.length>1)doc.layout.summary.canvas='multi_panel';
  return result(doc,[],inserted.map(i=>i.id),{op:cmd.op,preset:cmd.preset,status:inserted.length?'CREATED':'UNCHANGED'});
}

/** Pure document operation used identically for preview and commit. Coordinates are document pixels. */
export function applyStudioPanelOp(input, value) {
  const command = readCommand(value);
  const before = validateStudioDoc(input);
  if (before.schema_version !== 2 || before.kind !== 'layout') {
    fail('STUDIO_PANEL_DOCUMENT', 'doc', 'expected_v2_layout');
  }
  const {layout} = before;
  if(command.op==='template')return template(before,command);
  if(command.op==='align_row')return alignRow(before,command);
  if(command.op==='format_numbers'||command.op==='widen_bubble')return numberText(before,command);
  if (Object.hasOwn(command,'target_id') && command.op!=='knife') return transformPanel(before,command);
  const occupied = new Set(layout.items.flatMap(item => item.group ? [item.id, item.group] : [item.id]));
  if (command.op !== 'knife') {
    if (Object.hasOwn(command, 'id') && command.id === undefined) fail('STUDIO_PANEL_ID', 'command.id', 'invalid_or_occupied');
    const id = nextPanelId(occupied, command.id);
    const shape = newShape(command);
    const index = layout.items.findLastIndex(item => item.role === 'panel') + 1;
    const doc = replaceItems(before, index, 0, [panelItem(id, shape.ring, shape.bbox)]);
    return result(doc, [], [id], {report_version: 1, op: command.op, status: 'CREATED', item_id: id, geometry: shape.report});
  }

  const {index, source, ring} = knifeSource(layout, command.target_id);
  const line = studioKnifeLineFromLattice(knifePoint(command.start, 'command.start'), knifePoint(command.end, 'command.end'));
  const cut = studioKnifeSplit({ring, line, gutter: studioGridRationalFromPx(command.gutter_px)});
  const report = {report_version: 1, op: 'knife', status: cut.status, source_id: command.target_id,
    line, gutter: cut.gutter, areas: cut.areas, pieces: []};
  if (!cut.applied) return result(before, [], [], report);
  const inserted = [], created = [];
  for (const {piece, bbox} of orderedPieces(cut.pieces)) {
    const keepSource = source !== null && inserted.length === 0;
    const id = keepSource ? source.id : nextPanelId(occupied);
    const panel = panelItem(id, piece.ring, bbox);
    if (keepSource) {
      inserted.push({...source, bbox, shape: panel.shape});
    } else {
      // A new frame may inherit visual organization, never the source's dialogue, prompts or character data.
      if (source && Object.hasOwn(source, 'color')) panel.color = source.color;
      if (source && Object.hasOwn(source, 'group')) panel.group = source.group;
      inserted.push(panel);
      created.push(id);
    }
    report.pieces.push({item_id: id, side: piece.side, grid_key: piece.grid_key});
  }
  const doc = replaceItems(before, index, source ? 1 : 0, inserted);
  return result(doc, source ? [source.id] : [], created, report);
}
