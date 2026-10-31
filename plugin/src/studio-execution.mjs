import {randomUUID,createHash,randomBytes} from 'node:crypto';
import {projectStudioLayout,studioCameraMoved,studioCameraText} from './studio-camera.mjs';
import {normalizeRegions} from './regions.mjs';
import {compileStudioDoc} from './studio-domain.mjs';
import {resolveStudioSharedDoc} from './studio-shared.mjs';
import {normalizeInput} from './core.mjs';
import {validateAssets} from './modes.mjs';
import {K2_ADAPTER,QWEN_ADAPTER} from './backends.mjs';
import {NATIVE_EDIT_ADAPTER} from './native-edit.mjs';
import {readStudioTask,saveStudioTask,requireStudioAuto,studioAbandoned} from './studio-agent-state.mjs';
import {assertStudioConsentGeneration} from './studio-consent-store.mjs';

export const STUDIO_PLAN_SCHEMA=`CREATE TABLE IF NOT EXISTS studio_plans (
 plan_id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES studio_pages(page_id), request_key TEXT NOT NULL, value TEXT NOT NULL,
 UNIQUE(page_id,request_key)
);`;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
const digest=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const INPUT_FIELDS=['backend','mode','model','style','width','height','steps','cfg','shift','seed','sampler','scheduler','lora_strength','loras','negative','checks','characters'];
function compileInput(doc,settings,assets,key,trustedAssets=[],editEngine='native'){
 if(!settings||typeof settings!=='object'||Array.isArray(settings)||Object.keys(settings).some(k=>![...INPUT_FIELDS,'prefix','region_bindings','qwen_full_prompt'].includes(k)))fail('STUDIO_INVALID_INPUT','Unknown generation setting.');
 const compiled=compileStudioDoc(doc);if(!compiled.compiled)fail('STUDIO_COMPILE_FAILED',compiled.checks.map(c=>c.message).join(' ').slice(0,1000));
 const backend=settings.backend??'moss',mode=settings.mode??'t2i';let prompt=compiled.prompt,prompt_format=doc.kind==='caption'?'caption':'layout-json',warnings=[];
 // Sampler choice is a moss-t2i control only. Everything else already has a fixed
 // pair, so an explicit sampler is refused here instead of silently resubmitted.
 const selectsSampler=backend==='moss'&&mode==='t2i';
 if(!selectsSampler&&(settings.sampler!==undefined||settings.scheduler!==undefined))fail('STUDIO_INVALID_INPUT',`Sampler/scheduler are moss t2i only; ${backend}/${mode} keeps its fixed pair. Drop both fields, or use backend moss with mode t2i.`);
 if(doc.kind==='layout'&&(backend!=='moss'||mode!=='t2i')){
  const data=JSON.parse(prompt);prompt=[data.summary.caption,...data.items.map(item=>`${item.label}: ${item.caption}${item.text?` Text: ${JSON.stringify(item.text)}.`:''} Bounding box (centered yxyx): ${item.bbox.join(', ')}.`)].join('\n');
  prompt_format='layout-to-prose';warnings.push('Layout is expressed as prose guidance for this backend; it is not a pixel or region mask constraint.');
 }
 const prefix=settings.prefix??'';if(typeof prefix!=='string'||prefix.length>12000)fail('STUDIO_INVALID_INPUT','Invalid prompt prefix.');if(prefix.trim())prompt=`${prefix.trim()}, ${prompt}`;
 if(mode==='regions'){
  if(backend!=='moss'||doc.kind!=='layout'||!Array.isArray(settings.region_bindings)||!settings.region_bindings.length||settings.region_bindings.length>4)fail('STUDIO_REGION_BINDING','Regions require a Layout and one to four item/reference bindings.');
  if(settings.model!==undefined)fail('STUDIO_REGION_BINDING','Unsupported settings.model for regions; omit it. The region child uses model=sft with the trusted edit engine, not a caller-selected model.');
   if(settings.negative||settings.width!==undefined||settings.height!==undefined||settings.characters)fail('STUDIO_REGION_BINDING','Regions do not accept settings.width/height/characters or a nonempty negative. Omit those fields; canvas comes from the exact base image and Layout.');
  if(!trustedAssets.length||trustedAssets[0].width!==doc.layout.width||trustedAssets[0].height!==doc.layout.height)fail('STUDIO_REGION_BINDING','Layout size must equal the base reference canvas.');
  const resolved=resolveStudioSharedDoc(doc),regionPrefix=[prefix.trim(),doc.shared?.style??''].filter(Boolean).join('\n');
   const view=studioCameraMoved(doc.layout)?projectStudioLayout(doc.layout):null;
  const regions=settings.region_bindings.map(binding=>{if(!binding||Object.keys(binding).some(k=>!['item_id','reference_index','qwen_prompt','context_px','feather_px','style','lora_strength','loras','seed','steps','cfg'].includes(k)))fail('STUDIO_REGION_BINDING','Invalid region binding.');const item=resolved.layout.items.find(i=>i.id===binding.item_id),projected=view?.items[binding.item_id];
   if(!item||item.hidden||view&&(!projected?.visible||projected.partial))fail('STUDIO_REGION_BINDING','Bound item must be wholly visible.');
   const {item_id,...fields}=binding;return{id:item_id,box:(projected?.raw??item.bbox).map(Math.round),prompt:`${regionPrefix?regionPrefix+'\n':''}${item.caption}${item.text?`\nText: ${JSON.stringify(item.text)}`:''}\n${studioCameraText(doc.layout)}`,...Object.fromEntries(['style','lora_strength','loras','steps','cfg'].filter(k=>settings[k]!==undefined).map(k=>[k,settings[k]])),...fields,seed:binding.seed??settings.seed??randomBytes(6).readUIntBE(0,6)};
  });
  prompt='Apply only the specified regional edit; preserve unedited areas.';
   const input={mode:'regions',action:'draft',request_id:key,prompt,regions,qwen_full_prompt:settings.qwen_full_prompt??''},effective=normalizeRegions(input,trustedAssets);
  return{prompt,prompt_format:'region-item-bindings',warnings:['Regions use independent crops; background seams and reference identity remain experimental.'],prefix,negative:'',effective,request:{backend:'moss',...input,regions:effective.regions},cost:regions.length+regions.filter(r=>r.qwen_prompt).length+(effective.qwen_full_prompt?1:0)};
 }
 if(settings.region_bindings!==undefined||settings.qwen_full_prompt!==undefined)fail('STUDIO_REGION_BINDING','Region settings require regions mode.');
 const input={...settings,backend,mode,request_id:key,prompt,width:settings.width??doc.layout.width,height:settings.height??doc.layout.height};delete input.prefix;
 // The effective seed is frozen during preparation, never chosen anew on execution.
 let effective;
 if(backend==='k2')effective=K2_ADAPTER.normalize(input,assets);
 else if(backend==='qwen')effective=QWEN_ADAPTER.normalize(input,assets);
 else if(backend==='moss'){
  const{backend:_backend,...moss}=input;
  effective=mode==='edit'&&editEngine==='native'?NATIVE_EDIT_ADAPTER.normalize(input,assets):normalizeInput(moss,trustedAssets);
 }else fail('STUDIO_INVALID_INPUT','Unknown backend.');
 const requestFields=selectsSampler?INPUT_FIELDS:INPUT_FIELDS.filter(k=>k!=='sampler'&&k!=='scheduler');
 const request=Object.fromEntries([...requestFields,'request_id','prompt','brief','parent_run_id'].filter(k=>Object.hasOwn(effective,k)&&effective[k]!==null).map(k=>[k,effective[k]]));
 return{prompt,prompt_format,warnings,prefix,negative:effective.negative,effective,request};
}
export function createStudioPlanMethods(api){
 const{transaction,row,checked,request,id,revision,text,studioTextOnlySession}=api;
 const get=(db,key)=>{const exists=db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_plans'").get();const entry=exists?db.prepare('SELECT value FROM studio_plans WHERE plan_id=?').get(key):null;if(!entry)fail('STUDIO_NOT_FOUND','Plan not found.');const plan=JSON.parse(entry.value);row(db,plan.page_id);if(studioAbandoned(plan))plan.status='abandoned';return plan;};
 const save=(db,plan)=>db.prepare('UPDATE studio_plans SET value=? WHERE plan_id=?').run(JSON.stringify(plan),plan.plan_id);
 return{
  async preparePlan(input,trustedAssets=[],editEngine='native',authorization){
   request(input,['page_id','expected_revision','request_key','settings','assets']);const pageId=id(input.page_id),expected=revision(input.expected_revision),key=text(input.request_key,'request key',100);
   if(!input.settings||typeof input.settings!=='object'||Array.isArray(input.settings)||!['native','legacy'].includes(editEngine))fail('STUDIO_INVALID_INPUT','Invalid settings or trusted engine.');
   if(!/^[A-Za-z0-9_.:-]+$/.test(key)||!Array.isArray(input.assets)||input.assets.length>4)fail('STUDIO_INVALID_INPUT','Invalid plan key or assets.');
   const assets=input.assets.map(a=>{request(a,['sha256','width','height','mediaType']);if(!/^[a-f0-9]{64}$/.test(a.sha256)||!['image/png','image/jpeg','image/webp'].includes(a.mediaType)||![a.width,a.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096))fail('STUDIO_INVALID_INPUT','Invalid frozen asset metadata.');return structuredClone(a);});
   const verified=validateAssets(trustedAssets,input.settings.backend==='qwen'||input.settings.mode==='regions'?4500000:2100000);
   if(digest(verified.map(({sha256,width,height,mediaType})=>({sha256,width,height,mediaType})))!==digest(assets))fail('STUDIO_ASSET_INTEGRITY','Frozen metadata must match admitted bytes.');
   return transaction(true,db=>{const current=checked(db,pageId,expected),task=readStudioTask(db,pageId);assertStudioConsentGeneration(db,{message_id:authorization?.message_id,action:'prepare',page_id:pageId,task_id:task?.task_id,backend:input.settings.backend??'moss'},authorization?.consentEvidence);requireStudioAuto(task);if(task.editing_only||studioTextOnlySession(db))fail('STUDIO_TEXT_ONLY','This continuation authorizes text editing only, not GPU generation.');
    // A fresh native instruction treats the Agent's own pending proposal as a draft; UI or replayed callers keep the review lock.
    if(!(authorization?.message_id&&authorization.consentEvidence?.reply_only===false)&&db.prepare("SELECT 1 FROM studio_proposals WHERE page_id=? AND status='pending'").get(pageId))fail('STUDIO_REVIEW_REQUIRED','Resolve the pending proposal before preparing generation.');
    const settings={...input.settings};if(task.preferences)for(const k of ['prefix','negative']){if(settings[k]!==undefined&&settings[k]!==task.preferences[k])fail('STUDIO_PREFERENCE_CONFLICT','Human generation preferences are authoritative; ask for an explicit change.');settings[k]=task.preferences[k];}
    const intent_digest=digest({page_revision:expected,settings,assets,edit_engine:editEngine});const entry=db.prepare('SELECT value FROM studio_plans WHERE page_id=? AND request_key=?').get(pageId,key);
    if(entry){const previous=JSON.parse(entry.value);if(studioAbandoned(previous))previous.status='abandoned';if(previous.intent_digest!==intent_digest)fail('STUDIO_PLAN_CONFLICT','This request key already identifies different input.');return previous;}
    if(db.prepare('SELECT count(*) AS n FROM studio_plans WHERE page_id=?').get(pageId).n>=100)fail('STUDIO_PLAN_LIMIT','This page already has 100 plans.');
    const plan_id=randomUUID(),doc=JSON.parse(current.doc),compiled=compileInput(doc,settings,assets,`studio:${plan_id}`,verified.map(({data,mediaType,width,height})=>({data,mediaType,width,height})),editEngine),at=new Date().toISOString();
    const frozen={page_id:pageId,page_revision:expected,task_id:task.task_id,edit_engine:editEngine,doc,...compiled,assets,cost:compiled.cost??1};
    const plan={plan_id,request_key:key,intent_digest,...frozen,digest:digest(frozen),status:'prepared',run_id:null,created_at:at,updated_at:at};
    db.prepare('INSERT INTO studio_plans VALUES(?,?,?,?)').run(plan_id,pageId,key,JSON.stringify(plan));task.stage='ready';task.latest_plan_id=plan_id;saveStudioTask(db,pageId,task);return plan;
   });
  },
  async claimPlan(input,authorization){request(input,['plan_id']);const key=id(input.plan_id);return transaction(true,db=>{const plan=get(db,key);if(plan.status!=='prepared')return{owner:false,plan};
   const current=row(db,plan.page_id),task=readStudioTask(db,plan.page_id);assertStudioConsentGeneration(db,{message_id:authorization?.message_id,action:'claim',page_id:plan.page_id,task_id:plan.task_id,backend:plan.request.backend??'moss'},authorization?.consentEvidence);requireStudioAuto(task);if(task.editing_only||studioTextOnlySession(db))fail('STUDIO_TEXT_ONLY','Text-only continuation cannot claim generation.');if(current.revision!==plan.page_revision||task.task_id!==plan.task_id)fail('STUDIO_PLAN_STALE','The page or control changed; prepare a new plan.');
   if(task.claimed_runs+plan.cost>task.max_runs)fail('STUDIO_BUDGET_EXHAUSTED','No authorized generation budget remains.');
   plan.status='submitting';plan.updated_at=new Date().toISOString();save(db,plan);task.claimed_runs+=plan.cost;task.stage='generating';saveStudioTask(db,plan.page_id,task);return{owner:true,plan};});},
  async boundRun(input){request(input,['run_id']);const key=id(input.run_id);return transaction(false,db=>{if(!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_plans'").get())return null;const entry=db.prepare("SELECT value FROM studio_plans WHERE json_extract(value,'$.run_id')=? LIMIT 1").get(key);if(!entry)return null;const plan=JSON.parse(entry.value);row(db,plan.page_id);const task=readStudioTask(db,plan.page_id);return{plan_id:plan.plan_id,page_id:plan.page_id,page_revision:plan.page_revision,task_id:plan.task_id,mode:plan.request.mode,control:studioAbandoned(plan)||task?.editing_only||studioTextOnlySession(db)?'paused':task?.control??'paused',status:studioAbandoned(plan)?'abandoned':plan.status,...(studioAbandoned(plan)?{settlement:plan.settlement}:{})};});},
  async getPlan(input){request(input,['plan_id']);const key=id(input.plan_id);return transaction(false,db=>get(db,key));},
  async pagePlans(input){request(input,['page_id']);const key=id(input.page_id);return transaction(false,db=>{row(db,key);if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_plans'").get())return{plans:[]};return{plans:db.prepare('SELECT value FROM studio_plans WHERE page_id=? ORDER BY rowid DESC LIMIT 20').all(key).map(r=>{const p=JSON.parse(r.value);if(studioAbandoned(p))p.status='abandoned';return Object.fromEntries(['plan_id','page_revision','status','run_id','digest','cost','effective','warnings','created_at','updated_at','settlement'].filter(key=>Object.hasOwn(p,key)&&p[key]!==undefined).map(key=>[key,p[key]]));})};});},
  async notePlan(input,authorization){request(input,['plan_id','stage']);const key=id(input.plan_id);if(!['reviewed','delivered'].includes(input.stage))fail('STUDIO_INVALID_INPUT','Invalid observation stage.');return transaction(true,db=>{const plan=get(db,key);if(plan.status!=='succeeded')fail('STUDIO_PLAN_UNFINISHED','A successful original run is required.');const firstDelivery=plan.observed_stage!=='delivered';if(firstDelivery)plan.observed_stage=input.stage;save(db,plan);const task=readStudioTask(db,plan.page_id);if(task?.control==='auto'&&!task.editing_only&&task.latest_plan_id===key&&!(task.stage==='delivered'&&input.stage==='reviewed')){task.stage=input.stage;if(firstDelivery&&input.stage==='delivered'&&authorization?.message_id&&!task.closed_after_message_id)task.closed_after_message_id=authorization.message_id;saveStudioTask(db,plan.page_id,task);}return plan;});},
  async finishPlan(input){request(input,['plan_id','run_id','status'],['plan_id','status']);const key=id(input.plan_id);if(input.run_id!==undefined)id(input.run_id);if(!['running','succeeded','failed','unknown'].includes(input.status))fail('STUDIO_INVALID_INPUT','Invalid run status.');
   return transaction(true,db=>{const plan=get(db,key);if(studioAbandoned(plan))return plan;if(plan.status==='prepared')fail('STUDIO_PLAN_UNCLAIMED','Cannot attach a result before execution was claimed.');if(plan.run_id&&input.run_id&&plan.run_id!==input.run_id)fail('STUDIO_PLAN_CONFLICT','Run binding is immutable.');
    if(['succeeded','failed'].includes(plan.status)&&plan.status!==input.status)fail('STUDIO_PLAN_CONFLICT','A terminal run cannot regress.');
    if(input.run_id)plan.run_id=input.run_id;plan.status=input.status;plan.updated_at=new Date().toISOString();save(db,plan);const task=readStudioTask(db,plan.page_id);
    if(task?.control==='auto'&&!task.editing_only&&task.latest_plan_id===key){task.stage=input.status==='succeeded'?(plan.observed_stage??'reviewing'):input.status;saveStudioTask(db,plan.page_id,task);}return plan;
   });
  },
 };
}
