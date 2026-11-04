import {createStudioStore} from './studio-store.mjs';
import {createStudioArchive} from './studio-archive.mjs';
import {compileStudioDoc} from './studio-domain.mjs';
import {applyStudioEdit} from './studio-edit.mjs';
import {studioRemovedRichItems} from './studio-doc-version.mjs';
import {strictObject,fault} from './catalog.mjs';
import {handleStudioAgentAction} from './studio-agent-host.mjs';
import {STUDIO_ANALYSIS_ACTIONS,handleStudioAnalysisAction} from './studio-analysis-host.mjs';

const methods=Object.freeze({studioState:'state',studioCreateSeries:'createSeries',studioCreatePage:'createPage',studioGetPage:'getPage',studioUpdatePage:'updatePage',studioPropose:'propose',studioResolve:'resolve',studioHistory:'history',studioRestore:'restore',studioRenameSeries:'renameSeries',studioDeletePage:'deletePage',studioDeleteSeries:'deleteSeries',studioStart:'startTask',studioAgentUpdate:'agentUpdate',studioTakeover:'takeover',studioResume:'resumeTask',studioPause:'pauseTask',studioOpen:'requestOpen',studioAckOpen:'ackOpen',studioTaskState:'taskState',studioSetEditPolicy:'setEditPolicy',studioConfirmDescriptions:'confirmDescriptions',studioGetSeriesProfile:'getSeriesProfile',studioUpdateSeriesProfile:'updateSeriesProfile',studioApplySeriesProfile:'applySeriesProfile'});
const archiveMethods=Object.freeze({studioArchiveList:'list',studioArchiveAdd:'add',studioArchiveGet:'get',studioArchiveUpdate:'update',studioArchiveDelete:'delete'});
const consentActions=new Set(['studioRequestConsent','studioApplyConsent','studioConsentState']);
const agentActions=new Set(['studioInspect','studioPreview','studioPrepare','studioExecute','studioTaskStatus','studioEdit']);
const agentAllowed=new Set(['studioState','studioCreateSeries','studioCreatePage','studioGetPage','studioPropose','studioResolve','studioStart','studioAgentUpdate','studioOpen','studioTaskState',...consentActions,...agentActions,...STUDIO_ANALYSIS_ACTIONS]);
export function isStudioAction(action){return typeof action==='string'&&(Object.hasOwn(methods,action)||Object.hasOwn(archiveMethods,action)||agentActions.has(action)||consentActions.has(action)||STUDIO_ANALYSIS_ACTIONS.includes(action)||action==='studioConsentHandoff'||action==='studioCompile');}
export async function handleStudioAction(entry,action,input,signal,options={actor:'ui'}){
 signal?.throwIfAborted();
 if(['studioRequestConsent','studioApplyConsent'].includes(action)&&options.actor!=='agent')throw fault('STUDIO_CONSENT_AGENT_ONLY','Consent requests and applications require the native Agent conversation.');
  if(action==='studioExecute'&&options.actor!=='agent')throw fault('STUDIO_EXECUTE_AGENT_ONLY','GPU execution is not a workbench UI command; send an explicit authorized instruction to the Agent.');
 if(options.actor==='agent'&&!agentAllowed.has(action))throw fault('STUDIO_AGENT_FORBIDDEN','This action requires human interaction in the workbench.');
 if(!isStudioAction(action))throw fault('INVALID_INPUT','Unknown studio action.');
 if(!['agent','ui'].includes(options.actor))throw fault('STUDIO_ACTOR_REQUIRED','The adapter must bind the request actor.');
 if(STUDIO_ANALYSIS_ACTIONS.includes(action))return handleStudioAnalysisAction(entry,action,input,signal,options);
 if(options.actor==='agent'&&action==='studioResolve'&&options.readAuthorization)options={...options,authorization:await options.readAuthorization()};
  const args={...input};
 if(Object.hasOwn(args,'doc_json')){
  if(!['studioCreatePage','studioPropose','studioAgentUpdate'].includes(action)||Object.hasOwn(args,'doc'))throw fault('STUDIO_INVALID_INPUT','Invalid document JSON.');
  if(typeof args.doc_json==='string'){
   if(Buffer.byteLength(args.doc_json,'utf8')>524288)throw fault('STUDIO_INVALID_INPUT','Invalid document JSON.');
   try{args.doc=JSON.parse(args.doc_json);}catch{throw fault('STUDIO_INVALID_INPUT','Document JSON must parse.');}
  }else if(args.doc_json&&typeof args.doc_json==='object'&&!Array.isArray(args.doc_json)){
   // A long hand-written JSON string is the most common way a Doc dies: one missing
   // bracket and the whole page is lost. Accepting the structure removes that class.
   if(Buffer.byteLength(JSON.stringify(args.doc_json),'utf8')>524288)throw fault('STUDIO_INVALID_INPUT','Invalid document JSON.');
   args.doc=args.doc_json;
  }else throw fault('STUDIO_INVALID_INPUT','Invalid document JSON.');
  delete args.doc_json;
 }
 if(options.actor==='agent'&&action==='studioCreatePage'){
   if(args.doc?.shared)throw fault('STUDIO_SHARED_PROTECTED','Create a plain page; a human must explicitly apply a versioned series snapshot.');
   // Temporary gate: an Agent page may not start at schema version 2, otherwise a
   // new page would bypass the same-page upgrade path a human must use.
   if(args.doc&&Object.hasOwn(args.doc,'schema_version'))throw fault('STUDIO_SCHEMA_UPGRADE_FORBIDDEN','Create the page as schema version 1; a human must upgrade it.');
 }
 if(action==='studioCompile'){strictObject(args,['doc']);return compileStudioDoc(args.doc);}
 if(Object.hasOwn(archiveMethods,action)){entry.archive??=createStudioArchive({dataRoot:entry.studioRoot??entry.dataRoot});return entry.archive[archiveMethods[action]](args);}
 entry.studio??=createStudioStore({dataRoot:entry.studioRoot??entry.dataRoot,workflowMode:entry.workflowMode,connectionIdentity:entry.connectionIdentity});
 if(action==='studioRequestConsent')return entry.studio.requestConsent(args,{session_id:options.session_id,message_id:options.authorization?.message_id});
  if(action==='studioApplyConsent')return entry.studio.applyConsent(args,{session_id:options.session_id,evidence:options.consentEvidence});
  if(action==='studioConsentState')return entry.studio.consentState(args);
  if(action==='studioConsentHandoff')return entry.studio.ackConsentHandoff(args);
  if(action==='studioTaskState'){const result=await entry.studio.taskState(args);return{...result,...(entry.studio.consentState?await entry.studio.consentState({}):{})};}
  if(action==='studioEdit'){
    if(options.actor!=='agent')throw fault('STUDIO_ACTOR_REQUIRED','Use the workbench editor for a human edit.');
    strictObject(args,['page_id','expected_revision','edit','mode','summary']);
    const edit=strictObject(args.edit,['family','command']);
    if(!['auto','review'].includes(args.mode??'auto')||(args.summary!==undefined&&args.mode!=='review'))throw fault('STUDIO_INVALID_INPUT','Unsupported edit mode or summary.');
    const page=await entry.studio.getPage({page_id:args.page_id});
    if(page.revision!==args.expected_revision)throw fault('STUDIO_CONFLICT','Read the current page revision before editing.');
    const result=applyStudioEdit(page.doc,edit.family,edit.command);
    const receipt={changed_ids:result.changed_ids,created_ids:result.created_ids};
    if(!receipt.changed_ids.length&&!receipt.created_ids.length)return {...receipt,page_id:page.page_id,revision:page.revision,status:'unchanged'};
    const write={page_id:page.page_id,expected_revision:page.revision,doc:result.doc};
    // Both paths recheck the revision, current control, locked objects and edit
    // policy in the store transaction. The pure command confers no write authority.
    const review=args.mode==='review';
    const losses=studioRemovedRichItems(page.doc,result.doc);
    const next=review?await entry.studio.propose({...write,summary:args.summary??'工作台编辑'},losses):await entry.studio.agentUpdate(write,losses);
    return {...receipt,page_id:next.page_id,revision:next.revision,status:review?'proposed':'applied',...(review?{proposal_id:next.proposals.find(proposal=>proposal.submitted_revision===next.revision).proposal_id}:{})};
  }
  if(action==='studioResolve'&&options.actor==='agent'&&!options.authorization?.message_id)throw fault('STUDIO_NEW_REQUEST_REQUIRED','A current native human instruction is required.');
   if(action==='studioStart'&&options.actor==='agent'){
    await entry.studio.assertConsentGeneration?.({message_id:options.authorization?.message_id??null,action:'start',page_id:args.page_id},options.authorization?.consentEvidence);
    if(!options.authorization?.message_id)throw fault('STUDIO_NEW_REQUEST_REQUIRED','A current native human instruction is required.');
    const handoff=await entry.studio.chatHandoff(args,options.authorization);if(handoff)return handoff.page??handoff;
   }
   if(action==='studioStart')await entry.studio.assertConsentGeneration?.({message_id:options.authorization?.message_id??null,action:'start'},options.authorization?.consentEvidence);
  if(agentActions.has(action))return handleStudioAgentAction(entry,action,args,signal,options);
 return entry.studio[methods[action]](args,['studioStart','studioResolve'].includes(action)&&options.actor==='agent'?options.authorization:undefined);
}
