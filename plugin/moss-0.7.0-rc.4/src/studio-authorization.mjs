// Authorization comes from native Session identity, never from model-supplied fields.
// Keep only IDs, not message text. No wire view: this is private host bookkeeping.
const KEY='moss-draw.authorization';
const historyError=()=>{throw Object.assign(new Error('STUDIO_AUTHORIZATION_HISTORY: Native session provenance is unavailable or invalid.'),{code:'STUDIO_AUTHORIZATION_HISTORY'});};
const validId=value=>typeof value==='string'&&value.length>0&&value.length<=200;
const initial=()=>({message_id:null,message_ids:[],task_messages:{},pending_calls:{}});
const resultOf=state=>state.message_id?{message_id:state.message_id,message_ids:[...state.message_ids],task_messages:{...state.task_messages}}:undefined;
function applyEvent(state,event){
 if(['step/start','step/end','turn/start','turn/end'].includes(event.type))return Object.keys(state.pending_calls).length?{...state,pending_calls:{}}:state;
 if(event.type==='user/message'&&event.surfaceOp==='append'){
  const m=event.data;
  if(m?.role!=='user'||m.source?.kind!=='user'||!validId(m.id))return state;
  return {...state,message_id:m.id,message_ids:state.message_ids.includes(m.id)?state.message_ids:[...state.message_ids,m.id]};
 }
 if(event.type==='tool/call'){
  const c=event.data;if(c?.name!=='art_generate'||!validId(c.callId)||!state.message_id)return state;
  let args;try{args=typeof c.arguments==='string'?JSON.parse(c.arguments):c.arguments;}catch{return state;}
  if(args?.mode!=='workbench'||args.workbench?.action!=='studioStart'||!validId(args.workbench.page_id)||Object.hasOwn(state.pending_calls,c.callId))return state;
  return {...state,pending_calls:{...state.pending_calls,[c.callId]:{message_id:state.message_id,page_id:args.workbench.page_id}}};
 }
 if(event.type==='tool/result'&&event.surfaceOp==='append'){
  const m=event.data?.message;if(!m||m.role!=='tool'||m.source?.kind!=='tool'||m.source.callId!==m.toolCallId||!Object.hasOwn(state.pending_calls,m.toolCallId))return state;
  const call=state.pending_calls[m.toolCallId],pending={...state.pending_calls};delete pending[m.toolCallId];
  let tasks=state.task_messages;
  if(!m.isError)for(const part of m.content??[]){if(part.type!=='text')continue;let value;try{value=JSON.parse(part.text);}catch{continue;}
   if(value?.page_id===call.page_id&&validId(value.task?.task_id)&&!Object.hasOwn(tasks,value.task.task_id))tasks={...tasks,[value.task.task_id]:call.message_id};
  }
  return {...state,pending_calls:pending,task_messages:tasks};
 }
 return state;
}
function dataObject(value,fields){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))historyError();
 const keys=Reflect.ownKeys(value);if(fields&&(keys.length!==fields.length||keys.some(k=>!fields.includes(k))))historyError();
 for(const key of keys){const p=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!p.enumerable||!Object.hasOwn(p,'value'))historyError();}
 return value;
}
function parseState(value){
 dataObject(value,['message_id','message_ids','task_messages','pending_calls']);
 if(!Array.isArray(value.message_ids)||Object.keys(value.message_ids).length!==value.message_ids.length||value.message_ids.some(id=>!validId(id))||new Set(value.message_ids).size!==value.message_ids.length)historyError();
 if(value.message_id!==null&&(!validId(value.message_id)||!value.message_ids.includes(value.message_id)))historyError();
 for(const [task,origin]of Object.entries(dataObject(value.task_messages))){if(!validId(task)||!validId(origin)||!value.message_ids.includes(origin))historyError();}
 for(const [id,call]of Object.entries(dataObject(value.pending_calls))){dataObject(call,['message_id','page_id']);if(!validId(id)||!validId(call.page_id)||!value.message_ids.includes(call.message_id))historyError();}
 return structuredClone(value);
}
/** Pure replay helper; the public projection service, not this plugin, reads the log. */
export function studioAuthorizationFromEvents(events){let state=initial(),last=-1;for(const e of events){if(!Number.isSafeInteger(e?.seq)||e.seq<0||e.seq<=last)historyError();last=e.seq;state=applyEvent(state,e);}return resultOf(state);}
/** The registry owns eager replay, restart checkpoints, forks and registration lifetime. */
export function registerStudioAuthorization(registry){
 if(typeof registry?.register!=='function'||typeof registry.stateOf!=='function')historyError();
 registry.register({key:KEY,stateVersion:1,stateSchema:{parse:parseState},init:initial,apply:applyEvent});
 return exec=>{const session=exec.agent?.session;if(!session)historyError();const state=registry.stateOf(session,KEY);if(!state)historyError();return resultOf(state);};
}
// Standalone/test adapters without a native registry can only prove visible provenance.
// Production registerTools always receives the injected native projection service.
export function studioRequestAuthorization(exec){
 const messages=exec.agent?.session.deriveMessages?.()??[];
 const human=messages.filter(m=>m.role==='user'&&m.source?.kind==='user'&&validId(m.id));
 const origins=new Map(),calls=new Map();let current;
 for(const m of messages){
  if(m.role==='user'&&m.source?.kind==='user'&&validId(m.id))current=m.id;
  if(m.role==='assistant')for(const part of m.content??[]){if(part.type!=='tool-call'||part.name!=='art_generate')continue;try{const args=typeof part.arguments==='string'?JSON.parse(part.arguments):part.arguments;if(args?.mode==='workbench'&&args.workbench?.action==='studioStart'&&current)calls.set(part.id,current);}catch{}}
  if(m.role==='tool'&&!m.isError&&calls.has(m.toolCallId))for(const part of m.content??[]){if(part.type!=='text')continue;try{const task=JSON.parse(part.text)?.task;if(validId(task?.task_id)&&!origins.has(task.task_id))origins.set(task.task_id,calls.get(m.toolCallId));}catch{}}
 }
 const latest=human.at(-1);return latest?{message_id:latest.id,message_ids:[...new Set(human.map(m=>m.id))],task_messages:Object.fromEntries(origins)}:undefined;
}
