import {validateStudioDoc} from './studio-domain.mjs';
import {applyStudioPanelOp} from './studio-panel-ops.mjs';
import {applyStudioAnnotationOp} from './studio-annotation-ops.mjs';
import {applyStudioRigOp} from './studio-rig.mjs';
import {studioRational,quantizeStudioPolygon} from './studio-shape-exact.mjs';
import {studioRingBounds} from './studio-geometry.mjs';

export function fitStudioRichCanvas(doc,width,height,{stretch=false}={}){
  const out=validateStudioDoc(doc),layout=out.layout;
  if(![width,height].every(n=>Number.isInteger(n)&&n>=16&&n<=4096&&n%16===0))throw new RangeError('Canvas dimensions must be multiples of 16 from 16 to 4096.');
  const old=[layout.width,layout.height],size=[width,height];
  const axis=width*old[1]<=height*old[0]?0:1;
  const axes=[0,1].map(i=>{
    const j=stretch?i:axis,n=size[j],d=old[j],pad=size[i]*d-old[i]*n;
    return {scale:n/d,offset:pad/(2*d),grid:value=>studioRational(BigInt(value*1024)*BigInt(n)+BigInt(pad)*512n,BigInt(d))};
  });
  const mapped=coords=>coords.map((v,i)=>v*axes[i%2].scale+axes[i%2].offset);
  for(const item of layout.items){
    if(item.locked)continue;
    if(item.shape){
      if(item.role!=='panel')throw Object.assign(new Error('This shape must be explicitly transformed.'),{code:'STUDIO_SHAPE_OPERATION_UNSUPPORTED'});
      const points=item.shape.ring.map(point=>point.map((v,i)=>axes[i].grid(v)));
      const {ring}=quantizeStudioPolygon(points);
      item.shape={kind:'polygon',ring};item.bbox=studioRingBounds(ring);
    }else{
      const original=item.bbox;
      item.bbox=mapped(original).map(v=>Math.round(v*1000)/1000);
      if(!stretch&&!item.rig&&!item.attachment&&!item.bubble){
        for(let i=0;i<2;i++)if(Math.abs(original[i])<=2&&Math.abs(original[i+2]-old[i])<=2){item.bbox[i]=0;item.bbox[i+2]=size[i];}
      }
    }
    for(const field of ['rig','attachment'])if(item[field])item[field].frame=mapped(item[field].frame);
    if(item.bubble?.tail?.point)item.bubble.tail.point=mapped(item.bubble.tail.point);
  }
  layout.width=width;layout.height=height;
  return validateStudioDoc(out);
}

// Pure editing entry shared by both callers. Origin, revision and edit policy
// belong to the caller's Host transaction, never to the command.
export function applyStudioEdit(doc,family,command) {
  if(family==='panel')return applyStudioPanelOp(doc,command);
  if(family==='annotation')return applyStudioAnnotationOp(doc,command);
  if(family!=='rig')throw Object.assign(new Error('Unknown Studio edit family.'),{code:'STUDIO_INVALID_INPUT'});
  const clean=validateStudioDoc(doc);
  if(clean.kind!=='layout'||clean.schema_version!==2)throw Object.assign(new Error('Enable rich Layout editing on this page first.'),{code:'STUDIO_SCHEMA_UPGRADE_FORBIDDEN'});
  const layout=applyStudioRigOp(clean.layout,command);
  const old=new Map(clean.layout.items.map(item=>[item.id,JSON.stringify(item)]));
  const changed_ids=layout.items.filter(item=>old.get(item.id)!==JSON.stringify(item)).map(item=>item.id);
  return {doc:validateStudioDoc({...clean,layout}),changed_ids,created_ids:[],reports:[{op:command.op,status:changed_ids.length?'APPLIED':'NO_CHANGE'}]};
}
