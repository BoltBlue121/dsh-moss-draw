import {projectStudioLayout,studioCameraMoved} from './studio-camera.mjs';
import {projectStudioRigs,studioRigSourceLayout} from './studio-rig.mjs';

export function hasStudioRig(layout) {
  return layout.items.some(item=>item.rig||item.attachment);
}

// All consumers (editor, frozen plan, native and thumbnail previews) use the
// same projection. Never bake coordinates or change a source item during a read.
export function projectStudioComposition(layout) {
  const rich=hasStudioRig(layout);
  const basis=rich?studioRigSourceLayout(layout):layout;
  const rigs=rich?projectStudioRigs(layout):null;
  if(rigs){
    const items=new Map(layout.items.map(item=>[item.id,item]));
    for(const source of layout.items){
      if(!source.rig&&!source.attachment)continue;
      const id=source.id;
      if(rigs.records.has(id))continue;
      const raw=[...source.bbox],bbox=raw.map((v,i)=>Math.max(0,Math.min(i%2?layout.height:layout.width,v)));
      const parentHidden=source.attachment&&items.get(source.attachment.holder_id)?.hidden;
      rigs.records.set(id,{id,anchor:'screen',raw,bbox,depth:null,corners:null,
        visible:!source.hidden&&!parentHidden&&bbox[0]<bbox[2]&&bbox[1]<bbox[3],partial:bbox.some((v,i)=>v!==raw[i])});
      rigs.joints.delete(id);rigs.props.delete(id);
    }
  }
  // The FK renderer already projected these records. It supplies their final
  // depth and screen bounds before the camera sorts the complete scene.
  const view=projectStudioLayout(basis,rigs?.records);
  if(rigs)view.rigs=rigs;
  if(studioCameraMoved(layout)){
    // A screen-fixed comic border stays behind the action irrespective of
    // the selected camera. Keep its page reading order when sorting subjects.
    const frames=layout.items.filter(item=>item.role==='panel').map(item=>item.id);
    if(frames.length){
      const frameSet=new Set(frames);
      view.order=[...frames,...view.order.filter(id=>!frameSet.has(id))];
    }
  }
  return view;
}
