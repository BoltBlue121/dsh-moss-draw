import { studioBody, studioCameraFrame } from './studio-camera.mjs';

// Independent FK model. x points right, y down and z away from the reference
// camera. Bone rest offsets are fractions of the original character frame.
// Local rotations (degrees) apply X, then Y, then Z in the parent's axes.
const bones = [
 ['hips', null, 0, .04, 0], ['spine','hips',0,-.14,0], ['chest','spine',0,-.14,0],
 ['neck','chest',0,-.10,0], ['head','neck',0,-.08,0],
 ['shoulderL','chest',-.25,-.01,0], ['elbowL','shoulderL',-.09,.16,0], ['wristL','elbowL',-.07,.15,0],
 ['shoulderR','chest',.25,-.01,0], ['elbowR','shoulderR',.09,.16,0], ['wristR','elbowR',.07,.15,0],
 ['hipL','hips',-.14,.01,0], ['kneeL','hipL',-.02,.22,0], ['ankleL','kneeL',0,.20,0], ['toeL','ankleL',0,.02,-.04],
 ['hipR','hips',.14,.01,0], ['kneeR','hipR',.02,.22,0], ['ankleR','kneeR',0,.20,0], ['toeR','ankleR',0,.02,-.04],
];
export const STUDIO_RIG_JOINTS = Object.freeze(bones.map(bone=>bone[0]));
export const STUDIO_RIG_BUILDS = Object.freeze(['standard','slender','broad']);
export const STUDIO_RIG_VIEWS = Object.freeze(['camera','front','side','top','perspective']);
const poses = {
 rest:{},
 carry:{shoulderR:[-18,0,-12],elbowR:[-85,0,-16],wristR:[10,0,0]},
 stride:{hipL:[-28,0,0],hipR:[25,0,0],kneeL:[18,0,0],kneeR:[35,0,0],shoulderL:[23,0,0],shoulderR:[-22,0,0]},
 sit:{hipL:[-82,0,0],hipR:[-82,0,0],kneeL:[88,0,0],kneeR:[88,0,0],spine:[8,0,0]},
 reach:{shoulderR:[-45,0,-95],elbowR:[-10,0,-21],chest:[0,-12,0]},
};
export const STUDIO_RIG_PRESETS = Object.freeze(Object.keys(poses));
const zero = [0,0,0], unit = [[1,0,0],[0,1,0],[0,0,1]];
const radians=Math.PI/180;
const add=(a,b)=>a.map((v,i)=>v+b[i]);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const applyBasis=(basis,v)=>[0,1,2].map(k=>basis[0][k]*v[0]+basis[1][k]*v[1]+basis[2][k]*v[2]);
const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
function fault(code,message){throw Object.assign(new TypeError(message),{code});}
function invalid(message){fault('STUDIO_RIG_INVALID',message);}
function record(value,keys,path){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid(path+' must be a record.');
 for(const key of Reflect.ownKeys(value)){
  const field=Object.getOwnPropertyDescriptor(value,key);
  if(!keys.includes(key)||!field?.enumerable||!Object.hasOwn(field,'value'))invalid(path+' contains an unknown field.');
 }
}
function vector(value,length,limit,path){
 if(!Array.isArray(value)||value.length!==length||Reflect.ownKeys(value).length!==length+1)invalid(path+' has invalid length.');
 for(let i=0;i<length;i++){
  const field=Object.getOwnPropertyDescriptor(value,i);
  if(!field?.enumerable||!Number.isFinite(field.value)||Math.abs(field.value)>limit)invalid(path+' contains an invalid number.');
 }
 return [...value];
}
function frame(value,path){
 const box=vector(value,4,16384,path);
 if(box[2]<=box[0]||box[3]<=box[1])invalid(path+' must have positive dimensions.');
 return box;
}
function jointName(value){if(!STUDIO_RIG_JOINTS.includes(value))invalid('Unknown joint.');return value;}
function poseRecord(value){
 record(value,STUDIO_RIG_JOINTS,'pose');
 return Object.fromEntries(STUDIO_RIG_JOINTS.filter(id=>Object.hasOwn(value,id)).map(id=>[id,vector(value[id],3,180,'rotation')]));
}
export function validateStudioRig(value){
 record(value,['build','frame','pose','linked'],'rig');
 if(!STUDIO_RIG_BUILDS.includes(value.build)||typeof value.linked!=='boolean')invalid('Unknown figure build or link mode.');
 return {build:value.build,frame:frame(value.frame,'rig.frame'),pose:poseRecord(value.pose),linked:value.linked};
}
export function validateStudioAttachment(value){
 record(value,['holder_id','joint','frame','offset'],'attachment');
 if(typeof value.holder_id!=='string'||!value.holder_id.trim()||value.holder_id.length>80)invalid('Invalid attachment holder.');
 return {holder_id:value.holder_id,joint:jointName(value.joint),offset:vector(value.offset,3,2,'attachment.offset'),frame:frame(value.frame,'attachment.frame')};
}
export function validateStudioRigLayout(layout){
 const items=new Map(layout.items.map(item=>[item.id,item]));
 for(const item of layout.items){
  if(Object.hasOwn(item,'rig')){
   if(item.label!=='character'||item.shape||item.role||item.bubble||item.sketch||item.attachment||item.body&&item.body.anchor!=='world')invalid('A figure requires a world-anchored rectangular character.');
   validateStudioRig(item.rig);
  }
  if(Object.hasOwn(item,'attachment')){
   const attachment=validateStudioAttachment(item.attachment),holder=items.get(attachment.holder_id);
   if(item.label!=='object'||item.shape||item.role||item.bubble||item.sketch||item.rig||item.body&&item.body.anchor!=='world'
    ||holder?.label!=='character'||!holder.rig||holder.attachment)invalid('A prop must attach to a different, existing rigged character.');
  }
 }
 return layout;
}
function rotation(angles){
 const [x,y,z]=angles.map(n=>n*radians),cx=Math.cos(x),sx=Math.sin(x),cy=Math.cos(y),sy=Math.sin(y),cz=Math.cos(z),sz=Math.sin(z);
 return [[cz*cy,sz*cy,-sy],[cz*sy*sx-sz*cx,sz*sy*sx+cz*cx,cy*sx],[cz*sy*cx+sz*sx,sz*sy*cx-cz*sx,cy*cx]];
}
export function studioRigSourceLayout(layout){
 const linked=new Set(layout.items.filter(item=>item.rig?.linked).map(item=>item.id));
 return {...layout,items:layout.items.map(item=>{
  if(!item.rig&&!item.attachment)return item;
  const source={...item,bbox:(item.rig??item.attachment).frame};
  // A dormant figure still needs a world depth for director edits, but must
  // never become the pivot of the camera used to project the rest of the page.
  if(!linked.has(item.attachment?.holder_id??item.id))source.body={...studioBody(source,layout),anchor:'screen'};
  return source;
 })};
}
function skeleton(item,layout,baseFocal){
 const rig=item.rig,body=studioBody(item,layout),[l,t,r,b]=rig.frame;
 const u=body.z/baseFocal,h=(b-t)*u,w=(r-l)*u;
 const origin=[((l+r-layout.width)/2)*u,((t+b-layout.height)/2)*u,body.z];
 const rootBasis=rotation([0,body.yaw,0]),world={},axes={};
 for(const [name,parent,dx,dy,dz] of bones){
  const build=rig.build==='slender'?.82:rig.build==='broad'?1.25:1;
  const base=parent?axes[parent]:rootBasis;
  world[name]=add(parent?world[parent]:origin,applyBasis(base,[dx*w*build,dy*h,dz*h]));
  axes[name]=rotation(rig.pose[name]??zero).map(axis=>applyBasis(base,axis));
 }
 return {world,axes,height:h,unit:u};
}
function viewFrame(layout,view,base){
 if(!STUDIO_RIG_VIEWS.includes(view))invalid('Unknown rig view.');
 if(view==='camera')return studioCameraFrame(layout);
 if(view==='perspective')return studioCameraFrame({...layout,camera:{enabled:true,orbit:30,pitch:-13}});
 const basis=view==='side'?[[0,0,-1],[0,1,0],[1,0,0]]:view==='top'?[[1,0,0],[0,0,-1],[0,1,0]]:unit;
 return {right:basis[0],down:basis[1],forward:basis[2],position:[0,0,base.pivot],orthographic:true,focal:base.focal/base.pivot};
}
function cameraPoint(point,frame){
 const delta=sub(point,frame.position);
 return [dot(delta,frame.right),dot(delta,frame.down),dot(delta,frame.forward)];
}
const near=.0001;
function pixels(p,f,layout){
 if(!f.orthographic&&p[2]<near)return null;
 const scale=f.focal/(f.orthographic?1:p[2]);
 return [layout.width/2+p[0]*scale,layout.height/2+p[1]*scale];
}
function clippedSegment(a,b,f,layout){
 if(!f.orthographic){
  if(a[2]<near&&b[2]<near)return null;
  if((a[2]<near)!==(b[2]<near)){
   const s=(near-a[2])/(b[2]-a[2]),hit=[a[0]+s*(b[0]-a[0]),a[1]+s*(b[1]-a[1]),near];
   if(a[2]<near)a=hit;else b=hit;
  }
 }
 return [pixels(a,f,layout),pixels(b,f,layout)];
}
function projectionRecord(id,points,layout,depth,nearClipped,shown){
 const xs=points.map(p=>p[0]),ys=points.map(p=>p[1]);
 const raw=points.length?[Math.min(...xs),Math.min(...ys),Math.max(...xs),Math.max(...ys)]:[0,0,0,0];
 const bbox=raw.map((v,i)=>clamp(v,0,i%2?layout.height:layout.width));
 return {id,anchor:'world',raw,bbox,depth,corners:null,
  visible:shown&&bbox[2]>bbox[0]&&bbox[3]>bbox[1],
  partial:nearClipped||bbox.some((v,i)=>v!==raw[i])};
}
function outlines(local,edges,f,layout){
 return edges.map(([a,b])=>clippedSegment(local[a],local[b],f,layout)).filter(Boolean);
}
// Each rest limb has a radial profile in world space. Project the two rings
// and their near-plane crossings to make a small deterministic silhouette.
const volumes=[
 ['hips','spine',.078,.074],['spine','chest',.074,.092],['chest','neck',.074,.036],
 ...['L','R'].flatMap(s=>[
  ['shoulder'+s,'elbow'+s,.035,.023],['elbow'+s,'wrist'+s,.025,.014],
  ['hip'+s,'knee'+s,.046,.031],['knee'+s,'ankle'+s,.034,.020],['ankle'+s,'toe'+s,.021,.014],
 ]),
];
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const normal=v=>{const n=Math.hypot(...v);return v.map(x=>x/n);};
function convexHull(points){
 const sorted=points.sort((a,b)=>a[0]-b[0]||a[1]-b[1]).filter((v,i,a)=>!i||v[0]!==a[i-1][0]||v[1]!==a[i-1][1]);
 const half=list=>{const out=[];for(const p of list){
  while(out.length>=2){
   const a=out.at(-2),b=out.at(-1);
   if((b[0]-a[0])*(p[1]-a[1])>(b[1]-a[1])*(p[0]-a[0]))break;
   out.pop();
  }
  out.push(p);
 }return out;};
 if(sorted.length<3)return [];
 return [...half(sorted).slice(0,-1),...half([...sorted].reverse()).slice(0,-1)];
}
function mannequinSurface(sk,volume,f,layout,build){
 const [from,to,r1,r2]=volume,start=sk.world[from],end=sk.world[to],axis=normal(sub(end,start));
 const u=normal(cross(axis,Math.abs(axis[2])<.85?[0,0,1]:[0,1,0])),v=cross(axis,u);
 const factor=sk.height*(build==='broad'?1.17:build==='slender'?.85:1);
 const points=[],edges=[];
 for(let k=0;k<2;k++)for(let i=0;i<6;i++){
  const a=i*Math.PI/3,r=(k?r2:r1)*factor,p=k?end:start;
  const world=p.map((x,n)=>x+r*(u[n]*Math.cos(a)+v[n]*Math.sin(a)));
  points.push(cameraPoint(world,f));
  edges.push([k*6+i,k*6+(i+1)%6]);
  if(!k)edges.push([i,6+i]);
 }
 const ring=convexHull(outlines(points,edges,f,layout).flat());
 return ring.length>=3?{part:to,ring,depth:(cameraPoint(start,f)[2]+cameraPoint(end,f)[2])/2}:null;
}
/**
 * Ephemeral Map keyed by item id. joints.get(id) has points (joint -> [x,y] or
 * null behind near plane), segments (pairs of projected points), headRadius
 * and surfaces (far-to-near projected limb/torso rings).
 * props.get(id) has segments, center, holder_id & joint. boxes includes live-
 * linked items only; null means hidden/fully outside. Never serialize Maps in Doc.
 */
