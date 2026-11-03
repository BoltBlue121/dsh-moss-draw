import {types,isDeepStrictEqual} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';
import {open,realpath,unlink} from 'node:fs/promises';
import path from 'node:path';
import {createAnalysisService} from './analysis-service.mjs';
import {createStudioStore} from './studio-store.mjs';
import {buildGbcProposal} from './analysis-graph.mjs';
import {fault} from './catalog.mjs';

export const STUDIO_ANALYSIS_ACTIONS=Object.freeze(['studioAnalyzeReference','studioAnalysisStatus','studioAnalysisPropose','studioAnalysisCancel']);
const fields={
  studioAnalyzeReference:['page_id','expected_revision','request_key','references','detail','fit'],
  studioAnalysisStatus:['analysis_id','page_id','request_key','analysis_detail'],
  studioAnalysisPropose:['page_id','expected_revision','analysis_id','vertex_ids'],
  studioAnalysisCancel:['analysis_id'],
};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const invalid=()=>{throw fault('STUDIO_INVALID_INPUT','Invalid reference analysis fields or selectors.');};
const conflict=()=>{throw fault('STUDIO_ANALYSIS_CONFLICT','Analysis page, frozen revision, selection or proposal receipt differs.');};
const nonblank=(value,max)=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!value.includes('\0');
function stringList(value,max,length){
  if(!Array.isArray(value)||types.isProxy(value)||value.length>length||Reflect.ownKeys(value).length!==value.length+1)invalid();
  const result=[];
  for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value')||!nonblank(d.value,max))invalid();result.push(d.value);}
  return result;
}
// Capture the small public request before the first await. No paths/config from a
// graph or Agent become executable configuration; this validator performs no I/O.
export function validateStudioAnalysisInput(action,input){
  const allowed=fields[action];
  if(!allowed||!input||typeof input!=='object'||Array.isArray(input)||types.isProxy(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input)))invalid();
  const args={};
  for(const key of Reflect.ownKeys(input)){
    const d=Object.getOwnPropertyDescriptor(input,key);
    if(typeof key!=='string'||!allowed.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))invalid();
    args[key]=d.value;
    if(['page_id','analysis_id'].includes(key)){if(typeof d.value!=='string'||!uuid.test(d.value))invalid();args[key]=d.value.toLowerCase();}
    else if(key==='expected_revision'){if(!Number.isSafeInteger(d.value)||d.value<1||d.value>=Number.MAX_SAFE_INTEGER)invalid();}
    else if(key==='request_key'){if(!nonblank(d.value,100))invalid();}
    else if(key==='references'){args[key]=stringList(d.value,4096,1);if(args[key].length!==1)invalid();}
    else if(key==='vertex_ids'){args[key]=stringList(d.value,12000,128);if(!args[key].length||new Set(args[key]).size!==args[key].length)invalid();}
    else if(key==='detail'){if(!['quick','balanced','detailed'].includes(d.value))invalid();}
    else if(key==='fit'){if(!['contain','cover','stretch'].includes(d.value))invalid();}
    else if(key==='analysis_detail'&&typeof d.value!=='boolean')invalid();
  }
  const has=k=>Object.hasOwn(args,k);
  if(action==='studioAnalysisStatus'){
    if(has('analysis_id')?(has('page_id')||has('request_key')):has('page_id')!==has('request_key')||has('analysis_detail')&&!has('page_id'))invalid();
  }else{
    const required=action==='studioAnalyzeReference'?['page_id','expected_revision','request_key','references']:action==='studioAnalysisPropose'?['page_id','expected_revision','analysis_id']:['analysis_id'];
    if(required.some(k=>!has(k)))invalid();
  }
  return args;
}
export function analysisServiceFor(entry){
  // Host services are optional: a composition without them keeps the frozen HTTP VLM
  // path, so the analysis service treats every one of them as an optional input.
  return entry.analysis??=createAnalysisService({dataRoot:entry.dataRoot,workspaceAnalysisRoot:entry.studioRoot??entry.dataRoot,runtime:entry.analysisRuntime,resolveCredential:entry.resolveAnalysisCredential,attachments:entry.attachments,llm:entry.llm,agentDefaultModel:entry.agentDefaultModel,logger:entry.logger});
}
function controls(page){
  if(page.proposals.some(p=>p.status==='pending'))throw fault('STUDIO_REVIEW_REQUIRED','Resolve the pending page proposal before reference analysis.');
  if(['manual','paused'].includes(page.task?.control))throw fault('STUDIO_HUMAN_CONTROL','The human retains control of this page.');
  if(page.edit_policy?.mode==='descriptions')throw fault('STUDIO_EDIT_SCOPE','Reference structure analysis changes geometry; descriptions-only mode does not permit it.');
}
function baseMatches(page,revision,doc){
  if(page.revision!==revision||doc&&!isDeepStrictEqual(page.doc,doc))throw fault('STUDIO_CONFLICT','Page changed since reference analysis; reload rather than replacing its content.');
}
const receiptView=(analysisId,receipt,proposal)=>({analysis_id:analysisId,...receipt,status:proposal.status});
const knownProposalErrors=new Set(['STUDIO_CONFLICT','STUDIO_LOCKED','STUDIO_HUMAN_CONTROL','STUDIO_EDIT_SCOPE','STUDIO_SHARED_PROTECTED','STUDIO_INVALID_INPUT','STUDIO_NOT_FOUND','STUDIO_DESCRIPTION_CHECK']);
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
// A crash/unknown database completion must not become a fresh proposal, even
// after reopening the Host. This fence is private to this already-validated job;
// an own service receipt is authoritative and is checked before this marker.
async function claimProposalAttempt(entry,analysisId){
  const directory=path.resolve(entry.dataRoot,'analysis',analysisId),file=path.join(directory,'proposal-attempt.claim'),token=randomUUID();let handle;
  try{
    if(!samePath(await realpath(directory),directory))throw Error();
    handle=await open(file,'wx',0o600);await handle.writeFile(token);await handle.sync();
  }catch{
    throw fault('STUDIO_ANALYSIS_UNKNOWN','A proposal attempt is unresolved or cannot be durably claimed. Inspect the existing page; do not resubmit.');
  }finally{await handle?.close();}
  return{file,token};
}
async function releaseProposalAttempt({file,token}){
  let handle;
  try{
    if(!samePath(await realpath(file),file))return;
    handle=await open(file,'r');const stat=await handle.stat();
    if(!stat.isFile()||stat.nlink!==1||stat.size!==token.length)return;
    const actual=await handle.readFile('utf8');await handle.close();handle=null;
    if(actual===token)await unlink(file);
  }catch{/* Failure leaves the conservative fence, never grants a replacement. */}
  finally{await handle?.close();}
}
export async function handleStudioAnalysisAction(entry,action,input,signal,options={}){
  const args=validateStudioAnalysisInput(action,input);signal?.throwIfAborted();
  if(action==='studioAnalysisStatus'){
    if(!Object.keys(args).length){
      const configured=!!(entry.analysisRuntime?.python&&entry.analysisRuntime?.configPath);
      return{configured,readiness:configured?'unchecked':'unconfigured'};
    }
    return analysisServiceFor(entry).status({...('analysis_id' in args?{analysisId:args.analysis_id}:{pageId:args.page_id,requestKey:args.request_key}),...('analysis_detail' in args?{detail:args.analysis_detail}:{})},{signal});
  }
  if(action==='studioAnalysisCancel')return analysisServiceFor(entry).cancel({analysisId:args.analysis_id},{signal});
  const store=entry.studio??=createStudioStore({dataRoot:entry.studioRoot??entry.dataRoot,workflowMode:entry.workflowMode,connectionIdentity:entry.connectionIdentity});
  if(action==='studioAnalyzeReference'){
    const page=await store.getPage({page_id:args.page_id});controls(page);baseMatches(page,args.expected_revision);
    const baseDoc=structuredClone(page.doc);
    if(!options.resolveAnalysisReference)throw fault('STUDIO_ANALYSIS_NO_CONFIG','Reference image admission is unavailable.');
    const image=await options.resolveAnalysisReference(args.references[0]);signal?.throwIfAborted();
    const current=await store.getPage({page_id:page.page_id});controls(current);baseMatches(current,page.revision,baseDoc);signal?.throwIfAborted();
    return analysisServiceFor(entry).start({pageId:page.page_id,baseRevision:page.revision,baseDoc,requestKey:args.request_key,detail:args.detail??'balanced',fit:args.fit??'contain'},image,{signal,modelSelection:options.modelSelection});
  }
  const analysis=analysisServiceFor(entry),result=await analysis.result({analysisId:args.analysis_id},{signal});
  if(result.pageId!==args.page_id||result.baseRevision!==args.expected_revision)conflict();
  if(!['succeeded','degraded'].includes(result.state)||!result.graph){
    if(result.state==='unknown')throw fault('STUDIO_ANALYSIS_UNKNOWN','Analysis outcome is uncertain; do not restart or propose it.');
    throw fault('STUDIO_ANALYSIS_CONFLICT','Only a successful or degraded analysis can create a proposal.');
  }
  const converted=buildGbcProposal({graph:result.graph,baseDoc:result.baseDoc,source:{sha256:result.source.sha256,width:result.source.width,height:result.source.height},fit:result.fit,...('vertex_ids' in args?{vertexIds:args.vertex_ids}:{})});
  const selection=createHash('sha256').update(JSON.stringify(args.vertex_ids?[...args.vertex_ids].sort():null)).digest('hex');
  const summary=`Reference analysis ${args.analysis_id}: ${converted.mapping.length} objects (${result.fit}); selection ${selection}.`;
  const page=await store.getPage({page_id:args.page_id});signal?.throwIfAborted();
  // store.propose increments revision. An own receipt must be checked first,
  // using saved proposed_doc to detect changed entity selection on a retry.
  if(result.proposal){
    const receipt=result.proposal,p=page.proposals.find(p=>p.proposal_id===receipt.proposal_id);
    if(receipt.page_id!==args.page_id||!p||!['pending','accepted'].includes(p.status)||p.base_revision!==result.baseRevision||p.submitted_revision!==receipt.submitted_revision||!isDeepStrictEqual(p.base_doc,result.baseDoc)||!isDeepStrictEqual(p.proposed_doc,converted.doc)||p.summary!==summary)conflict();
    return receiptView(args.analysis_id,receipt,p);
  }
  controls(page);baseMatches(page,result.baseRevision,result.baseDoc);
  const attempt=await claimProposalAttempt(entry,args.analysis_id);
  if(signal?.aborted){await releaseProposalAttempt(attempt);signal.throwIfAborted();}
  let submitted;
  try{submitted=await store.propose({page_id:page.page_id,expected_revision:page.revision,doc:converted.doc,summary});}
  catch(error){
    if(knownProposalErrors.has(error.code)){await releaseProposalAttempt(attempt);throw error;}
    throw fault('STUDIO_ANALYSIS_UNKNOWN','Proposal commit outcome is uncertain; inspect the page before any further action. Do not resubmit.');
  }
  const proposal=submitted.proposals.find(p=>p.base_revision===page.revision&&p.submitted_revision===submitted.revision&&isDeepStrictEqual(p.proposed_doc,converted.doc));
  if(!proposal)throw fault('STUDIO_ANALYSIS_UNKNOWN','Proposal was submitted but its receipt could not be verified. Do not resubmit.');
  try{
    const receipt=await analysis.recordProposal({analysisId:args.analysis_id,pageId:page.page_id,proposalId:proposal.proposal_id,submittedRevision:proposal.submitted_revision});
    return receiptView(args.analysis_id,receipt,proposal);
  }catch{
    throw fault('STUDIO_ANALYSIS_UNKNOWN','Proposal is saved but its analysis receipt is uncertain. Inspect the existing page proposal; do not resubmit.');
  }
}
