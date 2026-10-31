// Shared strict, read-only wire contract. No command execution or session-log writes.
export function parseWorkbenchQuery(value){
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('WORKBENCH_QUERY_ACTION');
 const keys=Object.keys(value);if(value.action==='studioTaskState'&&keys.length===1)return{action:value.action};
 if(value.action==='studioTaskStatus'&&keys.length===2&&keys.includes('page_id')&&typeof value.page_id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.page_id))return{action:value.action,page_id:value.page_id};
 throw Error('WORKBENCH_QUERY_ACTION');
}
const codec=(type,parse,jsonSchema)=>({mode:'strict',typeSymbol:`moss-workbench-query#${type}`,create:()=>({parse}),jsonSchema});
const identity=codec('session',value=>{if(typeof value!=='string'||!/^session-[A-Za-z0-9_-]+$/.test(value))throw Error('WORKBENCH_SESSION');return value;},{type:'string'});
const request=codec('request',parseWorkbenchQuery,{oneOf:[{type:'object',properties:{action:{const:'studioTaskState'}},required:['action'],additionalProperties:false},{type:'object',properties:{action:{const:'studioTaskStatus'},page_id:{type:'string'}},required:['action','page_id'],additionalProperties:false}]});
export const WORKBENCH_QUERY_REMOTE={package:'@dsh-external/dsh-moss-draw/query',descriptors:[{id:'@dsh-external/dsh-moss-draw/query#read',namespace:'mossWorkbench',method:'read',service:'mossWorkbench',invocation:{kind:'direct'},parameters:[{name:'agent',wire:'agentId',source:'lookup',lookup:'agent',codec:{...identity,typeSymbol:'@deepseek-ai/dsh-session/types#SessionId'}},{name:'request',wire:'request',source:'json',codec:request}],cancellation:{parameter:'signal'},result:codec('result',value=>value,{type:'object'})}]};
