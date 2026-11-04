import {validateStudioDoc} from './studio-domain.mjs';
import {studioBody,studioCameraMoved,projectStudioLayout,moveStudioItems} from './studio-camera.mjs';
import {hasStudioRig,projectStudioComposition} from './studio-composition.mjs';
const fail=message=>{throw new Error(`STUDIO_LAYOUT: ${message}`);};
export const failShape=()=>{const error=new Error('STUDIO_SHAPE_OPERATION_UNSUPPORTED: 带形状的对象暂不支持移动、缩放或复制；请先移除形状或等待几何变换支持。');error.code='STUDIO_SHAPE_OPERATION_UNSUPPORTED';throw error;};
const valid=(l,schemaVersion=1)=>{if(schemaVersion!==1&&schemaVersion!==2)fail('Unsupported document schema version.');return validateStudioDoc({kind:'layout',layout:l,caption:{caption:''},...(schemaVersion===2?{schema_version:2}:{})}).layout;};
const round=n=>Math.round(n*1000)/1000;
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
function box(b){if(!Array.isArray(b)||b.length!==4||b.some(n=>!Number.isFinite(n))||b[2]<b[0]||b[3]<b[1])fail('Invalid box.');}
function targets(layout,ids,individual=false){if(!Array.isArray(ids)||ids.length>128||ids.some(id=>typeof id!=='string'||!layout.items.some(i=>i.id===id)))fail('Unknown item selection.');const set=new Set(ids),groups=new Set(individual?[]:layout.items.filter(i=>set.has(i.id)&&i.group).map(i=>i.group));return layout.items.filter(i=>set.has(i.id)||i.group&&groups.has(i.group));}
export function fitStudioCanvas(input,width,height,{schemaVersion=1}={}){const layout=valid(input,schemaVersion),shapeBefore=new Map(layout.items.filter(item=>!item.locked&&Object.hasOwn(item,'shape')).map(item=>[item.id,item.bbox.slice()]));if(!Number.isInteger(width)||!Number.isInteger(height)||width<16||height<16||width>4096||height>4096||width%16||height%16)fail('Canvas dimensions must be 16..4096 multiples of 16.');const scale=Math.min(width/layout.width,height/layout.height),ox=(width-layout.width*scale)/2,oy=(height-layout.height*scale)/2;
 for(const item of layout.items){if(item.locked)continue;const b=item.bbox,next=b.map((n,i)=>round(n*scale+(i%2?oy:ox)));if(Math.abs(b[0])<=2&&Math.abs(b[2]-layout.width)<=2){next[0]=0;next[2]=width;}if(Math.abs(b[1])<=2&&Math.abs(b[3]-layout.height)<=2){next[1]=0;next[3]=height;}item.bbox=next;}for(const [id,before] of shapeBefore)if(layout.items.find(entry=>entry.id===id).bbox.some((value,index)=>value!==before[index]))failShape();layout.width=width;layout.height=height;return valid(layout,schemaVersion);
}
export function moveStudioVisual(input,ids,dx,dy,{individual=false,freeze=false,follow=false,projected=undefined,grabId=null,schemaVersion=1}={}){
 const layout=valid(input,schemaVersion);if(!Number.isFinite(dx)||!Number.isFinite(dy))fail('Move delta must be finite.');const blocked=new Set(individual?[]:layout.items.filter(i=>i.locked&&i.group).map(i=>i.group)),members=targets(layout,ids,individual).filter(i=>!i.locked&&(!i.group||!blocked.has(i.group)));if(!members.length||dx===0&&dy===0)return layout;const shapeBefore=new Map(layout.items.filter(item=>Object.hasOwn(item,'shape')).map(item=>[item.id,item.bbox.slice()]));const before=new Map(members.map(item=>[item.id,item.bbox.slice()]));
 if(members.some(item=>item.rig||item.attachment))fail('人偶与挂接道具请在镜头调度移动，挂接位置由关节与偏移决定。');
 const active=projected??studioCameraMoved(layout);let result=layout;
 if(active){const world=members.filter(i=>studioBody(i,layout).anchor==='world').map(i=>i.id);if(world.length)result=moveStudioItems(layout,world,dx,dy,{individual,freeze:freeze&&!individual,follow,grabId:world.includes(grabId)?grabId:null});const fixed=new Set(members.filter(i=>studioBody(i,layout).anchor!=='world').map(i=>i.id));for(const item of result.items)if(fixed.has(item.id)){if(!item.body&&studioBody(item,layout).anchor==='backdrop')item.body=studioBody(item,layout);item.bbox=item.bbox.map((n,i)=>round(n+(i%2?dy:dx)));}}
 else{const b=[Math.min(...members.map(i=>i.bbox[0])),Math.min(...members.map(i=>i.bbox[1])),Math.max(...members.map(i=>i.bbox[2])),Math.max(...members.map(i=>i.bbox[3]))];if(b[2]-b[0]<=layout.width)dx=clamp(dx,-b[0],layout.width-b[2]);if(b[3]-b[1]<=layout.height)dy=clamp(dy,-b[1],layout.height-b[3]);const chosen=new Set(members.map(i=>i.id));for(const item of result.items)if(chosen.has(item.id))item.bbox=item.bbox.map((n,i)=>round(n+(i%2?dy:dx)));}
 const changed=members.filter(item=>{const after=result.items.find(entry=>entry.id===item.id);return after&&after.bbox.some((value,index)=>value!==before.get(item.id)[index]);});if(changed.some(item=>Object.hasOwn(item,'shape')))failShape();for(const item of result.items)if(Object.hasOwn(item,'shape')&&shapeBefore.has(item.id)&&item.bbox.some((value,index)=>value!==shapeBefore.get(item.id)[index]))failShape();return valid(result,schemaVersion);
}
export function intersectStudioItems(input,selection,{projected=undefined,schemaVersion=1}={}){const layout=valid(input,schemaVersion);box(selection);const view=hasStudioRig(layout)?projectStudioComposition(layout):(projected??studioCameraMoved(layout))?projectStudioLayout(layout):null;const hit=layout.items.filter(i=>{if(i.hidden||view&&!view.items[i.id]?.visible)return false;const b=view?view.items[i.id].bbox:i.bbox;return Math.min(b[2],selection[2])>Math.max(b[0],selection[0])&&Math.min(b[3],selection[3])>Math.max(b[1],selection[1]);});return targets(layout,hit.map(i=>i.id)).map(i=>i.id);}
export function resizeStudioRect(input,handle,dx,dy,{aspect=false,minSize=1,width=Infinity,height=Infinity}={}){
 box(input);if(!['n','ne','e','se','s','sw','w','nw'].includes(handle)||!Number.isFinite(dx)||!Number.isFinite(dy)||!Number.isFinite(minSize)||minSize<=0||!(width>0)||!(height>0))fail('Invalid resize.');const [l,t,r,b]=input,w=r-l,h=b-t;if(w<=0||h<=0)fail('Resize requires a positive box.');
 if(aspect&&handle.length===2){const sx=handle.includes('w')?-1:1,sy=handle.includes('n')?-1:1,ax=sx<0?r:l,ay=sy<0?b:t,raw=Math.abs(dx/w)>=Math.abs(dy/h)?1+sx*dx/w:1+sy*dy/h,min=Math.max(minSize/w,minSize/h),max=Math.min((sx<0?ax:width-ax)/w,(sy<0?ay:height-ay)/h);if(max<min)fail('Aspect ratio cannot fit inside the resize limits.');const s=clamp(raw,min,max),x=ax+sx*w*s,y=ay+sy*h*s;return[Math.min(ax,x),Math.min(ay,y),Math.max(ax,x),Math.max(ay,y)].map(round);}
 const result=[handle.includes('w')?Math.min(r-minSize,l+dx):l,handle.includes('n')?Math.min(b-minSize,t+dy):t,handle.includes('e')?Math.max(l+minSize,r+dx):r,handle.includes('s')?Math.max(t+minSize,b+dy):b].map((n,i)=>round(clamp(n,0,i%2?height:width)));
 if(result[2]-result[0]<minSize||result[3]-result[1]<minSize)fail('Resize cannot fit inside the canvas.');return result;
}

