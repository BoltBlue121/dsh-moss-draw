import {projectStudioLayout,studioCameraMoved} from '../src/studio-camera.mjs';
const sameBox=(a,b)=>a&&b&&a.length===4&&b.length===4&&a.every((v,i)=>Math.abs(v-b[i])<1e-6);
function visibleItems(doc){
 const layout=doc.layout,view=studioCameraMoved(layout)?projectStudioLayout(layout):null,result=new Map();
 for(const item of layout.items){const p=view?.items[item.id];if(item.hidden||view&&!p?.visible)continue;result.set(item.id,{...item,bbox:view?p.bbox:item.bbox});}return result;
}
export function proposalGhosts(proposal){
 if(proposal?.base_doc?.kind!=='layout'||proposal?.proposed_doc?.kind!=='layout')return{ghosts:[],error:null};
 try{if(proposal.base_doc.layout.width!==proposal.proposed_doc.layout.width||proposal.base_doc.layout.height!==proposal.proposed_doc.layout.height)return{ghosts:[],error:'画布尺寸不同：请查看尺寸差异，避免把新坐标误画到旧画布。'};
  const before=visibleItems(proposal.base_doc),after=visibleItems(proposal.proposed_doc),ghosts=[];
  for(const id of new Set([...before.keys(),...after.keys()])){const a=before.get(id),b=after.get(id);if(a&&b&&sameBox(a.bbox,b.bbox))continue;ghosts.push({id,kind:!a?'add':!b?'remove':'move',name:b?.name||a?.name||id,...(a?{before:[...a.bbox]}:{}),...(b?{after:[...b.bbox]}:{})});}
  return{ghosts,error:null};
 }catch(error){return{ghosts:[],error:`Proposal projection: ${String(error.message??error).slice(0,200)}`};}
}
