import {studioCameraMoved} from './studio-camera.mjs';
import {hasStudioRig, projectStudioComposition} from './studio-composition.mjs';

// Browser-safe v2 annotation schema and projection. Coordinates handed to renderers are document pixels.
export const STUDIO_BUBBLE_STYLES = Object.freeze(['oval', 'thought', 'narration', 'shout']);
const INK = '#222222';
export const STUDIO_SKETCH_MAX_POINTS = 8192;
const MAX_STROKES = 128, MAX_STROKE_POINTS = 1024, MAX_DOC_POINTS = STUDIO_SKETCH_MAX_POINTS;

function invalid(path, reason) {
  const error = new TypeError(`${path}: ${reason}`);
  Object.assign(error, {code:'STUDIO_INVALID_INPUT', path, reason}); throw error;
}
function fields(value, names, required, path) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path, 'expected_plain_record');
  const out = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    if (!names.includes(key)) invalid(path, 'unknown_field');
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d.enumerable || !Object.hasOwn(d,'value')) invalid(path, 'expected_data_property');
    out[key] = d.value;
  }
  if (required.some(k => !Object.hasOwn(out,k))) invalid(path, 'missing_field');
  return out;
}
function array(value, low, high, path, check) {
  if (!Array.isArray(value) || value.length < low || value.length > high || Reflect.ownKeys(value).length !== value.length + 1) invalid(path,'array_size');
  const out = [];
  for (let i=0; i<value.length; i++) {
    const d=Object.getOwnPropertyDescriptor(value,i);
    if (!d || !d.enumerable || !Object.hasOwn(d,'value')) invalid(path,'expected_array_data');
    out.push(check(d.value,path+'['+i+']'));
  }
  return out;
}
function number(value,low,high,path) {
  if (!Number.isFinite(value) || value < low || value > high) invalid(path,'number_range');
  return value;
}
function point(value,low,high,path) {
  return array(value,2,2,path,(v,p)=>number(v,low,high,p));
}
function tail(value,path) {
  const data=fields(value,['point','speaker_id','anchor'],[],path);
  if (Object.hasOwn(data,'point') && Object.keys(data).length===1) return {point:point(data.point,-16384,16384,path+'.point')};
  if (typeof data.speaker_id!=='string' || !data.speaker_id.trim() || data.speaker_id.length>80 || Object.hasOwn(data,'point')) invalid(path,'invalid_speaker');
  return {speaker_id:data.speaker_id,anchor:point(data.anchor,0,1,path+'.anchor')};
}
export function validateStudioBubble(value,path='item.bubble') {
  const data=fields(value,['style','tail'],['style'],path);
  if (!STUDIO_BUBBLE_STYLES.includes(data.style)) invalid(path+'.style','unknown_style');
  const result={style:data.style};
  if (Object.hasOwn(data,'tail')) {
    if (!['oval','shout'].includes(data.style)) invalid(path+'.tail','style_has_no_tail');
    result.tail=tail(data.tail,path+'.tail');
  }
  return result;
}
function stroke(value,path) {
  const data=fields(value,['color','width','points'],['color','width','points'],path);
  if (typeof data.color!=='string' || !/^#[0-9a-f]{6}$/.test(data.color)) invalid(path+'.color','expected_hex_rgb');
  return {color:data.color,width:number(data.width,0.25,64,path+'.width'),
    points:array(data.points,1,MAX_STROKE_POINTS,path+'.points',(v,p)=>point(v,0,1,p))};
}
export function validateStudioSketch(value,path='item.sketch') {
  const data=fields(value,['strokes'],['strokes'],path);
  let count=0;
  return {strokes:array(data.strokes,0,MAX_STROKES,path+'.strokes',(v,p)=>{
    const clean=stroke(v,p);
    count+=clean.points.length;if(count>MAX_DOC_POINTS)invalid(path,'sketch_point_budget');
    return clean;
  })};
}
/** The caller has already validated every field and ID. Resolve relations only inside the same document. */
export function assertStudioAnnotations(doc) {
  const items=doc.layout.items,byId=new Map(items.map(i=>[i.id,i]));
  let total=0;
  for (const item of items) {
    if (!item.sketch && !item.bubble) continue;
    if (doc.schema_version!==2 || item.role || item.shape || item.bubble && item.sketch) invalid(item.id,'incompatible_annotation');
    if (item.sketch) {
      if (item.label!=='object') invalid(item.id,'sketch_requires_object');
      for(const s of item.sketch.strokes) total+=s.points.length;
      if(total>MAX_DOC_POINTS)invalid('layout.items','sketch_point_budget');
    } else {
      if (item.label!=='text' || typeof item.text!=='string') invalid(item.id,'bubble_requires_text_item');
      const id=item.bubble.tail?.speaker_id;
      if (id!==undefined && byId.get(id)?.label!=='character') invalid(item.id,'dangling_bubble_speaker');
    }
  }
  return true;
}
const commands = {
  bubble_create: [['op','id','bbox','style','text','tail'],['op','bbox','style','text']],
  bubble_edit: [['op','id','style','text','tail'],['op','id']],
  sketch_stroke: [['op','id','layer_id','points','color','width'],['op','layer_id','points','color','width']],
  sketch_clear: [['op','layer_id'],['op','layer_id']],
};
export function readStudioAnnotationCommand(value) {
  const d=value && typeof value==='object' && Object.getOwnPropertyDescriptor(value,'op');
  if(!d || !Object.hasOwn(d,'value') || typeof d.value!=='string' || !Object.hasOwn(commands,d.value)) invalid('command.op','unknown_operation');
  const [keys,required]=commands[d.value],c=fields(value,keys,required,'command');
  if(Object.hasOwn(c,'id') && (typeof c.id!=='string' || !c.id.trim() || c.id.length>80))invalid('command.id','invalid_id');
  if(Object.hasOwn(c,'layer_id') && c.layer_id!==null && (typeof c.layer_id!=='string'||!c.layer_id.trim()||c.layer_id.length>80))invalid('command.layer_id','invalid_id');
  if(c.op==='bubble_edit' && Object.keys(c).length<3)invalid('command','empty_edit');
  if(Object.hasOwn(c,'text') && (typeof c.text!=='string'||c.text.length>12000))invalid('command.text','text_size');
  if(Object.hasOwn(c,'style')&&!STUDIO_BUBBLE_STYLES.includes(c.style))invalid('command.style','unknown_style');
  if(Object.hasOwn(c,'tail') && c.tail!==null)c.tail=tail(c.tail,'command.tail');
  if(c.op==='bubble_create') {
    c.bbox=array(c.bbox,4,4,'command.bbox',(v,p)=>number(v,-16384,16384,p));
    if(c.bbox[0]>=c.bbox[2]||c.bbox[1]>=c.bbox[3])invalid('command.bbox','positive_bbox');
  }
  if(c.op==='sketch_stroke') {
    if(c.layer_id!==null && Object.hasOwn(c,'id'))invalid('command.id','new_layer_only');
    c.points=array(c.points,1,MAX_STROKE_POINTS,'command.points',(v,p)=>point(v,-16384,16384,p));
    if(typeof c.color!=='string'||!/^#[0-9a-f]{6}$/.test(c.color))invalid('command.color','expected_hex_rgb');
    number(c.width,.25,64,'command.width');
  }
  return c;
}
function tipFor(item,items) {
  const tail=item.bubble?.tail;
  if(!tail)return null;
  if(tail.point)return tail.point;
  const speaker=items.find(i=>i.id===tail.speaker_id);
  if(!speaker || speaker.hidden)return null;
  return mapPoint(speaker.bbox,tail.anchor);
}
function mapPoint([x,y,r,b],[u,v]) { return [x+(r-x)*u,y+(b-y)*v]; }
export function studioProjectedAnnotationLayout(layout,view) {
  if(!view)return layout;
  return {...layout,items:layout.items.map(item=>{
    const box=view.items[item.id];
    return {...item,hidden:!!item.hidden||!box?.visible,bbox:box?.bbox??item.bbox};
  })};
}
function displayItems(layout) {
  const view=studioCameraMoved(layout)||hasStudioRig(layout)?projectStudioComposition(layout):null;
  return studioProjectedAnnotationLayout(layout,view).items;
}
/** A locked speech bubble also protects its resolved tail from indirect edits to its speaker. */
export function assertStudioAnnotationTransition(before,after) {
  const old=before.layout.items,now=after.layout.items;
  let oldDisplay,newDisplay;
  for(const item of old) {
    if(!item.locked || !item.bubble?.tail?.speaker_id)continue;
    const next=now.find(i=>i.id===item.id);
    if(!next)continue;
    oldDisplay??=displayItems(before.layout);newDisplay??=displayItems(after.layout);
    if(JSON.stringify(tipFor(item,oldDisplay))!==JSON.stringify(tipFor(next,newDisplay))) {
      const error=new Error('Locked bubble depends on speaker position: '+item.id);
      error.code='STUDIO_LOCKED';throw error;
    }
  }
  return true;
}
function outline(style,cx,cy,rx,ry) {
  if(style==='narration')return [[cx-rx,cy-ry],[cx+rx,cy-ry],[cx+rx,cy+ry],[cx-rx,cy+ry]];
  const points=[],count=style==='shout'?32:72;
  for(let i=0;i<count;i++) {
    const a=Math.PI*2*i/count;
    const factor=style==='shout'?(i%2?.77:1):style==='thought'?(.9+.1*Math.cos(12*a)):1;
    points.push([cx+rx*factor*Math.cos(a),cy+ry*factor*Math.sin(a)]);
  }
  return points;
}
function bubbleLines(text,cx,cy,rx,ry) {
  const innerWidth=rx*1.4,innerHeight=ry*1.35,size=Math.max(1, Math.min(32,innerWidth/2,innerHeight/2));
  const maxLines=Math.max(1,Math.floor(innerHeight/(size*1.2))),rows=[];
  // Count Unicode code points and keep explicit paragraph breaks; freeze wrapping for SVG and PNG alike.
  let line='',used=0;
  for(const char of text.replace(/\r\n?/g,'\n')) {
    const width=char.codePointAt(0)>255?1:.62;
    if(char==='\n'||(line && (used+width)*size>innerWidth)) {
      rows.push(line);line='';used=0;
      if(rows.length>=maxLines){rows[rows.length-1]=rows.at(-1).replace(/.$/u,'')+'…';break;}
      if(char==='\n')continue;
    }
    line+=char;used+=width;
  }
  if(rows.length<maxLines)rows.push(line);
  return {kind:'text',lines:rows.map((value,i)=>({text:value,x:cx,y:cy+(i-(rows.length-1)/2)*size*1.2})),
    size,color:INK,clip:[cx-innerWidth/2,cy-innerHeight/2,cx+innerWidth/2,cy+innerHeight/2]};
}
/** Pass the displayed items and bounding boxes together when projecting a director view. */
export function studioAnnotationPrimitives(layout,item) {
  if(item.hidden)return [];
  if(item.sketch)return item.sketch.strokes.map(s=>({kind:'line',points:s.points.map(p=>mapPoint(item.bbox,p)),color:s.color,width:s.width}));
  if(!item.bubble)return [];
  const [x,y,r,b]=item.bbox,rx=(r-x)/2,ry=(b-y)/2,cx=x+rx,cy=y+ry,width=Math.max(.5,Math.min(3,rx/12,ry/12));
  const polygons=[],tip=tipFor(item,layout.items);
  const poly=points=>({kind:'polygon',points,stroke:INK,fill:'#ffffff',width});
  if(tip) {
    const dx=(tip[0]-cx)/rx,dy=(tip[1]-cy)/ry;
    if(Math.hypot(dx,dy)>1) {
      const a=Math.atan2(dy,dx),base=[a-.18,a+.18].map(t=>[cx+.83*rx*Math.cos(t),cy+.83*ry*Math.sin(t)]);
      polygons.push(poly([base[0],tip,base[1]]));
    }
  }
  polygons.push(poly(outline(item.bubble.style,cx,cy,rx,ry)),bubbleLines(item.text,cx,cy,rx,ry));
  return polygons;
}

export function studioRigPrimitives(rigs,id) {
  const joint=rigs?.joints?.get(id),prop=rigs?.props?.get(id),parts=joint??prop;
  if(!parts)return [];
  const color=joint?'#65419a':'#264e80',width=2;
  const result=(joint?.surfaces??[]).map(surface=>({kind:'polygon',points:surface.ring,
    fill:/spine|chest|hips/.test(surface.part)?'#ac90ca':'#d8c6e8',stroke:color,width:1}));
  for(const points of parts.segments)result.push({kind:'line',points,color,width});
  if(joint?.points.head && joint.headRadius>0){
    const [cx,cy]=joint.points.head,points=[];
    for(let i=0;i<=32;i++){const a=i*Math.PI/16;points.push([cx+joint.headRadius*Math.cos(a),cy+joint.headRadius*Math.sin(a)]);}
    result.push({kind:'line',points,color,width});
  }
  return result;
}
