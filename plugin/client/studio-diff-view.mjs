import {wordDiff} from './studio-diff.mjs';
const inspect=value=>value===undefined?'（无）':JSON.stringify(value,null,2);
function textFields(before,after){
 if(typeof before==='string'||typeof after==='string')return[{key:'text',before:typeof before==='string'?before:'',after:typeof after==='string'?after:''}];
 const fields=[];for(const key of ['caption','text','name','label','group']){const a=before?.[key],b=after?.[key];if((typeof a==='string'||typeof b==='string')&&a!==b)fields.push({key,before:typeof a==='string'?a:'',after:typeof b==='string'?b:''});}return fields;
}
export function createStudioDiffView(React){
 const h=React.createElement;
 return function ChangeDiff({change,selected,pending,onSelect}){
  const [open,setOpen]=React.useState(false),[raw,setRaw]=React.useState(false);
  const fields=open?textFields(change.before,change.after):[];
  return h('details',{onToggle:e=>setOpen(e.currentTarget.open)},h('summary',null,h('input',{type:'checkbox','aria-label':change.label,checked:selected,disabled:!pending,onClick:e=>e.stopPropagation(),onChange:e=>onSelect(e.target.checked)}),h('span',null,change.label)),
   open?h('div',{className:'mps-diff'},fields.map(field=>{const diff=wordDiff(field.before,field.after);return h('div',{key:field.key},h('small',null,field.key),h('div',{className:'mps-word-diff'},diff.segments.map((part,index)=>h(part.kind==='insert'?'ins':part.kind==='delete'?'del':'span',{key:index},part.text))),diff.truncated?h('small',null,'改动较多，使用有界段落差异；原文未截断。'):null);}),
    h('button',{type:'button',onClick:()=>setRaw(!raw)},raw?'收起JSON':'查看完整JSON'),
    raw||!fields.length?h('div',null,h('span',null,'修改前'),h('pre',{className:'mps-code'},inspect(change.before)),h('span',null,'修改后'),h('pre',{className:'mps-code'},inspect(change.after))):null):null);
 };
}
