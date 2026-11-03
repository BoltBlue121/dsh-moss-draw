// Uses only the official sidebar controller's foreground Session and openTab API.
export function createStudioNavigator({sidebar,getModel,readTasks,storage,now=Date.now,setTimer=globalThis.setTimeout,clearTimer=globalThis.clearTimeout}){
 let active=true,pending=null,timer=null;const seen=new Set(),errors=new Map(),retryAt=new Map();
 const key=(session,id)=>`moss.presentation.${session}.${id}`;
 function seenBefore(session,id){if(seen.has(key(session,id)))return true;try{return storage?.getItem(key(session,id))==='requested';}catch{return false;}}
 function remember(session,id){const value=key(session,id);seen.add(value);try{storage?.setItem(value,'requested');}catch{}}
 async function tick(){
  if(!active||pending)return pending;const sessionId=sidebar.mounted.getSnapshot();if(!sessionId||(retryAt.get(sessionId)??0)>now())return null;
  pending=(async()=>{try{
   const data=await readTasks(sessionId);retryAt.delete(sessionId);errors.delete(sessionId);if(!active||sidebar.mounted.getSnapshot()!==sessionId)return;
   const model=getModel(sessionId);await model.syncTask?.();if(!active||sidebar.mounted.getSnapshot()!==sessionId)return;
   const current=model.getSnapshot();if(current.busy||current.dirty||current.gestureActive||current.controlPending)return;
   const requested=data.tasks.find(row=>row.task?.presentation?.status==='queued'&&!seenBefore(sessionId,row.task.presentation.request_id));if(!requested)return;
   if(current.page?.page_id!==requested.page_id)await model.open(requested.page_id);
   if(!active||sidebar.mounted.getSnapshot()!==sessionId)return;
   const latest=model.getSnapshot();if(latest.dirty||latest.controlPending)return;
   sidebar.openTab('art-workbench',{params:{page_id:requested.page_id,request_id:requested.task.presentation.request_id}});
   remember(sessionId,requested.task.presentation.request_id);errors.delete(sessionId);
  }catch(error){errors.set(sessionId,String(error.message??error));retryAt.set(sessionId,now()+60000);}finally{pending=null;}})();return pending;
 }
 function loop(){if(!active)return;tick().finally(()=>{if(active)timer=setTimer(loop,2000);});}
 return{tick,start(){if(timer===null&&active)timer=setTimer(loop,0);},getError:id=>errors.get(id)??null,dispose(){active=false;if(timer!==null)clearTimer(timer);}};
}
