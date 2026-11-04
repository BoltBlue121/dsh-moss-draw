import path from 'node:path';
import {readFile,realpath,stat} from 'node:fs/promises';
import {hash,atomicWrite} from './store.mjs';
import {strictObject,fault} from './catalog.mjs';
import {validateAssets} from './modes.mjs';
import {compileStudioDoc} from './studio-domain.mjs';
import {renderStudioPreview} from './studio-preview.mjs';
import {studioSceneSummary} from './studio-scene.mjs';

const fail=(code,message)=>{throw fault(code,message);};
const checkedPage=async(store,args)=>{strictObject(args,['page_id','expected_revision']);const p=await store.getPage({page_id:args.page_id});if(args.expected_revision!==undefined&&p.revision!==args.expected_revision)fail('STUDIO_CONFLICT','Read the current page revision first.');return p;};
// Optional object fields may be absent in service observations. Omit only those
// undefined fields; never coerce invalid numbers, bigint or array holes to JSON.
function statusJson(value,ancestors=new Set()){
 const invalid=()=>fail('STUDIO_STATUS_INVALID_JSON','Run status contains non-JSON data.');
 if(value===null||typeof value==='string'||typeof value==='boolean')return value;
 if(typeof value==='number'){if(!Number.isFinite(value)||Object.is(value,-0))invalid();return value;}
 if(typeof value!=='object')invalid();
 const array=Array.isArray(value);
 if(!array&&![Object.prototype,null].includes(Object.getPrototypeOf(value))||ancestors.has(value))invalid();
 const keys=Reflect.ownKeys(value),entries=[];
 if(array&&keys.length!==value.length+1)invalid();
 ancestors.add(value);
 for(const key of keys){
  if(array&&key==='length')continue;
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(typeof key!=='string'||!descriptor.enumerable||!Object.hasOwn(descriptor,'value')||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))invalid();
  if(!array&&descriptor.value===undefined)continue;
  entries.push([key,statusJson(descriptor.value,ancestors)]);
 }
 ancestors.delete(value);
 return array?entries.map(([,entry])=>entry):Object.fromEntries(entries);
}
function safeRun(run){
 if(!run||typeof run!=='object')return null;
 const result=statusJson(Object.fromEntries(['run_id','status','params','artifact','context','error'].filter(key=>Object.hasOwn(run,key)&&run[key]!==undefined).map(key=>[key,run[key]])));
 // Core embeds review in context; regional services return it alongside context.
 if(run.review!==undefined&&result.context?.review===undefined)result.context={...(result.context??{}),review:statusJson(run.review)};
 return result;
}
const runStatus=status=>status==='succeeded'||status==='failed'||status==='unknown'?status:'running';
export async function readStudioAssets(entry,plan){
 const root=await realpath(path.join(entry.studioRoot??entry.dataRoot,'studio','plan-assets',plan.plan_id)),assets=[];
 for(let i=0;i<plan.assets.length;i++){
  const file=await realpath(path.join(root,`${i}.bin`)),relative=path.relative(root,file);if(relative.startsWith('..')||path.isAbsolute(relative))fail('STUDIO_ASSET_INTEGRITY','Frozen asset escaped its plan.');
  const info=await stat(file);if(!info.isFile()||info.size>32*1024*1024)fail('STUDIO_ASSET_INTEGRITY','Invalid frozen asset size.');
  const data=await readFile(file),meta=plan.assets[i];if(hash(data)!==meta.sha256)fail('STUDIO_ASSET_INTEGRITY','Frozen asset changed.');assets.push({data,mediaType:meta.mediaType,width:meta.width,height:meta.height});
 }return assets;
}
export async function handleStudioAgentAction(entry,action,args,signal,options){
 const store=entry.studio;
 if(action==='studioInspect'){const page=await checkedPage(store,args);return{page_id:page.page_id,revision:page.revision,compilation:compileStudioDoc(page.doc),scene:studioSceneSummary(page.doc.layout),edit_policy:page.edit_policy,descriptions_status:page.descriptions_status,series_profile:await store.getSeriesProfile({series_id:page.series_id}),task:page.task??null};}
 if(action==='studioPreview'){const page=await checkedPage(store,args),{data,...info}=renderStudioPreview(page.doc);return{page_id:page.page_id,revision:page.revision,...info,data_url:`data:image/png;base64,${data.toString('base64')}`};}
 if(action==='studioPrepare'){
  strictObject(args,['page_id','expected_revision','request_key','settings','references']);
  const current=await checkedPage(store,{page_id:args.page_id,expected_revision:args.expected_revision});
   await store.assertConsentGeneration?.({message_id:options.authorization?.message_id??null,backend:args.settings?.backend??'moss',page_id:current.page_id,task_id:current.task?.task_id,action:'prepare'},options.authorization?.consentEvidence);
   const references=args.references===undefined?[]:args.references; if(!Array.isArray(references)||references.length>4)fail('STUDIO_INVALID_INPUT','Expected at most four admitted reference paths.');
  const assets=[];for(const ref of references){if(typeof ref!=='string'||!options.resolveReference)fail('STUDIO_REFERENCE_UNAVAILABLE','Reference is not admitted.');signal?.throwIfAborted();const {data,mediaType,width,height}=await options.resolveReference(ref);assets.push({data,mediaType,width,height});}
  const checked=validateAssets(assets,args.settings?.backend==='qwen'||args.settings?.mode==='regions'?4500000:2100000),metadata=checked.map(({sha256,width,height,mediaType})=>({sha256,width,height,mediaType}));signal?.throwIfAborted();
  const {references:_references,...parameters}=args;
  const authorization=options.readAuthorization?await options.readAuthorization():options.authorization;
   const plan=await store.preparePlan({...parameters,assets:metadata},assets,entry.editEngine??'native',authorization);
  for(let i=0;i<checked.length;i++)await atomicWrite(path.join(entry.studioRoot??entry.dataRoot,'studio','plan-assets',plan.plan_id,`${i}.bin`),checked[i].data);
  if(plan.execution_contract==='layout-preview-v1'){const {data}=renderStudioPreview(plan.doc);return{...plan,data_url:`data:image/png;base64,${data.toString('base64')}`,preview_binding:{plan_id:plan.plan_id,digest:plan.digest,page_id:plan.page_id,page_revision:plan.page_revision}};}
   return plan;
 }
 if(action==='studioExecute'){
  strictObject(args,['plan_id']);const existing=await store.getPlan(args);
  if(existing.status!=='prepared'){
   if(!existing.run_id&&['submitting','unknown'].includes(existing.status)){
    const ledger=existing.request.mode==='regions'?path.join(entry.dataRoot,'region-pipelines'):entry.dataRoot;
    try{const file=path.join(ledger,'requests',hash(existing.request.request_id)+'.json'),info=await stat(file);if(info.size>8*1024*1024)fail('STUDIO_PLAN_INTEGRITY','Claim size invalid.');const claim=JSON.parse(await readFile(file,'utf8'));if(claim.request_id!==existing.request.request_id)fail('STUDIO_PLAN_INTEGRITY','Claim does not match this plan.');return store.finishPlan({plan_id:existing.plan_id,run_id:claim.run_id,status:'unknown'});}catch(error){if(error.code!=='ENOENT')throw error;}
   }return existing;
  }
  await store.assertConsentGeneration?.({message_id:options.authorization?.message_id??null,backend:existing.request.backend??'moss',page_id:existing.page_id,task_id:existing.task_id,action:'execute'},options.authorization?.consentEvidence);
   if(['edit','regions'].includes(existing.request.mode)&&(existing.edit_engine??'native')!==(entry.editEngine??'native'))fail('STUDIO_ENGINE_CHANGED','Trusted edit backend changed; prepare a new plan.');
   const assets=existing.assets.length?await readStudioAssets(entry,existing):[];signal?.throwIfAborted();const claimed=await store.claimPlan(args,options.readAuthorization?await options.readAuthorization():options.authorization);if(!claimed.owner)return claimed.plan;
  try{
   let result=await entry.service.generate(claimed.plan.request,assets,{signal});
   if(claimed.plan.request.mode==='regions'&&result.status==='draft')result=await entry.service.generate({backend:'moss',mode:'regions',action:'execute',plan_id:result.run_id},[],{signal});
   return await store.finishPlan({plan_id:existing.plan_id,run_id:result.run_id,status:runStatus(result.status)});
  }catch(error){await store.finishPlan({plan_id:existing.plan_id,status:'unknown'});throw error;}
 }
 if(action==='studioTaskStatus'){
  strictObject(args,['page_id']);const page=await store.getPage(args),{plans}=await store.pagePlans(args),results=[];
  for(const p of plans){
    if(!p.run_id){results.push(p);continue;}
    let data;try{data=await entry.service.context({run_id:p.run_id},{signal});}catch(error){results.push({...p,observation_error:'Run status temporarily unavailable.'});continue;}
    // A corrupt observation must not be disguised as a transient service error.
    const run=data.runs?.find(r=>r.run_id===p.run_id);results.push({...p,run:safeRun(run)});
   }
  return{page,plans:results,...(store.consentState?await store.consentState({page_id:args.page_id}):{})};
 }
 fail('INVALID_INPUT','Unknown Agent Studio action.');
}
