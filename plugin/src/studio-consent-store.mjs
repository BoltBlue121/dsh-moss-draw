import {createHash,randomUUID} from 'node:crypto';
import {normalizeStudioConsentOperations,canonicalStudioConsent,studioConsentQuestion} from './studio-consent-domain.mjs';
import {readStudioTask,saveStudioTask,studioTaskSettled,studioAbandoned,makeStudioTask,archiveStudioTask} from './studio-agent-state.mjs';
import {readStudioPolicy} from './studio-policy-store.mjs';

export const STUDIO_CONSENT_SCHEMA=`
CREATE TABLE IF NOT EXISTS studio_consents(consent_id TEXT PRIMARY KEY,session_id TEXT NOT NULL,request_key TEXT NOT NULL,page_id TEXT NOT NULL REFERENCES studio_pages(page_id),value TEXT NOT NULL,UNIQUE(session_id,request_key));
CREATE TABLE IF NOT EXISTS studio_consent_generation_guard(message_id TEXT PRIMARY KEY,consent_id TEXT NOT NULL,value TEXT NOT NULL);
`;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const invalid=message=>fail('STUDIO_INVALID_INPUT',message);
const digest=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(canonicalStudioConsent(value))).digest('hex');
const hasTable=(db,name)=>!!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const active=new Set(['pending','awaiting_handoff']);
const terminal=new Set(['applied','rejected','stale','expired']);
const now=()=>new Date().toISOString();
function trustedId(value,name){if(typeof value!=='string'||!value.trim()||value.length>200)fail('STUDIO_CONSENT_EVIDENCE',`Missing or invalid trusted ${name}.`);return value;}
function publicConsent(value){
 const output=Object.fromEntries(['consent_id','page_id','expected_revision','task_id','status','question','operations','created_at','expires_at','presentation_digest','presentation_version','request_key','approved_message_id','receipt','handoff'].map(key=>[key,value[key]]));
 if(value.presentation_version!==2){
  output.presentation_version=value.presentation_version??1;
  output.question=value.status==='applied'?'这项确认已执行，原回执保留。':'旧版长确认已失效，请重新确认。';
  if(value.status!=='applied'){output.status='stale';output.handoff=null;}
 }
 return structuredClone(output);
}
function replayConsent(value){return {...structuredClone(value.result),consent:publicConsent(value)};}

// Request, application and generation must agree on the same effective scope,
// including changes that do not bump the page revision (budget/policy/plans).
function consentScope(db,pageId,current){
 current??=db.prepare('SELECT * FROM studio_pages WHERE page_id=?').get(pageId);
 const deleted=hasTable(db,'studio_deleted_pages')&&db.prepare('SELECT 1 FROM studio_deleted_pages WHERE page_id=?').get(pageId);
 const deletedSeries=current&&hasTable(db,'studio_deleted_series')&&db.prepare('SELECT 1 FROM studio_deleted_series WHERE series_id=?').get(current.series_id);
 if(!current||deleted||deletedSeries)fail('STUDIO_NOT_FOUND','Consent page is no longer available.');
 const task=readStudioTask(db,pageId),policy=readStudioPolicy(db,pageId);
 const pending=db.prepare("SELECT value FROM studio_proposals WHERE page_id=? AND status='pending' ORDER BY proposal_id").all(pageId).map(v=>JSON.parse(v.value));
 const plans=hasTable(db,'studio_plans')?db.prepare('SELECT value FROM studio_plans WHERE page_id=? ORDER BY plan_id').all(pageId).map(v=>JSON.parse(v.value)):[];
 const {updated_at:_updated,presentation:_presentation,...taskScope}=task??{};
 const planScope=plans.map(p=>Object.fromEntries(['plan_id','page_revision','task_id','status','run_id','observed_stage','cost','digest','settlement'].filter(k=>Object.hasOwn(p,k)).map(k=>[k,p[k]])));
 return {current,task,policy,pending,plans,fingerprint:digest({page_id:current.page_id,revision:current.revision,title:current.title,doc:JSON.parse(current.doc),task:task?taskScope:null,policy,pending,plans:planScope})};
}
function invalidConsentReason(db,c){
 if(c.presentation_version!==2)return 'legacy presentation';
 const expiry=Date.parse(c.expires_at);
 if(!Number.isFinite(expiry)||Date.now()>=expiry)return 'expired';
 try{if(consentScope(db,c.page_id).fingerprint!==c.fingerprint)return 'scope changed';}catch{return 'scope changed';}
 return null;
}
const saveConsent=(db,c)=>db.prepare('UPDATE studio_consents SET value=? WHERE consent_id=?').run(JSON.stringify(c),c.consent_id);

