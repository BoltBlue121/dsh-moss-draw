// Plugin-owned session models survive view switches, never cross Session bindings.
export function createSessionModelRegistry({sessions,remote,createBridge,createRegion,createStudio}){
 const entries=new Map();let disposed=false;
 const destroy=e=>{e.region.dispose();e.studio.dispose();};
 return {
  get(sessionId){
   if(disposed)throw Error('WORKBENCH_DISPOSED');
   if(typeof sessionId!=='string'||!sessionId)throw Error('WORKBENCH_SESSION');
   const session=sessions.binding(sessionId)?.session;let entry=entries.get(sessionId);
   if(entry&&entry.session!==session){destroy(entry);entries.delete(sessionId);entry=undefined;}
   if(!entry){const bridge=createBridge({remote,sessionId,session});entry={session,region:createRegion(bridge),studio:createStudio(bridge)};entries.set(sessionId,entry);}
   return entry;
  },
  dispose(){if(disposed)return;disposed=true;for(const e of entries.values())destroy(e);entries.clear();},
 };
}