export function projectStudioRigs(layout,view='camera',{includeUnlinked=false}={}){
 validateStudioRigLayout(layout);
 const src=studioRigSourceLayout(layout),base=studioCameraFrame({...src,camera:{enabled:false}}),f=viewFrame(src,view,base);
 const joints=new Map(),props=new Map(),boxes=new Map(),records=new Map(),skeletons=new Map();
 function linked(record){
  records.set(record.id,record);
  boxes.set(record.id,record.visible?record.bbox:null);
 }
 for(const item of src.items.filter(i=>i.rig)){
  const sk=skeleton(item,src,base.focal);
  skeletons.set(item.id,{sk,item});
  const local=Object.fromEntries(STUDIO_RIG_JOINTS.map(id=>[id,cameraPoint(sk.world[id],f)]));
  const points=Object.fromEntries(STUDIO_RIG_JOINTS.map(id=>[id,pixels(local[id],f,layout)]));
  const segments=outlines(local,bones.filter(b=>b[1]).map(b=>[b[1],b[0]]),f,layout);
  const surfaces=volumes.map(volume=>mannequinSurface(sk,volume,f,layout,item.rig.build)).filter(Boolean).sort((a,b)=>b.depth-a.depth);
  const headRadius=points.head?.length?Math.abs(sk.height*.058*f.focal/(f.orthographic?1:local.head[2])):0;
  const head=points.head,outline=[...segments.flat(),...surfaces.flatMap(s=>s.ring)];
  if(head)outline.push([head[0]-headRadius,head[1]-headRadius],[head[0]+headRadius,head[1]+headRadius]);
  if(!item.hidden)joints.set(item.id,{points,segments,headRadius,surfaces});
  if(item.rig.linked||includeUnlinked)linked(projectionRecord(item.id,outline,layout,local.hips[2],
   !f.orthographic&&Object.values(local).some(point=>point[2]<near),!item.hidden));
 }
 for(const item of src.items.filter(i=>i.attachment)){
  const a=item.attachment,{sk,item:holder}=skeletons.get(a.holder_id);
  const axes=sk.axes[a.joint],at=add(sk.world[a.joint],applyBasis(axes,a.offset.map(v=>v*sk.height)));
  const w=(a.frame[2]-a.frame[0])*sk.unit/2,h=(a.frame[3]-a.frame[1])*sk.unit/2;
  const corners=[[-w,-h,0],[w,-h,0],[w,h,0],[-w,h,0]].map(v=>cameraPoint(add(at,applyBasis(axes,v)),f));
  const segments=outlines(corners,[[0,1],[1,2],[2,3],[3,0]],f,layout);
  const visible=!item.hidden&&!holder.hidden;
  if(visible)props.set(item.id,{segments,center:pixels(cameraPoint(at,f),f,layout),holder_id:holder.id,joint:a.joint});
  if(holder.rig.linked||includeUnlinked)linked(projectionRecord(item.id,segments.flat(),layout,cameraPoint(at,f)[2],
   !f.orthographic&&corners.some(point=>point[2]<near),visible));
 }
 return {joints,props,boxes,records};
}