/** Runs inside a write transaction so stale pending rows are normalized atomically. */
export function assertStudioConsentGeneration(db,{message_id,backend,page_id,task_id,action}={},evidence){
 // A short/qualified reply is not a fresh instruction, even if its old receipt
 // has expired. Do not fall through to a previous task's remaining allowance.
 if(evidence?.text_only===true)fail('STUDIO_TEXT_ONLY','The current native request permits text updates only.');
  const current=typeof message_id==='string'&&!!message_id&&evidence?.message_id===message_id;
 if(evidence&&evidence.message_id!==message_id)fail('STUDIO_CONSENT_GENERATION','Consent evidence does not match the current native message.');
 const session=current&&typeof evidence.session_id==='string'&&evidence.session_id?evidence.session_id:null;
 const consumed=hasTable(db,'studio_consent_generation_guard')&&typeof message_id==='string'
  ?db.prepare('SELECT value FROM studio_consent_generation_guard WHERE message_id=?').get(message_id):null;
 if(current&&evidence.reply_only===true&&!consumed)fail('STUDIO_CONSENT_GENERATION','Apply the current consent decision before generation; this reply is not a new drawing request.');
 if(hasTable(db,'studio_consents')){
  for(const row of db.prepare('SELECT value FROM studio_consents').all()){
   const consent=JSON.parse(row.value);
   if(session&&consent.session_id!==session)continue;
   const decision=current?evidence.decisions?.[consent.consent_id]:null;
   const matching=decision?.request_digest===consent.presentation_digest;
   if(matching&&typeof decision.message_id==='string'&&decision.message_id===message_id&&consent.status!=='applied')fail('STUDIO_CONSENT_GENERATION','Apply or replace the current consent decision before generation; a reply alone grants nothing.');
   if(!active.has(consent.status))continue;
   if(consent.chat_handoff&&current&&message_id===consent.approved_message_id&&action==='start'&&page_id===consent.page_id)continue;
    const reason=invalidConsentReason(db,consent);
   // A new explicit request can abandon an unanswered confirmation, never apply
   // it. Older adapters need a matching invalidated decision as evidence.
   const laterHuman=current&&matching&&decision.status==='invalid'&&typeof decision.message_id==='string'&&!!decision.message_id&&decision.message_id!==message_id&&evidence.reply_only!==true;
   const newRequest=!!session&&evidence.reply_only===false&&message_id!==consent.request_message_id;
   if(reason||newRequest||laterHuman){
    consent.status=reason==='expired'?'expired':'stale';consent.reason=reason??'superseded by a new native request';consent.handoff=null;delete consent.handoff_ack;saveConsent(db,consent);continue;
   }
   if(page_id&&page_id!==consent.page_id)continue;
   fail('STUDIO_CONSENT_GENERATION','A pending confirmation on this page must be resolved before generation.');
  }
 }
 if(!hasTable(db,'studio_consent_generation_guard'))return;
 if(typeof message_id!=='string'||!message_id){if(db.prepare('SELECT 1 FROM studio_consent_generation_guard LIMIT 1').get())fail('STUDIO_CONSENT_GENERATION','A current direct human message is required after a consent decision.');return;}
 const row=db.prepare('SELECT value FROM studio_consent_generation_guard WHERE message_id=?').get(message_id);if(!row)return;
 const guard=JSON.parse(row.value);if(!guard.continue_generation)fail('STUDIO_CONSENT_GENERATION','This approval authorizes no generation, including automatic continuation. Wait for a new human request.');
 if(action==='raw'||action==='start')fail('STUDIO_CONSENT_GENERATION','This approval only authorizes the bound Studio task, not raw generation or starting another task.');
 if(action!==undefined){
  if(!['prepare','claim','execute','region_stage'].includes(action))fail('STUDIO_CONSENT_SCOPE','Unknown generation authorization action.');
  if(page_id!==guard.page_id||task_id!==guard.task_id||!page_id||!task_id)fail('STUDIO_CONSENT_SCOPE','Generation does not match the approved page and task.');
  if(!backend)fail('STUDIO_CONSENT_BACKEND','Execution must name the actual approved backend.');
 }
 if(backend!==undefined&&guard.backend!==backend)fail('STUDIO_CONSENT_BACKEND','Generation backend differs from the explicitly approved backend.');
}

