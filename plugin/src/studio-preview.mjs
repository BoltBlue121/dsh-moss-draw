import {validateStudioDoc} from './studio-domain.mjs';
import {studioCameraMoved} from './studio-camera.mjs';
import {hasStudioRig,projectStudioComposition} from './studio-composition.mjs';
import {studioAnnotationPrimitives,studioRigPrimitives} from './studio-annotations.mjs';
import {encodePng,regionOverlay} from './region-pixels.mjs';
import {studioDocSchemaVersion} from './studio-doc-version.mjs';
import {fillRingScanline,studioItemRing,studioPreviewRenderer,studioShapeFidelity,studioShapeCameraBlocked,STUDIO_SHAPE_CAMERA_CODE,STUDIO_SHAPE_CAMERA_MESSAGE} from './studio-shape-render.mjs';

const BLOCKOUT_NOTE='Numbered composition blockout only; colors are type markers, not artwork or reference pixels.';
// Never claims mask/pose control: the model only ever receives the bounding box.
const SHAPE_NOTE='形状用于预览和编辑；模型只接收 bbox，不是 hard mask 或 pose control。';

function rgbFromHex(color){return [1,3,5].map(i=>parseInt(color.slice(i,i+2),16));}

// Scan only the stroke-width strip around a segment. Very long off-screen
// segments are clipped implicitly by the bounded output scan rows and columns.
function strokeSegment(image,a,b,color,stroke,scale){
 const [ax,ay]=a.map(v=>v*scale),[bx,by]=b.map(v=>v*scale);
 const dx=bx-ax,dy=by-ay,len2=dx*dx+dy*dy,r=Math.max(.65,stroke*scale/2),r2=r*r;
 const edge=r*Math.sqrt(len2);
 const lowX=Math.max(0,Math.floor(Math.min(ax,bx)-r)),highX=Math.min(image.width-1,Math.ceil(Math.max(ax,bx)+r));
 const lowY=Math.max(0,Math.floor(Math.min(ay,by)-r)),highY=Math.min(image.height-1,Math.ceil(Math.max(ay,by)+r));
 for(let y=lowY;y<=highY;y++){
  const yy=y+.5-ay;
  let start=lowX,end=highX;
  if(dy!==0){
   const cx=ax+yy*dx/dy,span=edge/Math.abs(dy);
   start=Math.max(start,Math.floor(cx-span));end=Math.min(end,Math.ceil(cx+span));
  }
  for(let x=start;x<=end;x++){
   const xx=x+.5-ax,t=len2===0?0:Math.max(0,Math.min(1,(xx*dx+yy*dy)/len2));
   if((xx-t*dx)**2+(yy-t*dy)**2<=r2)image.pixels.set(color,4*(y*image.width+x));
  }
 }
}

function paintPrimitives(image,parts,scale){
 for(const part of parts){
  if(part.kind==='text')continue; // Exact dialogue stays in the numbered legend.
  const polygon=part.kind==='polygon',points=part.points;
  if(polygon)fillRingScanline(points,image.pixels,image.width,image.height,rgbFromHex(part.fill),scale);
  const color=rgbFromHex(polygon?part.stroke:part.color);
  if(points.length===1)strokeSegment(image,points[0],points[0],color,part.width,scale);
  for(let i=1;i<points.length;i++)strokeSegment(image,points[i-1],points[i],color,part.width,scale);
  if(polygon)strokeSegment(image,points.at(-1),points[0],color,part.width,scale);
 }
}

// Deterministic blockout pixels, not model-generated art or a reconstructed reference.
export function renderStudioPreview(doc){
 const clean=validateStudioDoc(doc);
 // A moved camera cannot project a ring, so refuse exactly like compile does instead of
 // returning a PNG where the shape silently degenerated to its rectangle.
 if(studioShapeCameraBlocked(clean)){const error=new Error(STUDIO_SHAPE_CAMERA_MESSAGE);error.code=STUDIO_SHAPE_CAMERA_CODE;throw error;}
 const layout=clean.layout,scale=Math.min(1,768/Math.max(layout.width,layout.height));
 const width=Math.max(1,Math.round(layout.width*scale)),height=Math.max(1,Math.round(layout.height*scale)),pixels=Buffer.alloc(width*height*4,248);
 for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
 const version=studioDocSchemaVersion(clean),v2=version===2,fidelity=v2?studioShapeFidelity(clean):'none';
 const projected=studioCameraMoved(layout)||hasStudioRig(layout)?projectStudioComposition(layout):null;
 const displayed=projected?{...layout,items:layout.items.map(i=>({...i,bbox:projected.items[i.id].bbox,hidden:!projected.items[i.id].visible}))}:layout;
 const byId=new Map(displayed.items.map(i=>[i.id,i])),rows=projected?projected.order.map(id=>byId.get(id)):layout.items,legend=[],boxes=[];
 let shapes=0;
 if(clean.kind==='layout')for(const item of rows){
  const view=projected?.items[item.id];if(item.hidden||projected&&!view?.visible)continue;
  const source=view?.bbox??item.bbox,box=source.map((n,i)=>Math.max(0,Math.min(i%2?height:width,Math.round(n*scale))));
  if(box[2]<=box[0]||box[3]<=box[1])continue;
  const rgb=item.label==='character'?[190,169,225]:item.label==='text'?[241,211,157]:[158,201,230];
  // The ring is painted from its real polygon; a shape never degrades to a rectangle.
  const ring=v2?studioItemRing(item):null;
  const primitives=[...studioAnnotationPrimitives(displayed,item),...studioRigPrimitives(projected?.rigs,item.id)];
  if(primitives.length||item.sketch)paintPrimitives({pixels,width,height},primitives,scale);
  else if(ring)fillRingScanline(ring,pixels,width,height,rgb,scale);
  else for(let y=box[1];y<box[3];y++)for(let x=box[0];x<box[2];x++){const p=(y*width+x)*4;for(let c=0;c<3;c++)pixels[p+c]=rgb[c];}
  if(ring)shapes++;
  boxes.push({box});legend.push({number:boxes.length,id:item.id,label:item.label,name:item.name??'',caption:item.caption,...(item.text===undefined?{}:{text:item.text}),bbox:source,locked:!!item.locked,...(ring?{shape:'polygon'}:{})});
 }
 const base=encodePng({width,height,pixels});
 let note=fidelity==='bbox-only'?`${SHAPE_NOTE} ${BLOCKOUT_NOTE}`:BLOCKOUT_NOTE;
 if(rows.some(i=>!i.hidden&&i.bubble))note+=' 对白原文见对应编号的 text 图例。';
 if(rows.some(i=>!i.hidden&&(i.rig||i.sketch)))note+=' 人偶姿势和草线是编辑参考，生成条件以本版实际编译输出为准。';
 return{data:boxes.length?regionOverlay(base,boxes):base,width,height,legend,kind:clean.kind,caption:clean.kind==='caption'?clean.caption.caption:layout.summary.caption,preview_kind:'layout-blockout',note,...(v2?{preview_renderer:studioPreviewRenderer(clean),shape_fidelity:shapes?'bbox-only':'none'}:{})};
}
