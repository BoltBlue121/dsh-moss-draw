import {projectStudioLayout,studioCameraMoved} from '../src/studio-camera.mjs';
export function createStudioDocPreview(React){
 const h=React.createElement;
 return function StudioDocPreview({doc,title='文档预览'}){
  const layout=doc.layout,items=layout.items.filter(i=>!i.hidden),text=doc.kind==='caption'?doc.caption.caption:[layout.summary.caption,...items.map(i=>`${i.name||i.id}: ${i.caption}${i.text!==undefined?`\n${i.text}`:''}`)].join('\n\n');
  let view=null,error=null;if(doc.kind==='layout'&&studioCameraMoved(layout))try{view=projectStudioLayout(layout);}catch(e){error=e.message;}
  return h('section',{className:'mps-doc-preview','aria-label':title},h('strong',null,title),
   doc.kind==='layout'&&!error?h('svg',{viewBox:`0 0 ${layout.width} ${layout.height}`,role:'img','aria-label':'文档布局缩略图',style:{display:'block',width:'100%',maxHeight:220,background:'#fff'}},
    h('rect',{x:0,y:0,width:layout.width,height:layout.height,fill:'#fafafa'}),(view?view.order.map(id=>items.find(i=>i.id===id)).filter(Boolean):items).filter(i=>!view||view.items[i.id]?.visible).map(i=>{const [x,y,r,b]=view?view.items[i.id].bbox:i.bbox,c=i.label==='text'?'#d49224':i.label==='character'?'#9963d4':'#3286bc';return h('g',{key:i.id,'data-preview-item':i.id},h('rect',{x,y,width:r-x,height:b-y,fill:c,fillOpacity:.12,stroke:c,strokeWidth:Math.max(layout.width,layout.height)/350}),h('text',{x:x+5,y:y+Math.max(layout.width,layout.height)/35,fill:'#333',fontSize:Math.max(layout.width,layout.height)/35},i.name||i.text||i.label));})):null,
   error?h('p',{role:'alert'},`缩略投影不可用：${error}`):null,
   h('textarea',{'aria-label':`${title}文字`,readOnly:true,value:text}),h('small',{className:'mps-muted'},`${doc.kind} · ${[...text].length} 字符`));
 };
}