export function createStudioConsentMethods(api){
 const {transaction,row,checked,page,persistDocChange,persistMetadataChange,stalePending,request,id,revision,text,prepareProposalResolution,commitProposalResolution,assertPagePolicy,assertSharedUnchanged,lockedUnchanged,readPolicy,studioTextOnlySession,setStudioTextOnly}=api;
 const save=(db,c)=>db.prepare('UPDATE studio_consents SET value=? WHERE consent_id=?').run(JSON.stringify(c),c.consent_id);
 function get(db,key){const found=hasTable(db,'studio_consents')?db.prepare('SELECT value FROM studio_consents WHERE consent_id=?').get(key):null;if(!found)fail('STUDIO_NOT_FOUND','Consent not found.');return JSON.parse(found.value);}
 const state=(db,pageId)=>consentScope(db,pageId,row(db,pageId));
 function stage(task){return task?.control==='manual'?(task.stage_before_takeover??task.stage):task?.stage;}
 function ended(task){return ['delivered','failed','abandoned'].includes(stage(task));}
 function scope(db,s,ops,chatHandoff=false){
  const resolution=ops.proposal?prepareProposalResolution(db,s.current,ops.proposal):null;
  if(resolution){assertSharedUnchanged(JSON.parse(s.current.doc),resolution.doc);assertPagePolicy(db,s.current,resolution.doc);lockedUnchanged(JSON.parse(s.current.doc),resolution.doc);}
  const remainingPending=s.pending.filter(p=>p.proposal_id!==ops.proposal?.proposal_id);
  if(remainingPending.length&&!chatHandoff)fail('STUDIO_REVIEW_REQUIRED','Other pending proposals must be resolved explicitly, not bypassed by this consent.');
  if(ops.resume&&!s.task)fail('STUDIO_TASK_REQUIRED','There is no task to resume.');
  const g=ops.generation,task=s.task;
  if(g.mode!=='none'){
   if(!task)fail('STUDIO_TASK_REQUIRED','Use the ordinary start workflow for a page without a task.');
   if(s.plans.some(p=>p.task_id===task.task_id&&!studioAbandoned(p)&&['unknown','submitting','running'].includes(p.status)))fail('STUDIO_TASK_UNSETTLED','Reconcile the original unresolved runs before changing generation authority.');
   const settled=ended(task)&&studioTaskSettled(db,s.current.page_id,{...task,control:'auto',stage:stage(task)});
    if(g.mode==='new_task'){
    if(!settled)fail('STUDIO_TASK_UNSETTLED','A new task requires a fully settled ended task and exhausted old budget.');
   }else{
    if(settled||stage(task)==='abandoned')fail('STUDIO_TASK_ENDED','Do not add to or reuse an ended task; explicitly request a new task.');
    if(g.mode==='add_to_active'&&task.max_runs+g.runs>20)invalid('Active task budget cannot exceed 20.');
    if(g.mode==='use_remaining'&&task.max_runs<=task.claimed_runs)fail('STUDIO_BUDGET_EXHAUSTED','No existing runs remain.');
   }
   if((ops.continue_generation||g.mode==='new_task')&&task.control!=='auto'&&!ops.resume)fail('STUDIO_CONSENT_SCOPE','Explicitly request resume before continuing a non-auto task.');
  }
  if(ops.continue_generation&&!ops.exit_text_only&&(s.policy.editing_only||task?.editing_only))fail('STUDIO_TEXT_ONLY','Explicitly exit text-only mode in this request before generation.');
  const after_max=g.mode==='new_task'?g.runs:(task?.max_runs??0)+(g.mode==='add_to_active'?g.runs:0);
  return {resolution,after_max,remaining:ops.continue_generation?after_max-(g.mode==='new_task'?0:task?.claimed_runs??0):0};
 }
 function changes(before,after,prefix='',output=[]){
  if(JSON.stringify(canonicalStudioConsent(before))===JSON.stringify(canonicalStudioConsent(after)))return output;
  if(prefix==='layout.items'&&Array.isArray(before)&&Array.isArray(after)){
   for(const itemId of new Set([...before,...after].map(i=>i.id))){const a=before.find(i=>i.id===itemId),b=after.find(i=>i.id===itemId),start=output.length;changes(a??null,b??null,`item:${itemId}`,output);for(let i=start;i<output.length;i++)output[i].name=b?.name??a?.name??itemId;}
   const a=before.map(i=>i.id),b=after.map(i=>i.id);if(digest(a)!==digest(b))output.push({field:'layout.order',before:a,after:b});
  }else if(before&&after&&typeof before==='object'&&typeof after==='object'&&!Array.isArray(before)&&!Array.isArray(after)){
   for(const key of new Set([...Object.keys(before),...Object.keys(after)]))changes(before[key]??null,after[key]??null,prefix?`${prefix}.${key}`:key,output);
  }else{
   // Audit retains the complete selected values, never the public short preview.
    const describe=value=>structuredClone(value);
   output.push({field:prefix,before:describe(before),after:describe(after)});
  }
  return output;
 }
 function wrap(c,p){return {consent:publicConsent(c),...(p?{page:p}:{})};}
 function stale(db,c,reason){c.status='stale';c.handoff=null;c.reason=reason;save(db,c);return wrap(c);}
 function effective(db,c){
   if(c.presentation_version!==2&&c.status!=='applied')return {...c,status:'stale',handoff:null};
  if(!active.has(c.status))return c;
  // Nonce expiry only requires a fresh client ACK, not another human approval.
   if(invalidConsentReason(db,c))return {...c,status:'stale',handoff:null};
  
  return c;
 }
 return {
  async chatHandoff(input,authorization){
    const origin=trustedId(authorization?.message_id,'message_id');
    return transaction(true,db=>{
     const current=checked(db,input.page_id,input.expected_revision),s=state(db,input.page_id);
     if(s.task?.control!=='manual')return null;
     const session=trustedId(authorization?.consentEvidence?.session_id,'session_id');
     let c=db.prepare('SELECT value FROM studio_consents WHERE session_id=? AND request_key=?').get(session,`handoff:${s.task.task_id}:${origin}`);c=c?JSON.parse(c.value):null;
     if(!c||effective(db,c).status==='stale'||Date.now()>=Date.parse(c.handoff?.expires_at)){
      const consent_id=c?.consent_id??randomUUID(),created_at=now();
      c={consent_id,session_id:session,page_id:input.page_id,expected_revision:input.expected_revision,task_id:s.task.task_id,request_key:`handoff:${s.task.task_id}:${origin}`,request_message_id:origin,approved_message_id:origin,status:'awaiting_handoff',presentation_version:2,question:'正在交回 AI 控制，无需再次确认。',presentation_digest:digest(origin),created_at,expires_at:new Date(Date.now()+86400000).toISOString(),fingerprint:s.fingerprint,chat_handoff:true,handoff:{nonce:randomUUID(),expires_at:new Date(Date.now()+15000).toISOString(),owner_client:s.task.owner_client}};
      db.prepare('INSERT INTO studio_consents VALUES(?,?,?,?,?) ON CONFLICT(consent_id) DO UPDATE SET value=excluded.value').run(c.consent_id,session,c.request_key,input.page_id,JSON.stringify(c));
     }
     if(!c.handoff_ack)return wrap(c);
     const task=s.task;task.control='auto';task.stage=task.stage_before_takeover??'planning';delete task.owner_client;delete task.lease_token;delete task.stage_before_takeover;saveStudioTask(db,input.page_id,task);
     c.status='applied';c.handoff=null;save(db,c);return {page:page(db,persistMetadataChange(db,current,current.title,JSON.parse(current.doc),'chat-handoff'))};
    });
   },
   async requestConsent(input,trusted){
   request(input,['page_id','expected_revision','request_key','operations']);const pageId=id(input.page_id),expected=revision(input.expected_revision),key=text(input.request_key,'consent request key',100);
   if(!/^[A-Za-z0-9_.:-]+$/.test(key))invalid('Invalid consent request key.');
   const ops=normalizeStudioConsentOperations(input.operations),session=trustedId(trusted?.session_id,'session_id'),origin=trustedId(trusted?.message_id,'message_id');
   const requestDigest=digest({page_id:pageId,expected_revision:expected,request_key:key,operations:ops});
   return transaction(true,db=>{
    const found=db.prepare('SELECT value FROM studio_consents WHERE session_id=? AND request_key=?').get(session,key);
    if(found){const c=JSON.parse(found.value);if(c.request_digest!==requestDigest)fail('STUDIO_CONSENT_CONFLICT','The request key already describes different consent operations.');return c.result?replayConsent(c):wrap(effective(db,c));}
    checked(db,pageId,expected);const s=state(db,pageId),prepared=scope(db,s,ops),consent_id=randomUUID(),created_at=now();
    const before_doc=JSON.parse(s.current.doc),after_doc=prepared.resolution?.doc??before_doc;
     const question=studioConsentQuestion({consent_id,page:s.current,task:s.task,operations:ops,before_doc,after_doc,after_max:prepared.after_max,remaining:prepared.remaining});
     const audit={proposal_summary:prepared.resolution?.proposal.summary??null,changes:changes(before_doc,after_doc),generation_intent:ops.generation.intent};
    const c={consent_id,session_id:session,page_id:pageId,expected_revision:expected,task_id:s.task?.task_id??null,request_key:key,request_digest:requestDigest,request_message_id:origin,status:'pending',question,presentation_version:2,audit,operations:ops,created_at,expires_at:new Date(Date.parse(created_at)+86400000).toISOString(),presentation_digest:digest(question),approved_message_id:null,receipt:null,handoff:null,fingerprint:s.fingerprint};
    for(const entry of db.prepare('SELECT value FROM studio_consents WHERE session_id=?').all(session)){const old=JSON.parse(entry.value);if(active.has(old.status)){old.status='stale';old.reason='superseded';old.handoff=null;delete old.handoff_ack;save(db,old);}}
    db.prepare('INSERT INTO studio_consents VALUES(?,?,?,?,?)').run(consent_id,session,key,pageId,JSON.stringify(c));return wrap(c);
   });
  },
  async consentState(input={}){
   request(input,['page_id'],[]);const pageId=input.page_id===undefined?null:id(input.page_id);
   return transaction(false,db=>{if(!hasTable(db,'studio_consents'))return{consent:null};if(pageId)row(db,pageId);const found=pageId?db.prepare('SELECT value FROM studio_consents WHERE page_id=? ORDER BY rowid DESC LIMIT 1').get(pageId):db.prepare('SELECT value FROM studio_consents ORDER BY rowid DESC LIMIT 1').get();return{consent:found?publicConsent(effective(db,JSON.parse(found.value))):null};});
  },
  async applyConsent(input,trusted){
   request(input,['consent_id']);const key=id(input.consent_id),session=trustedId(trusted?.session_id,'session_id');
   return transaction(true,db=>{
    const c=get(db,key);if(c.session_id!==session)fail('STUDIO_CONSENT_SESSION','Consent belongs to a different native session.');
    if(c.result)return replayConsent(c);
    if(c.presentation_version!==2&&c.status!=='applied')return stale(db,c,'legacy presentation requires a new confirmation');
    if(terminal.has(c.status))return wrap(c);
    if(effective(db,c).status==='stale')return stale(db,c,'expired or scope changed');
    const evidence=trusted?.evidence,decision=evidence?.decisions?.[key];
    if(!decision||!['approved','rejected','ambiguous','invalid'].includes(decision.status)||decision.request_digest!==c.presentation_digest||decision.message_id!==evidence.message_id||typeof decision.message_id!=='string'||!decision.message_id||typeof decision.question_message_id!=='string'||!decision.question_message_id||decision.message_id===c.request_message_id)fail('STUDIO_CONSENT_EVIDENCE','No matching current native question and direct human decision.');
    if(decision.status!=='approved'){
     c.status=decision.status==='rejected'?'rejected':'stale';c.handoff=null;
     const guard={consent_id:key,continue_generation:false,backend:null,page_id:c.page_id,task_id:c.task_id,created_at:now()};
     db.prepare('INSERT INTO studio_consent_generation_guard VALUES(?,?,?) ON CONFLICT(message_id) DO UPDATE SET value=excluded.value').run(decision.message_id,key,JSON.stringify(guard));
     save(db,c);return wrap(c);
    }
    if(c.approved_message_id&&c.approved_message_id!==decision.message_id)return stale(db,c,'approval changed');
    const consumed=db.prepare('SELECT consent_id FROM studio_consent_generation_guard WHERE message_id=?').get(decision.message_id);if(consumed&&consumed.consent_id!==key)fail('STUDIO_CONSENT_EVIDENCE','This human approval was consumed by another consent.');
    const s=state(db,c.page_id),prepared=scope(db,s,c.operations);c.approved_message_id=decision.message_id;
    if(s.task?.control==='manual'){
     if(!s.task.owner_client||!s.task.lease_token)fail('STUDIO_CONSENT_HANDOFF','Manual task has no clean owner handoff channel.');
     if(c.handoff&&(!Number.isFinite(Date.parse(c.handoff.expires_at))||Date.now()>=Date.parse(c.handoff.expires_at))){c.handoff=null;delete c.handoff_ack;}
      if(!c.handoff){c.handoff={nonce:randomUUID(),expires_at:new Date(Date.now()+15000).toISOString(),owner_client:s.task.owner_client};c.status='awaiting_handoff';save(db,c);return wrap(c);}
     if(!c.handoff_ack)return wrap(c);
    }
    const ops=c.operations,doc=prepared.resolution?.doc??JSON.parse(s.current.doc);let task=s.task?structuredClone(s.task):null;
    if(ops.exit_text_only){setStudioTextOnly(db,c.page_id,false);if(task){task.editing_only=false;delete task.editing_return_stage;}}
    if(ops.resume&&task){const oldStage=stage(task);task.control='auto';task.stage=['delivered','failed','abandoned'].includes(oldStage)?oldStage:'planning';delete task.lease_token;delete task.owner_client;}
    if(ops.generation.mode==='add_to_active')task.max_runs=prepared.after_max;
    if(ops.generation.mode==='new_task'){
     if(decision.message_id===task.request_message_id||db.prepare('SELECT 1 FROM studio_task_history WHERE page_id=? AND json_extract(value,\'$.request_message_id\')=?').get(c.page_id,decision.message_id))fail('STUDIO_NEW_REQUEST_REQUIRED','A genuinely new human approval is required for a new task.');
     archiveStudioTask(db,c.page_id,s.task);task=makeStudioTask({intent:ops.generation.intent,max_runs:ops.generation.runs,message_id:decision.message_id,previous:s.task,session_id:c.session_id});
    }
    if(ops.continue_generation&&studioTextOnlySession(db))fail('STUDIO_TEXT_ONLY','Another page still has an active text-only restriction.');
    if(task){task.updated_at=now();saveStudioTask(db,c.page_id,task);}
    const next=prepared.resolution?persistDocChange(db,s.current,s.current.title,doc,'chat-consent',{allow_upgrade:false}):persistMetadataChange(db,s.current,s.current.title,JSON.parse(s.current.doc),'chat-consent');
    if(prepared.resolution)commitProposalResolution(db,prepared.resolution,next);
    stalePending(db,next,next.updated_at);
    const guard={consent_id:key,continue_generation:ops.continue_generation,backend:ops.generation.backend,page_id:c.page_id,task_id:task?.task_id??null,created_at:now()};
    db.prepare('INSERT INTO studio_consent_generation_guard VALUES(?,?,?)').run(decision.message_id,key,JSON.stringify(guard));
    c.status='applied';c.handoff=null;c.receipt={page_id:c.page_id,revision:next.revision,approved_message_id:decision.message_id,task_id:task?.task_id??null,proposal_status:prepared.resolution?.status??null,generation:structuredClone(ops.generation),continue_generation:ops.continue_generation,applied_at:now()};
    c.result=wrap(c,page(db,next));save(db,c);return c.result;
   });
  },
  async ackConsentHandoff(input){
   request(input,['consent_id','page_id','expected_revision','nonce','client_id','lease_token']);const key=id(input.consent_id),pageId=id(input.page_id),expected=revision(input.expected_revision);
   return transaction(true,db=>{const c=get(db,key);if(c.page_id!==pageId||c.expected_revision!==expected||c.status!=='awaiting_handoff'||!c.approved_message_id||!c.handoff||!Number.isFinite(Date.parse(c.handoff.expires_at))||Date.now()>=Date.parse(c.handoff.expires_at)||effective(db,c).status==='stale'||c.handoff.nonce!==input.nonce)fail('STUDIO_CONSENT_HANDOFF','Handoff is absent, changed or expired.');const s=state(db,pageId);if(s.task?.control!=='manual'||s.task.owner_client!==input.client_id||c.handoff.owner_client!==input.client_id||s.task.lease_token!==input.lease_token)fail('STUDIO_CONSENT_HANDOFF','Only the unchanged original owner and private lease may acknowledge a clean handoff.');c.handoff_ack={nonce:input.nonce,at:now()};save(db,c);return wrap(c);});
  },
  async assertConsentGeneration(input={},trustedEvidence){request(input,['message_id','backend','page_id','task_id','action'],[]);return transaction(true,db=>assertStudioConsentGeneration(db,input,trustedEvidence));},
 };
}
