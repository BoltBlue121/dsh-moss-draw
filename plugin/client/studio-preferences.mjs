import {T2I_MODELS} from '../src/catalog.mjs';
// Browser-local choices are shared with the task on manual handoff.
const KEY='moss-studio:editing-preferences:v1';
export function loadStudioPreferences(storage){
 try{storage??=globalThis.localStorage;const p=JSON.parse(storage?.getItem(KEY)??'{}');return{...(p.negative_custom===true?{negative_custom:true}:{}),...(T2I_MODELS.includes(p.t2i_model)?{t2i_model:p.t2i_model}:{}),prefix:typeof p.prefix==='string'?p.prefix.slice(0,12000):'',negative:typeof p.negative==='string'?p.negative.slice(0,12000):'',autoCompile:p.autoCompile!==false};}
 catch{return{prefix:'',negative:'',autoCompile:true};}
}
export function saveStudioPreferences(p,storage){try{storage??=globalThis.localStorage;storage?.setItem(KEY,JSON.stringify(p));}catch{/* Session memory remains usable if browser storage is unavailable. */}}
export function prefixedStudioPrompt(prefix,prompt){const p=prefix.trim().replace(/[,，]+$/u,'').trim();return p?`${p}, ${prompt}`:prompt;}
export const STUDIO_QUICK_REQUESTS=Object.freeze([
 ['补全描述','补全空缺或过短的描述，保留已有构图与明确文字。'],['检查问题','检查描述、框、遮挡和文字之间的矛盾，提出必要修正。'],
 ['按视角改描述','按当前相机视角修正描述，保留物体身份和锁定项目。'],['整理图层','整理图层顺序、组与前后景关系，不改变锁定项目。'],
 ['同系列新页','参考当前页，在同系列建立新页；先说明延续和变化。'],['写成 Caption','将当前画面写为完整 Caption，保留 Layout 分支。'],
]);
export function studioAssistStats(doc,ids=[],onlySelection=false){const items=doc.layout.items.filter(i=>!i.hidden&&(!onlySelection||ids.includes(i.id)));return{empty:items.filter(i=>!i.caption.trim()).length,short:items.filter(i=>i.caption.trim()&&i.caption.trim().length<16).length,missingText:items.filter(i=>i.label==='text'&&!i.text?.trim()).length};}
export function studioAssistRequest({fill=true,camera=true,unify=false,check=true,onlySelection=false}={}){return[
 fill?'补全缺失与过短描述、缺字文字框。':'',camera?'根据当前机位调整视角描述。':'',unify?'统一用词和画面风格。':'',check?'检查框、描述、层序及遮挡矛盾。':'',onlySelection?'只修改选中框；保留其它项目。':'',
].filter(Boolean).join('\n');}
