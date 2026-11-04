import {validateStudioDoc} from './studio-domain.mjs';
import {assertStudioAnnotationTransition, readStudioAnnotationCommand} from './studio-annotations.mjs';

function fail(reason,path) {
  const error=new TypeError(`STUDIO_ANNOTATION_OP: ${reason}`);
  Object.assign(error,{code:'STUDIO_ANNOTATION_OP',reason,path});throw error;
}
function allocate(items,prefix,requested) {
  const occupied=new Set(items.flatMap(i=>i.group?[i.id,i.group]:[i.id]));
  if(requested!==undefined) {
    if(occupied.has(requested))fail('occupied_id','id');
    return requested;
  }
  let n=1;
  while(occupied.has(prefix+'-'+n))n++;
  return prefix+'-'+n;
}
function writable(items,id,property) {
  const index=items.findIndex(i=>i.id===id),item=items[index];
  if(!item?.[property] || item.hidden || item.locked || item.group&&items.some(i=>i.group===item.group&&i.locked))fail('target_locked_hidden_or_missing','id');
  return index;
}
function localStroke(command,bbox) {
  const [x,y,r,b]=bbox,points=[];
  for(const [px,py] of command.points) {
    if(px<x||px>r||py<y||py>b)fail('stroke_outside_layer','points');
    const p=[(px-x)/(r-x),(py-y)/(b-y)];
    const a=points.at(-2),z=points.at(-1);
    if(z && p[0]===z[0]&&p[1]===z[1])continue;
    // Remove strictly collinear, forward samples. A turn back carries shape information.
    if(a && (z[0]-a[0])*(p[1]-z[1])===(z[1]-a[1])*(p[0]-z[0])
      && (z[0]-a[0])*(p[0]-z[0])+(z[1]-a[1])*(p[1]-z[1])>0)points.pop();
    points.push(p);
  }
  return {color:command.color,width:command.width,points};
}
export function applyStudioAnnotationOp(input,value) {
  const c=readStudioAnnotationCommand(value),original=validateStudioDoc(input);
  if(original.schema_version!==2 || original.kind!=='layout')fail('requires_v2_layout','doc');
  const items=original.layout.items.slice(),created_ids=[],changed_ids=[];
  if(c.op==='bubble_create'){
    const id=allocate(items,'bubble',c.id);
    const bubble={style:c.style,...(c.tail?{tail:c.tail}:{})};
    items.push({id,label:'text',caption:'Comic dialogue.',bbox:c.bbox,text:c.text,bubble});
    created_ids.push(id);
  }else if(c.op==='bubble_edit'){
    const index=writable(items,c.id,'bubble'),old=items[index],bubble={...old.bubble};
    if(c.style!==undefined)bubble.style=c.style;
    if(Object.hasOwn(c,'tail')){if(c.tail===null)delete bubble.tail;else bubble.tail=c.tail;}
    const next={...old,bubble,...(c.text!==undefined?{text:c.text}:{})};
    if(JSON.stringify(next)!==JSON.stringify(old)){items[index]=next;changed_ids.push(old.id);}
  }else if(c.op==='sketch_stroke' && c.layer_id===null){
    const id=allocate(items,'sketch',c.id),bbox=[0,0,original.layout.width,original.layout.height];
    items.push({id,label:'object',caption:'',bbox,sketch:{strokes:[localStroke(c,bbox)]}});created_ids.push(id);
  }else{
    const index=writable(items,c.layer_id,'sketch'),old=items[index],prev=old.sketch.strokes;
    if(c.op==='sketch_stroke' || prev.length){
      const strokes=c.op==='sketch_clear'?[]:[...prev,localStroke(c,old.bbox)];
      items[index]={...old,sketch:{strokes}};changed_ids.push(old.id);
    }
  }
  const changed=!!(created_ids.length||changed_ids.length);
  const doc=changed?validateStudioDoc({...original,layout:{...original.layout,items}}):original;
  assertStudioAnnotationTransition(original,doc);
  return {doc,changed_ids,created_ids,reports:[{op:c.op,status:changed?'APPLIED':'NO_CHANGE'}]};
}