function geometry(item){
 if(!item)return null;
 const b=item.body;
 return JSON.stringify([item.label,item.hidden===true,item.depth??null,item.bbox,b?[b.z,b.thickness,b.yaw,b.anchor]:null,
  item.rig?validateStudioRig(item.rig):null,item.attachment?validateStudioAttachment(item.attachment):null]);
}
/** Includes indirect changes on the other side of a locked holder/prop link. */
export function assertStudioRigLocks(before,after){
 const old=new Map(before.items.map(i=>[i.id,i])),next=new Map(after.items.map(i=>[i.id,i]));
 const failLock=id=>fault('STUDIO_LOCKED','Rig change would alter locked item '+id+'.');
 for(const item of old.values()){
  const updated=next.get(item.id);
  if(item.locked&&(item.rig||item.attachment||updated?.rig||updated?.attachment)&&geometry(item)!==geometry(updated))failLock(item.id);
 }
 const propIds=new Set([...old.values(),...next.values()].filter(i=>i.attachment).map(i=>i.id));
 for(const id of propIds){
  const a=old.get(id),b=next.get(id);
  for(const holderId of new Set([a?.attachment?.holder_id,b?.attachment?.holder_id].filter(Boolean))){
   const holder=old.get(holderId);
   if(holder?.locked&&geometry(a)!==geometry(b))failLock(holderId);
   if(a?.locked&&geometry(holder)!==geometry(next.get(holderId)))failLock(id);
  }
 }
}
function mirrorPose(pose){
 const result={};
 for(const [key,angle] of Object.entries(pose)){
  const other=key.endsWith('L')?key.slice(0,-1)+'R':key.endsWith('R')?key.slice(0,-1)+'L':key;
  result[other]=[angle[0],-angle[1]||0,-angle[2]||0];
 }
 return result;
}
function mirrorJoint(joint){
 return joint.endsWith('L')?joint.slice(0,-1)+'R':joint.endsWith('R')?joint.slice(0,-1)+'L':joint;
}
const commandFields={
 enable:['build'],build:['build'],pose:['preset'],mirror:[],rotate:['joint','angles'],
 drag:['joint','view','target'],link:['enabled'],attach:['holder_id','joint','offset'],
 offset:['offset'],detach:[],bake:[],move:['delta'],
};
function dragJoint(layout,item,command){
 const target=vector(command.target,2,32768,'drag.target');
 const parent=bones.find(b=>b[0]===jointName(command.joint))[1];
 if(!parent)invalid('Translate the frame to move the root.');
 if(!STUDIO_RIG_VIEWS.includes(command.view))invalid('Unknown drag view.');
 // While adjusting this one parent joint, the camera frame and root scale stay
 // fixed. No expensive scene-wide project/validation is needed per derivative.
 const src=studioRigSourceLayout(layout),source=src.items.find(i=>i.id===item.id);
 const base=studioCameraFrame({...src,camera:{enabled:false}}),f=viewFrame(src,command.view,base);
 function at(angles){
  const candidate={...source,rig:{...source.rig,pose:{...source.rig.pose,[parent]:angles}}};
  return pixels(cameraPoint(skeleton(candidate,src,base.focal).world[command.joint],f),f,src);
 }
 const distance=p=>p?Math.hypot(target[0]-p[0],target[1]-p[1]):Infinity;
 let angles=[...(item.rig.pose[parent]??zero)],point=at(angles),loss=distance(point);
 if(!point)fault('STUDIO_RIG_CLIPPED','Cannot drag a joint behind this view.');
 for(let step=0;step<20&&loss>.35;step++){
  // Damped least squares lifts this 2D pointer goal onto a constant-length bone.
  const j=angles.map((a,k)=>{
   const n=[...angles],dx=a>179.5?-.25:.25;n[k]+=dx;
   const other=at(n);return other?[(other[0]-point[0])/dx,(other[1]-point[1])/dx]:[0,0];
  });
  let xx=.025,xy=0,yy=.025;
  for(const [x,y] of j){xx+=x*x;xy+=x*y;yy+=y*y;}
  const ex=target[0]-point[0],ey=target[1]-point[1],det=xx*yy-xy*xy;
  const vx=(yy*ex-xy*ey)/det,vy=(xx*ey-xy*ex)/det;
  const delta=j.map(([x,y])=>clamp(x*vx+y*vy,-18,18));
  // Backtracking keeps an unreachable drag at its nearest observed pose.
  let improved=false;
  for(const scale of [1,.5,.25,.125]){
   const n=angles.map((v,i)=>clamp(v+delta[i]*scale,-180,180)),p=at(n),d=distance(p);
   if(d+1e-6<loss){angles=n;point=p;loss=d;improved=true;break;}
  }
  if(!improved)break;
 }
 item.rig.pose[parent]=angles;
}
/** Atomic pure layout edit. Caller owns schema-version upgrade, CAS and undo. */
export function applyStudioRigOp(layout,command){
 if(!command||!Object.hasOwn(commandFields,command.op))invalid('Unknown rig operation.');
 const op=command.op;
 record(command,['op','id',...commandFields[op]],'rig command');
 validateStudioRigLayout(layout);
 const out=structuredClone(layout),item=out.items.find(i=>i.id===command.id);
 if(!item)invalid('Unknown rig command target.');
 if(item.locked)fault('STUDIO_LOCKED','The target is locked.');
 if(op==='attach'){
  const holder=out.items.find(i=>i.id===command.holder_id);
  if(item.label!=='object'||!holder?.rig||holder.hidden||item.hidden)invalid('Choose a visible prop and figure.');
  item.attachment=validateStudioAttachment({holder_id:holder.id,joint:command.joint,offset:command.offset,frame:item.attachment?.frame??item.bbox});
 }else if(op==='detach'||op==='offset'){
  if(!item.attachment)invalid('The prop is not attached.');
  if(op==='detach')delete item.attachment;
  else item.attachment.offset=vector(command.offset,3,2,'attachment.offset');
 }else if(op==='enable'){
  if(item.label!=='character'||item.rig)invalid('Choose a rectangular character without a figure.');
  item.rig=validateStudioRig({build:command.build,frame:item.bbox,pose:{},linked:true});
 }else{
  if(!item.rig)invalid('Choose a rigged character.');
  const rig=item.rig;
  switch(op){
   case 'build': rig.build=command.build;break;
   case 'pose':
    if(!Object.hasOwn(poses,command.preset))invalid('Unknown pose preset.');
    rig.pose=structuredClone(poses[command.preset]);break;
   case 'rotate': rig.pose[jointName(command.joint)]=vector(command.angles,3,180,'rotation');break;
   case 'link': rig.linked=command.enabled;break;
   case 'drag': dragJoint(out,item,command);break;
   case 'move': {
    const [dx,dy]=vector(command.delta,2,32768,'move.delta');
    rig.frame=rig.frame.map((v,i)=>v+(i%2?dy:dx));break;
   }
   case 'mirror':
    rig.pose=mirrorPose(rig.pose);
    for(const prop of out.items.filter(i=>i.attachment?.holder_id===item.id)){
     prop.attachment.joint=mirrorJoint(prop.attachment.joint);
     prop.attachment.offset[0]=-prop.attachment.offset[0]||0;
    }
    break;
   case 'bake': {
    const {boxes}=projectStudioRigs(out,'camera',{includeUnlinked:true});
    for(const member of out.items.filter(i=>i.id===item.id||i.attachment?.holder_id===item.id)){
     const box=boxes.get(member.id);
     if(!box)fault('STUDIO_RIG_CLIPPED','The figure or an attached prop has no visible area to bake.');
     member.bbox=box;
    }
    break;
   }
  }
 }
 validateStudioRigLayout(out);
 assertStudioRigLocks(layout,out);
 return out;
}
