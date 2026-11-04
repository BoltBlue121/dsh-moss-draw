import {compileStudioDoc,emptyStudioDoc,validateStudioDoc} from './studio-domain.mjs';
import {projectStudioComposition,hasStudioRig} from './studio-composition.mjs';
import {studioCameraMoved} from './studio-camera.mjs';
import {studioProjectedAnnotationLayout} from './studio-annotations.mjs';

export const STUDIO_EXCHANGE_MAX_BYTES=2*1024*1024;
const FORMAT='dsh-moss-studio';
function fail(reason){const e=new TypeError('STUDIO_EXCHANGE_INVALID: '+reason);e.code='STUDIO_EXCHANGE_INVALID';throw e;}
function known(value,allowed,required,path){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)fail(path+' 需要对象');
  for(const key of Object.keys(value))if(!allowed.includes(key))fail(path+' 含不支持的字段 '+key);
  for(const key of required)if(!Object.hasOwn(value,key))fail(path+' 缺少 '+key);
}
export function encodeStudioExchange(doc,title=''){
  if(typeof title!=='string'||title.length>200)fail('无效页名');
  return JSON.stringify({format:FORMAT,version:1,title,doc:validateStudioDoc(doc)});
}
export function studioMossCompatibility(doc){
  const clean=validateStudioDoc(doc);
  if(clean.kind!=='layout')fail('请选择 Layout 页');
  // An empty working canvas is a valid interchange file even though it cannot
  // be submitted for generation. Preserve its summary for the upstream editor.
  if(!clean.layout.items.length)return JSON.stringify({summary:clean.layout.summary,items:[],bbox_coord_space:'abs_centralized',bbox_format:'yxyx'},null,2);
  const built=compileStudioDoc(clean);
  if(!built.compiled)fail(built.checks.map(c=>c.message).join('；')||'Layout 尚未通过编译');
  // Moeblack's importer expects model items, not authoring metadata. Export precisely its wire vocabulary.
  const model=JSON.parse(built.prompt),items=model.items.map(({label,bbox,caption,text})=>
    ({label,bbox,caption,...(label==='text'?{text:text??''}:{})}));
  for(const i of items) {
    const [t,l,b,r]=i.bbox,{width,height}=clean.layout;
    if(t < -height/2 || l < -width/2 || b>height/2 || r>width/2)fail('画外框超出上游兼容导入范围，请导出完整工作稿');
  }
  return JSON.stringify({summary:model.summary,items,bbox_coord_space:'abs_centralized',bbox_format:'yxyx'},null,2);
}
export function readStudioExchange(text,{width,height}={}){
  if(typeof text!=='string'||text.length>STUDIO_EXCHANGE_MAX_BYTES||new TextEncoder().encode(text).length>STUDIO_EXCHANGE_MAX_BYTES)fail('文件超过 2 MiB');
  let v;try{v=JSON.parse(text);}catch{fail('无法解析 JSON');}
  if(v&&Object.hasOwn(v,'format')){
    known(v,['format','version','title','doc'],['format','version','title','doc'],'文件');
    if(v.format!==FORMAT||v.version!==1)fail('未知工作稿类型或版本');
    if(typeof v.title!=='string'||v.title.length>200)fail('无效页名');
    return {kind:'studio',title:v.title,doc:validateStudioDoc(v.doc),losses:[]};
  }
  known(v,['summary','items','bbox_format','bbox_coord_space'],['summary','items','bbox_format','bbox_coord_space'],'MOSS JSON');
  if(v.bbox_format!=='yxyx'||v.bbox_coord_space!=='abs_centralized')fail('需要 abs_centralized / yxyx');
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<16||height<16||width>4096||height>4096||width%16||height%16)fail('请明确指定原始画布宽高，为 16 到 4096 的 16 倍数');
  const doc=emptyStudioDoc('layout');doc.layout.width=width;doc.layout.height=height;
  known(v.summary,['caption','canvas','meta','palette'],['caption'],'summary');doc.layout.summary=v.summary;
  if(!Array.isArray(v.items)||v.items.length>128)fail('无效图层数量');
  doc.layout.items=v.items.map((item,index)=>{
    known(item,['label','caption','bbox','text'],['label','caption','bbox'],'items['+index+']');
    if(!Array.isArray(item.bbox)||item.bbox.length!==4||!item.bbox.every(Number.isSafeInteger))fail('框需要四个整数');
    const [t,l,b,r]=item.bbox;
    if(t < -height/2 || l < -width/2 || b>height/2 || r>width/2)fail('框超出指定画布，请核对来源尺寸');
    return {...item,id:'import-'+(index+1),bbox:[l+width/2,t+height/2,r+width/2,b+height/2]};
  });
  return {kind:'moss',title:'MOSS 布局副本',doc:validateStudioDoc(doc),
    losses:['上游文件只保存模型描述与矩形框；原始分镜轮廓、稳定 ID、姿态、草图、隐藏图层和历史无法从此文件恢复。']};
}
export function studioAnnotationMarkdown(doc){
  const d=validateStudioDoc(doc),l=d.layout;
  const line=v=>String(v??'').replace(/[\r\n]+/g,' ').replace(/([\\\x60*_<>\[\]])/g,'\\$1');
  if(d.kind==='caption')return ['# Caption 注释',line(d.caption.caption)].join('\n');
  const view=studioCameraMoved(l)||hasStudioRig(l)?projectStudioComposition(l):null;
  const items=studioProjectedAnnotationLayout(l,view).items,byId=new Map(items.map(i=>[i.id,i]));
  const ordered=view?view.order.map(id=>byId.get(id)):items;
  const rows=ordered.filter(i=>!i.hidden).map((i,n)=>`- ${n+1}. ${line(i.name||i.id)} [${line(i.role??(i.bubble?'bubble':i.sketch?'sketch':i.label))}] · xyxy [${i.bbox.map(x=>Math.round(x*100)/100).join(', ')}] · ${line(i.text??i.caption)}`);
  return [`# Layout 注释 · ${l.width} × ${l.height}`,line(l.summary.caption),...rows].join('\n');
}
