import {parseWorkbenchQuery} from './workbench-query-contract.mjs';
export async function readWorkbenchQuery(commands,agent,input,signal){
 const request=parseWorkbenchQuery(input);signal?.throwIfAborted();
 const command=commands.find(agent,'art-workbench');
 if(command?.definitionId!=='moss-draw.workbench'){
  if(request.action==='studioTaskState')return{tasks:[],available:false};
  throw Error('WORKBENCH_QUERY_UNAVAILABLE');
 }
 // Public definition.handler is shared domain dispatch, not commands.execute:
 // only allowlisted READ actions, no impersonated user command/run lifecycle.
 const result=await command.handler({agent,rawInput:JSON.stringify(request),attachments:[],signal:signal??new AbortController().signal});
 if(result?.kind!=='success')throw Error(result?.text??'WORKBENCH_QUERY_UNAVAILABLE');
 return JSON.parse(result.text);
}
