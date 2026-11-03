import {validateStudioDoc} from './studio-domain.mjs';
import {projectStudioLayout,studioCameraMoved} from './studio-camera.mjs';
import {encodePng,regionOverlay} from './region-pixels.mjs';

// Deterministic blockout pixels, not model-generated art or a reconstructed reference.
export function renderStudioPreview(doc){
 const clean=validateStudioDoc(doc),layout=clean.layout,scale=Math.min(1,768/Math.max(layout.width,layout.height));
 const width=Math.max(1,Math.round(layout.width*scale)),height=Math.max(1,Math.round(layout.height*scale)),pixels=Buffer.alloc(width*height*4,248);
 for(let i=3;i<pixels.length;i+=4)pixels[i]=255;
 const projected=studioCameraMoved(layout)?projectStudioLayout(layout):null,byId=new Map(layout.items.map(i=>[i.id,i])),rows=projected?projected.order.map(id=>byId.get(id)):layout.items,legend=[],boxes=[];
 if(clean.kind==='layout')for(const item of rows){
  const view=projected?.items[item.id];if(item.hidden||projected&&!view?.visible)continue;
  const source=view?.bbox??item.bbox,box=source.map((n,i)=>Math.max(0,Math.min(i%2?height:width,Math.round(n*scale))));
  if(box[2]<=box[0]||box[3]<=box[1])continue;
  const rgb=item.label==='character'?[190,169,225]:item.label==='text'?[241,211,157]:[158,201,230];
  for(let y=box[1];y<box[3];y++)for(let x=box[0];x<box[2];x++){const p=(y*width+x)*4;for(let c=0;c<3;c++)pixels[p+c]=rgb[c];}
  boxes.push({box});legend.push({number:boxes.length,id:item.id,label:item.label,name:item.name??'',caption:item.caption,...(item.text===undefined?{}:{text:item.text}),bbox:source,locked:!!item.locked});
 }
 const base=encodePng({width,height,pixels});return{data:boxes.length?regionOverlay(base,boxes):base,width,height,legend,kind:clean.kind,caption:clean.kind==='caption'?clean.caption.caption:layout.summary.caption,preview_kind:'layout-blockout',note:'Numbered composition blockout only; colors are type markers, not artwork or reference pixels.'};
}
