const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);

/** Synchronous trusted admission snapshot. Never consult defaults, credentials or ambient agents. */
export function snapshotAnalysisModel(exec){
 try{
  const agent=exec?.agent,session=agent?.session;
  if(!text(agent?.id,256)||session?.id!==agent.id||typeof session?.requestHeader!=='function')return null;
  const config=session.requestHeader()?.config;
  if(!text(config?.provider,128)||!text(config?.model,256)||config.reasoningEffort!==undefined&&!text(config.reasoningEffort,128))return null;
  return Object.freeze({sessionId:session.id,provider:config.provider,model:config.model,...(config.reasoningEffort===undefined?{}:{reasoningEffort:config.reasoningEffort})});
 }catch{return null;}
}
