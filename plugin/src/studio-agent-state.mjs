import {T2I_MODELS} from './catalog.mjs';
import {assertStudioRichRemovals} from './studio-doc-version.mjs';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

export const STUDIO_TASK_SCHEMA = `CREATE TABLE IF NOT EXISTS studio_tasks (
 page_id TEXT PRIMARY KEY REFERENCES studio_pages(page_id), value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS studio_task_history (
 task_id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES studio_pages(page_id), value TEXT NOT NULL
);`;
const error=(code,message)=>{throw Object.assign(new Error(message),{code});};
export const studioAbandoned=value=>value?.settlement?.kind==='human_abandoned'&&value.settlement.outcome==='unknown'&&typeof value.settlement.approved_at==='string'&&typeof value.settlement.reason==='string'&&value.settlement.plan_id===(value.plan_id??value.latest_plan_id);
export function readStudioTask(db,pageId){
 if(!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_tasks'").get())return null;
 const row=db.prepare('SELECT value FROM studio_tasks WHERE page_id=?').get(pageId);
 if(!row)return null;const task=JSON.parse(row.value);if(studioAbandoned(task)&&task.latest_plan_id===task.settlement.plan_id)task.stage='abandoned';return task;
}
export function publicStudioTask(task){
 if(!task)return undefined;
 const {lease_token,...publicValue}=task;
 return structuredClone(publicValue);
}
export function saveStudioTask(db,pageId,task){db.prepare('INSERT INTO studio_tasks(page_id,value) VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET value=excluded.value').run(pageId,JSON.stringify(task));}
export function requireStudioHuman(db,pageId,leaseToken){
 const task=readStudioTask(db,pageId);if(!task)return;
 if(task.control!=='manual'||typeof leaseToken!=='string'||leaseToken!==task.lease_token)error('STUDIO_LEASE_REQUIRED','Take control in this window before editing this task.');
}
export function requireStudioAuto(task){
 if(!task)error('STUDIO_TASK_REQUIRED','Start a task for this page first.');
 if(task.control==='review')error('STUDIO_REVIEW_REQUIRED','The user requested review before continuing.');
 if(task.control!=='auto')error('STUDIO_HUMAN_CONTROL','A human has paused or taken control of this task.');
}
export function studioTaskSettled(db,pageId,task){
 if(task?.control!=='auto'||!['delivered','failed','abandoned'].includes(task.stage)||!task.latest_plan_id)return false;
 if(!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_plans'").get())return false;
 const entries=db.prepare('SELECT value FROM studio_plans WHERE page_id=?').all(pageId).map(r=>JSON.parse(r.value)).filter(p=>p.task_id===task.task_id);
 const last=entries.find(p=>p.plan_id===task.latest_plan_id);
 const closed=task.stage==='abandoned'?studioAbandoned(last):task.stage==='failed'?last?.status==='failed':last?.status==='succeeded'&&last.observed_stage==='delivered';
  return task.claimed_runs>=task.max_runs&&closed&&!entries.some(p=>!studioAbandoned(p)&&['submitting','running','unknown'].includes(p.status));
}
function inFlight(db,pageId,task){
 if(!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_plans'").get())return false;
 return db.prepare('SELECT value FROM studio_plans WHERE page_id=?').all(pageId).map(r=>JSON.parse(r.value)).some(p=>p.task_id===task.task_id&&!studioAbandoned(p)&&['submitting','running','unknown'].includes(p.status));
}
// A direct text request does not need a zero-budget task or a new approval.
// Strip only the permitted text fields, then compare every retained structural field.
function assertTasklessTextUpdate(before,after){
 const structure=value=>{const doc=structuredClone(value);delete doc.caption.caption;delete doc.layout.summary.caption;
  for(const item of doc.layout.items)for(const key of ['caption','tags','text'])delete item[key];return doc;};
 if(!isDeepStrictEqual(structure(before),structure(after)))error('STUDIO_EDIT_SCOPE','Taskless updates may change text only; propose structural changes for review.');
}
// Shared transaction primitives: callers validate their authority before using them.
export function makeStudioTask({intent,mode='auto',max_runs,message_id,previous}){
 return {task_id:randomUUID(),intent,control:mode,stage:mode==='review'?'awaiting_review':'planning',max_runs,claimed_runs:0,presentation:{request_id:randomUUID(),status:'queued',requested_at:new Date().toISOString()},updated_at:new Date().toISOString(),...(message_id?{request_message_id:message_id}:{}),...(previous?{previous_task_id:previous.task_id,...(previous.preferences?{preferences:structuredClone(previous.preferences)}:{})}:{})};
}
export function archiveStudioTask(db,pageId,task){db.prepare('INSERT INTO studio_task_history VALUES(?,?,?)').run(task.task_id,pageId,JSON.stringify(task));}
export function createStudioTaskMethods(api){
 const {transaction,row,checked,page,persistDocChange,persistMetadataChange,stalePending,request,id,revision,text,validateDoc,lockedUnchanged,assertPagePolicy,assertSharedUnchanged,acknowledgeDescriptions,checkDescriptionRefresh,studioTextOnlySession,setStudioTextOnly,assertConsentGeneration}=api;
 const pending=(db,key)=>!!db.prepare("SELECT 1 FROM studio_proposals WHERE page_id=? AND status='pending' LIMIT 1").get(key);
 const noPending=(db,key)=>{if(pending(db,key))error('STUDIO_REVIEW_REQUIRED','Resolve the existing human review before autonomous work.');};
 const shown=(db,current,task,operation)=>{saveStudioTask(db,current.page_id,task);const next=persistMetadataChange(db,current,current.title,JSON.parse(current.doc),operation);return page(db,next);};
 const required=(db,key)=>{const task=readStudioTask(db,key);if(!task)error('STUDIO_TASK_REQUIRED','Start a task for this page first.');return task;};
 const opening=()=>({request_id:randomUUID(),status:'queued',requested_at:new Date().toISOString()});
 return {
  async startTask(input,authorization){
   request(input,['page_id','expected_revision','intent','mode','max_runs'],['page_id','expected_revision','intent']);
   const key=id(input.page_id),expected=revision(input.expected_revision),intent=text(input.intent,'task intent',4000),mode=input.mode??'auto',max=input.max_runs??1;
   if(!['auto','review'].includes(mode)||!Number.isSafeInteger(max)||max<0||max>4)error('STUDIO_INVALID_INPUT','Invalid task mode or run budget.');
   const message=authorization?.message_id;if(message!==undefined&&(typeof message!=='string'||!message||message.length>200))error('STUDIO_INVALID_INPUT','Invalid trusted message binding.');
   return transaction(true,db=>{const current=checked(db,key,expected),previous=readStudioTask(db,key);assertConsentGeneration(db,{message_id:message,action:'start',page_id:key},authorization?.consentEvidence);if(authorization?.consentEvidence?.reply_only===false&&message){
      for(const r of db.prepare('SELECT page_id FROM studio_page_policy').all())setStudioTextOnly(db,r.page_id,false);
      if(previous)previous.editing_only=false;
     }else if(studioTextOnlySession(db))error('STUDIO_TEXT_ONLY','A new native drawing instruction is required.');
     if(previous&&['paused','review','auto'].includes(previous.control)&&!['delivered','failed','abandoned'].includes(previous.stage)){
      if(!message||authorization?.consentEvidence?.reply_only!==false)error('STUDIO_TASK_EXISTS','The current task is still active.');
      // A human pause/review is lifted only by a newer human message than the one that started or last continued the task.
      if(previous.control!=='auto'&&[previous.request_message_id,previous.continued_message_id].includes(message))error('STUDIO_NEW_REQUEST_REQUIRED','Wait for a newer human message before resuming this paused or review task.');
      // Never re-plan over a submission that is still in flight or unknown.
      if(inFlight(db,key,previous))error('STUDIO_TASK_UNSETTLED','Query the original run with studioTaskStatus first; do not resubmit.');
      previous.control='auto';previous.stage='planning';previous.continued_message_id=message;previous.updated_at=new Date().toISOString();return shown(db,current,previous,'chat-continue');
     }
    if(previous){
     if(['manual','paused'].includes(previous.control))error('STUDIO_HUMAN_CONTROL','The human retains control of this page.');
     if(!['delivered','failed','abandoned'].includes(previous.stage))error('STUDIO_TASK_EXISTS','The current task is still active; do not reset its budget.');
     if(!studioTaskSettled(db,key,previous))error('STUDIO_TASK_UNSETTLED','Reconcile all submitted runs before starting another task.');
     const ids=authorization?.message_ids??[],origin=previous.request_message_id??authorization?.task_messages?.[previous.task_id]??previous.closed_after_message_id;
     if(!message||!origin||origin===message||ids.length&&(!ids.includes(message)||ids.includes(origin)&&ids.indexOf(message)<=ids.indexOf(origin)))error('STUDIO_NEW_REQUEST_REQUIRED','A new human request after the completed task is required.');
     const used=db.prepare('SELECT value FROM studio_task_history WHERE page_id=?').all(key).some(r=>JSON.parse(r.value).request_message_id===message);
     if(used)error('STUDIO_NEW_REQUEST_REQUIRED','This human request already started a task on this page.');
     archiveStudioTask(db,key,previous);
    }
    const task=makeStudioTask({intent,mode,max_runs:max,message_id:message,previous});
    return shown(db,current,task,'agent-start');
   });
  },
  async agentUpdate(input,richRemovals){
   request(input,['page_id','expected_revision','doc','title','descriptions_checked'],['page_id','expected_revision','doc']);
   if(input.descriptions_checked!==undefined&&typeof input.descriptions_checked!=='boolean')error('STUDIO_INVALID_INPUT','descriptions_checked must be boolean.');
   const key=id(input.page_id),expected=revision(input.expected_revision),doc=validateDoc(input.doc),title=input.title===undefined?undefined:text(input.title,'page title',200);
   return transaction(true,db=>{const current=checked(db,key,expected),task=readStudioTask(db,key);if(task)requireStudioAuto(task);
     assertStudioRichRemovals(JSON.parse(current.doc),doc,richRemovals);
     if(!task){assertTasklessTextUpdate(JSON.parse(current.doc),doc);if(title!==undefined&&title!==current.title)error('STUDIO_EDIT_SCOPE','Taskless text updates cannot rename the page.');}
     assertSharedUnchanged(JSON.parse(current.doc),doc);assertPagePolicy(db,current,doc,title??current.title);lockedUnchanged(JSON.parse(current.doc),doc);
    if(input.descriptions_checked){checkDescriptionRefresh(JSON.parse(current.doc),doc);acknowledgeDescriptions(db,key,doc);}
     if(task){task.stage=task.editing_only&&input.descriptions_checked?(task.editing_return_stage??'planning'):'planning';task.updated_at=new Date().toISOString();saveStudioTask(db,key,task);}
    const next=persistDocChange(db,current,title??current.title,doc,'agent-update',{allow_upgrade:false});stalePending(db,next,next.updated_at);return page(db,next);
   });
  },
  async takeover(input){
   request(input,['page_id','expected_revision','client_id','force'],['page_id','expected_revision','client_id']);
   const key=id(input.page_id),expected=revision(input.expected_revision),client=text(input.client_id,'client id',128);
   if(input.force!==undefined&&typeof input.force!=='boolean')error('STUDIO_INVALID_INPUT','Invalid takeover choice.');
   return transaction(true,db=>{const current=checked(db,key,expected),task=required(db,key);
    if(task.control==='manual'&&task.owner_client!==client&&!input.force)error('STUDIO_OTHER_EDITOR','Another window is editing. Explicitly take over to replace its control.');
    if(task.control==='manual'&&task.owner_client===client)return{page:page(db,current),lease_token:task.lease_token};
    if(task.control!=='manual')task.stage_before_takeover=task.stage;
     task.control='manual';task.stage='editing';task.owner_client=client;task.lease_token=randomUUID();task.updated_at=new Date().toISOString();
    return{page:shown(db,current,task,'human-takeover'),lease_token:task.lease_token};
   });
  },
  async pauseTask(input){
   request(input,['page_id','expected_revision','lease_token'],['page_id','expected_revision']);const key=id(input.page_id),expected=revision(input.expected_revision);
   return transaction(true,db=>{const current=checked(db,key,expected),task=required(db,key);if(task.control==='manual')requireStudioHuman(db,key,input.lease_token);
    task.control='paused';task.stage='paused';delete task.owner_client;delete task.lease_token;task.updated_at=new Date().toISOString();return shown(db,current,task,'human-pause');});
  },
  async resumeTask(input){
   request(input,['page_id','expected_revision','lease_token','max_runs','preferences','editing_only'],['page_id','expected_revision','lease_token']);const key=id(input.page_id),expected=revision(input.expected_revision);
   return transaction(true,db=>{const current=checked(db,key,expected),task=required(db,key);requireStudioHuman(db,key,input.lease_token);noPending(db,key);
    if(input.editing_only!==undefined&&typeof input.editing_only!=='boolean')error('STUDIO_INVALID_INPUT','editing_only must be boolean.');
     const completedText=task.editing_only&&input.editing_only!==true&&task.editing_return_stage==='delivered'&&(input.max_runs===undefined||input.max_runs===task.max_runs);
     task.editing_only=input.editing_only===true;setStudioTextOnly(db,key,task.editing_only);
     if(task.editing_only)task.editing_return_stage=task.stage_before_takeover??'planning';else delete task.editing_return_stage;
     if(input.max_runs!==undefined){if(!Number.isSafeInteger(input.max_runs)||input.max_runs<task.claimed_runs||input.max_runs>20)error('STUDIO_INVALID_INPUT','Budget cannot be below already claimed runs or above 20.');task.max_runs=input.max_runs;}
    if(input.preferences!==undefined){request(input.preferences,['prefix','negative','t2i_model','use_model_negative'],['prefix','negative']);if(input.preferences.use_model_negative!==undefined&&(input.preferences.use_model_negative!==true||input.preferences.negative!==''))error('STUDIO_INVALID_INPUT','Invalid model negative preference.');if(input.preferences.t2i_model!==undefined&&!T2I_MODELS.includes(input.preferences.t2i_model))error('STUDIO_INVALID_INPUT','Unknown MOSS t2i model preference.');if(typeof input.preferences.prefix!=='string'||input.preferences.prefix.length>12000||typeof input.preferences.negative!=='string'||input.preferences.negative.length>3000)error('STUDIO_INVALID_INPUT','Invalid shared generation preferences.');task.preferences=structuredClone(input.preferences);}
    task.control='auto';task.stage=completedText?'delivered':'planning';delete task.lease_token;delete task.owner_client;task.updated_at=new Date().toISOString();return shown(db,current,task,'human-resume');});
  },
  async requestOpen(input){request(input,['page_id']);const key=id(input.page_id);return transaction(true,db=>{const current=row(db,key),task=required(db,key);task.presentation=opening();saveStudioTask(db,key,task);return page(db,current);});},
  async ackOpen(input){
   request(input,['page_id','request_id','client_id','surface']);const key=id(input.page_id),client=text(input.client_id,'client id',128);
   if(!['main','sidebar'].includes(input.surface))error('STUDIO_INVALID_INPUT','Invalid presentation surface.');
   return transaction(true,db=>{const current=row(db,key),task=required(db,key);if(task.presentation?.request_id!==input.request_id)error('STUDIO_OPEN_STALE','This open request is no longer current.');
    if(task.presentation.status==='queued'){task.presentation={...task.presentation,status:'opened',surface:input.surface,client_id:client,opened_at:new Date().toISOString()};saveStudioTask(db,key,task);}return page(db,current);});
  },
  async taskHistory(input){request(input,['page_id']);const key=id(input.page_id);return transaction(false,db=>{row(db,key);if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_task_history'").get())return{tasks:[]};return{tasks:db.prepare('SELECT value FROM studio_task_history WHERE page_id=? ORDER BY rowid DESC LIMIT 100').all(key).map(r=>publicStudioTask(JSON.parse(r.value)))};});},
  async taskState(input={}){request(input,[]);return transaction(false,db=>{
   const editing_only=studioTextOnlySession(db);
   if(!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_tasks'").get())return{tasks:[],...(editing_only?{editing_only:true}:{})};
   const tasks=[];for(const entry of db.prepare('SELECT page_id,value FROM studio_tasks ORDER BY rowid DESC LIMIT 100').all()){
    try{const current=row(db,entry.page_id),task=readStudioTask(db,entry.page_id);tasks.push({page_id:current.page_id,series_id:current.series_id,revision:current.revision,title:current.title,binding_active:pending(db,current.page_id)||!!task.editing_only||!studioTaskSettled(db,current.page_id,task),task:publicStudioTask(task)});}catch(e){if(e.code!=='STUDIO_NOT_FOUND')throw e;}
   }return{tasks,...(editing_only?{editing_only:true}:{})};
  });},
 };
}