import {studioGridRationalFromPx,studioGridRationalFromDeltaPx,translateStudioShape} from './studio-shape-ops.mjs';
import {studioRational,studioRatSub,studioRatNeg,studioRatCmp,studioRoundHalfEven,studioShapeReportJSON} from './studio-shape-exact.mjs';
export const STUDIO_LAYOUT_OPS_ERROR_CODES=Object.freeze(['STUDIO_LAYOUT_OP_INVALID','STUDIO_LAYOUT_OP_TARGET','STUDIO_LAYOUT_OP_IDS','STUDIO_LAYOUT_OP_BOUNDS']);
const [OP_INVALID,OP_TARGET,OP_IDS,OP_BOUNDS]=STUDIO_LAYOUT_OPS_ERROR_CODES;
function opFail(code,reason,path){const e=new TypeError(`Studio layout operation: ${reason}`);e.code=code;e.reason=reason;e.path=path;throw e;}
function opOwn(value,key,code,reason,path){const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!d.enumerable||!Object.hasOwn(d,'value'))opFail(code,reason,path);return d.value;}
function opRecord(value,allowed,required,path,code=OP_INVALID,reason='structure'){
  if(value===null||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))opFail(code,reason,path);
  const result=Object.create(null);
  for(const key of Reflect.ownKeys(value)){if(typeof key!=='string'||!allowed.includes(key))opFail(code,reason,path);result[key]=opOwn(value,key,code,reason,path);}
  for(const key of required)if(!Object.hasOwn(result,key))opFail(code,reason,path);return result;
}
function opArray(value,low,high,code,reason,path){
  if(!Array.isArray(value))opFail(code,reason,path);const d=Object.getOwnPropertyDescriptor(value,'length');
  if(!d||!Object.hasOwn(d,'value')||!Number.isSafeInteger(d.value)||d.value<low||d.value>high)opFail(code,reason,path);
  if(Reflect.ownKeys(value).length!==d.value+1)opFail(code,reason,path);
  return Array.from({length:d.value},(_,i)=>opOwn(value,String(i),code,reason,path));
}
function opContext(input){
  const ctx=opRecord(input,['schemaVersion','newIds'],['schemaVersion'],'ctx');
  if(ctx.schemaVersion!==1&&ctx.schemaVersion!==2)opFail(OP_INVALID,'structure','ctx.schemaVersion');
  if(Object.hasOwn(ctx,'newIds')){
    const ids=opRecord(ctx.newIds,['items','groups'],['items','groups'],'ctx.newIds',OP_IDS,'ids');
    ids.items=opArray(ids.items,0,128,OP_IDS,'ids','ctx.newIds.items');ids.groups=opArray(ids.groups,0,128,OP_IDS,'ids','ctx.newIds.groups');
    const all=[...ids.items,...ids.groups];
    if(all.some(v=>typeof v!=='string'||!v.trim()||v.length>80)||new Set(all).size!==all.length)opFail(OP_IDS,'ids','ctx.newIds');ctx.newIds=ids;
  }
  return ctx;
}
function opSelection(input){
  const s=opRecord(input,['ids','expand','individual','intent'],['ids','intent'],'selection');
  s.ids=opArray(s.ids,1,128,OP_TARGET,'selection','selection.ids');
  if(s.ids.some(id=>typeof id!=='string')||new Set(s.ids).size!==s.ids.length)opFail(OP_TARGET,'selection','selection.ids');
  if(!Object.hasOwn(s,'expand'))s.expand='group';if(!Object.hasOwn(s,'individual'))s.individual=false;
  if(!['group','none'].includes(s.expand)||typeof s.individual!=='boolean'||!['transform','copy'].includes(s.intent)||s.intent==='copy'&&s.individual)opFail(OP_INVALID,'structure','selection');
  return s;
}
function validatedTargets(layout,s){
  const ids=new Set(s.ids);if(s.ids.some(id=>!layout.items.some(i=>i.id===id)))opFail(OP_TARGET,'selection','selection.ids');
  const groups=new Set(s.expand==='group'?layout.items.filter(i=>ids.has(i.id)&&i.group).map(i=>i.group):[]);
  const selected=layout.items.filter(i=>ids.has(i.id)||i.group&&groups.has(i.group));
  const blocked=new Set(s.individual?[]:selected.filter(i=>i.locked&&i.group).map(i=>i.group));
  const members=s.intent==='copy'?selected:selected.filter(i=>!i.locked&&(!i.group||!blocked.has(i.group)));
  return {selected:selected.map(i=>i.id),members:members.map(i=>i.id)};
}
function emptyNewIds(ctx){if(ctx.newIds&&(ctx.newIds.items.length||ctx.newIds.groups.length))opFail(OP_IDS,'ids','ctx.newIds');}
export function resolveStudioOpTargets(layout,selection,context){
  const ctx=opContext(context),s=opSelection(selection);emptyNewIds(ctx);
  return validatedTargets(valid(layout,ctx.schemaVersion),s);
}
function opCommand(input){
  const c=opRecord(input,['op','ids','expand','individual','dx','dy'],['op','ids'],'command');
  if(!['translate','copy'].includes(c.op))opFail(OP_INVALID,'structure','command.op');
  if(c.op==='copy'&&['individual','dx','dy'].some(k=>Object.hasOwn(c,k)))opFail(OP_INVALID,'structure','command');
  if(c.op==='translate'&&(!Object.hasOwn(c,'dx')||!Object.hasOwn(c,'dy')||typeof c.dx!=='number'||typeof c.dy!=='number'||!Number.isFinite(c.dx)||!Number.isFinite(c.dy)))opFail(OP_INVALID,'structure','command.delta');
  const s={ids:c.ids,intent:c.op==='copy'?'copy':'transform'};
  for(const key of ['expand','individual'])if(Object.hasOwn(c,key))s[key]=c[key];
  return {...c,selection:opSelection(s),dx:c.op==='copy'?16:c.dx,dy:c.op==='copy'?16:c.dy};
}
function assignedIds(layout,members,ctx,op){
  if(op==='translate'){emptyNewIds(ctx);return null;}
  const groups=[...new Set(members.filter(i=>i.group).map(i=>i.group))],ids=ctx.newIds;
  if(!ids||ids.items.length!==members.length||ids.groups.length!==groups.length)opFail(OP_IDS,'ids','ctx.newIds');
  const occupied=new Set(layout.items.flatMap(i=>i.group?[i.id,i.group]:[i.id]));
  if([...ids.items,...ids.groups].some(id=>occupied.has(id)))opFail(OP_IDS,'ids','ctx.newIds');
  return {items:ids.items,groups:new Map(groups.map((group,i)=>[group,ids.groups[i]]))};
}
const floorGrid=r=>r.n/r.d-(r.n<0n&&r.n%r.d!==0n?1n:0n);
const ceilGrid=r=>r.n/r.d+(r.n>0n&&r.n%r.d!==0n?1n:0n);
function sharedGridDelta(layout,members,dx,dy){
  const requested=[dx,dy].map(studioGridRationalFromDeltaPx),applied=requested.map(studioRoundHalfEven),clamped=[false,false];
  for(let axis=0;axis<2;axis++){
    const low=studioGridRationalFromPx(Math.min(...members.map(i=>i.bbox[axis]))),high=studioGridRationalFromPx(Math.max(...members.map(i=>i.bbox[axis+2])));
    const canvas=studioRational(BigInt(axis?layout.height:layout.width)*1024n);
    if(studioRatCmp(studioRatSub(high,low),canvas)<=0){
      const lo=ceilGrid(studioRatNeg(low)),hi=floorGrid(studioRatSub(canvas,high));
      if(lo>hi)opFail(OP_BOUNDS,'grid_clamp_empty',`delta[${axis}]`);
      const before=applied[axis];applied[axis]=before<lo?lo:before>hi?hi:before;clamped[axis]=applied[axis]!==before;
    }
  }
  return {applied,clamped};
}
function worldBounds(bbox){if(bbox.some(v=>!Number.isFinite(v)||v<-16384||v>16384))opFail(OP_BOUNDS,'world_range','layout.items');}
function changedGeometry(before,after){return before.bbox.some((v,i)=>v!==after.bbox[i])||JSON.stringify(before.shape)!==JSON.stringify(after.shape);}
export function applyStudioLayoutOp(input,command,context){
  const ctx=opContext(context),c=opCommand(command),layout=valid(input,ctx.schemaVersion),selection=validatedTargets(layout,c.selection);
  const chosen=new Set(selection.members),members=layout.items.filter(i=>chosen.has(i.id)),ids=assignedIds(layout,members,ctx,c.op);
  const mode=members.some(i=>Object.hasOwn(i,'shape'))?'grid':'legacy';
  const opReport={report_version:1,op:c.op,mode,no_op:true,requested_dx_px_approx:c.dx,requested_dy_px_approx:c.dy,applied_delta_grid:mode==='grid'?[0,0]:null,clamped:mode==='grid'?[false,false]:null,rect_delta_approx:true};
  const reports=[opReport];let result=layout,changed_ids=[],created_ids=[];
  if(members.length&&(c.op==='copy'||c.dx!==0||c.dy!==0)){
    if(c.op==='translate'&&members.some(item=>item.rig||item.attachment))fail('人偶与挂接道具请在镜头调度移动，挂接位置由关节与偏移决定。');
    if(c.op==='copy'&&members.some(item=>item.attachment&&!chosen.has(item.attachment.holder_id)))fail('请同时选择持有人和挂接道具复制，或在镜头调度先解绑。');
    if(c.op==='translate'&&mode==='legacy'){
      result=moveStudioVisual(layout,selection.members,c.dx,c.dy,{projected:false,individual:true,schemaVersion:ctx.schemaVersion});
      changed_ids=members.filter(i=>changedGeometry(i,result.items.find(after=>after.id===i.id))).map(i=>i.id);
    }else{
      const grid=c.op==='copy'?{applied:[16384n,16384n],clamped:[false,false]}:sharedGridDelta(layout,members,c.dx,c.dy);
      const delta=grid.applied.map(v=>Number(v)/1024);
      if(mode==='grid'){opReport.applied_delta_grid=grid.applied.map(Number);opReport.clamped=grid.clamped;}
      if(c.op==='copy'||grid.applied.some(v=>v!==0n)){
        const copies=[],copyIds=c.op==='copy'?new Map(members.map((item,i)=>[item.id,ids.items[i]])):null;
        for(let index=0;index<members.length;index++){
          const source=members[index],item=structuredClone(source),next=item.bbox.map((v,i)=>mode==='legacy'?round(v+16):v+delta[i%2]);worldBounds(next);
          if(c.op==='copy'){
            item.id=ids.items[index];item.locked=false;if(item.group)item.group=ids.groups.get(item.group);
            const sourceFrame=item.rig??item.attachment;
            if(sourceFrame)sourceFrame.frame=sourceFrame.frame.map((v,i)=>v+delta[i%2]);
            if(item.attachment)item.attachment.holder_id=copyIds.get(item.attachment.holder_id);
            const tail=item.bubble?.tail;
            if(tail?.point)tail.point=tail.point.map((v,i)=>v+delta[i]);
            if(tail?.speaker_id&&copyIds.has(tail.speaker_id))tail.speaker_id=copyIds.get(tail.speaker_id);
          }
          if(Object.hasOwn(item,'shape')){
            const moved=translateStudioShape(source.shape.ring,delta);item.shape={kind:'polygon',ring:moved.ring};item.bbox=moved.bbox;
            reports.push({source_id:source.id,item_id:item.id,report:moved.report});
          }else item.bbox=next;
          if(c.op==='copy'){copies.push(item);created_ids.push(item.id);}
          else{if(changedGeometry(source,item))changed_ids.push(item.id);result.items[result.items.findIndex(i=>i.id===item.id)]=item;}
        }
        if(c.op==='copy')result.items.push(...copies);
      }
    }
  }
  opReport.no_op=changed_ids.length===0&&created_ids.length===0;
  return {layout:valid(result,ctx.schemaVersion),changed_ids,created_ids,reports:JSON.parse(studioShapeReportJSON(reports))};
}
