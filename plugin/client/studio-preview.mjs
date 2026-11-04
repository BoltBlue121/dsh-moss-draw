import {studioCameraMoved} from '../src/studio-camera.mjs';
import {projectStudioComposition,hasStudioRig} from '../src/studio-composition.mjs';
import {studioAnnotationPrimitives,studioRigPrimitives,studioProjectedAnnotationLayout} from '../src/studio-annotations.mjs';
import {studioPrimitiveSVG} from './studio-artwork.mjs';
import {studioItemRing,studioShapeCameraBlocked} from '../src/studio-shape-render.mjs';
export function createStudioDocPreview(React){
 const h=React.createElement;
 return function StudioDocPreview({doc,title='文档预览'}){
  const layout=doc.layout,items=layout.items.filter(i=>!i.hidden),text=doc.kind==='caption'?doc.caption.caption:[layout.summary.caption,...items.map(i=>`${i.name||i.id}: ${i.caption}${i.text!==undefined?`\n${i.text}`:''}`)].join('\n\n');
  const moved=doc.kind==='layout'&&studioCameraMoved(layout);
  let view=null,error=null;if(moved||hasStudioRig(layout))try{view=projectStudioComposition(layout);}catch(e){error=e.message;}
  // The same shared judgement the Host preview throws on: no rectangle stand-in.
  const shapeBlocked=!error&&studioShapeCameraBlocked(doc);
  const displayed=studioProjectedAnnotationLayout(layout,view);
  const displayedById=new Map(displayed.items.map(item=>[item.id,item]));
  const strokeWidth=Math.max(layout.width,layout.height)/350,fontSize=Math.max(layout.width,layout.height)/35;
  return h('section',{className:'mps-doc-preview','aria-label':title},h('strong',null,title),
   doc.kind==='layout'&&!error?h('svg',{viewBox:`0 0 ${layout.width} ${layout.height}`,role:'img','aria-label':'文档布局缩略图',style:{display:'block',width:'100%',maxHeight:220,background:'#fff'}},
    h('rect',{x:0,y:0,width:layout.width,height:layout.height,fill:'#fafafa'}),(view?view.order.map(id=>items.find(i=>i.id===id)).filter(Boolean):items).filter(i=>!view||view.items[i.id]?.visible).filter(i=>!(shapeBlocked&&Object.hasOwn(i,'shape'))).map(i=>{
     const [x,y,r,b]=view?view.items[i.id].bbox:i.bbox,c=i.label==='text'?'#d49224':i.label==='character'?'#9963d4':'#3286bc';
     const shown=displayedById.get(i.id),rig=studioRigPrimitives(view?.rigs,i.id);
     if(i.bubble||i.sketch||rig.length)return h('g',{key:i.id,'data-preview-item':i.id},[...studioAnnotationPrimitives(displayed,shown),...rig].map((p,index)=>studioPrimitiveSVG(React,p,index)));
     const ring=Object.hasOwn(i,'shape')&&!shapeBlocked?studioItemRing(i):null;
     // Same ring data as the Host preview; the dashed box is the model-visible bbox only.
     if(ring)return h('g',{key:i.id,'data-preview-item':i.id},
      h('polygon',{'data-preview-shape':i.id,points:ring.map(point=>point.join(',')).join(' '),fill:c,fillOpacity:.12,stroke:c,strokeWidth}),
      h('rect',{'data-shape-bbox':i.id,x,y,width:r-x,height:b-y,fill:'none',stroke:c,strokeWidth,strokeDasharray:`${strokeWidth*4} ${strokeWidth*2}`},h('title',null,'模型边界 bbox')),
      h('text',{x:x+5,y:y+fontSize,fill:'#333',fontSize},i.name||i.text||i.label));
     return h('g',{key:i.id,'data-preview-item':i.id},h('rect',{x,y,width:r-x,height:b-y,fill:c,fillOpacity:.12,stroke:c,strokeWidth}),h('text',{x:x+5,y:y+fontSize,fill:'#333',fontSize},i.name||i.text||i.label));
    })):null,
   shapeBlocked?h('p',{role:'alert'},'形状预览暂不支持移动相机：请重置镜头或等待几何投影支持；不会以矩形替代形状。'):null,
   error?h('p',{role:'alert'},`缩略投影不可用：${error}`):null,
   h('textarea',{'aria-label':`${title}文字`,readOnly:true,value:text}),h('small',{className:'mps-muted'},`${doc.kind} · ${[...text].length} 字符`));
 };
}
