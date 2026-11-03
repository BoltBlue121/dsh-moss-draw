/** Strict, browser-safe operation contract and canonical human presentation. */
import {formatStudioConsentQuestion,isBriefStudioConsentGoal} from './studio-consent-presentation.mjs';
const invalid=message=>{throw Object.assign(new TypeError(message),{code:'STUDIO_INVALID_INPUT'});};
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function object(value,keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid('Expected a plain consent object.');
 for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!keys.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))invalid('Unknown or non-data consent field.');}
 if(keys.some(key=>!Object.hasOwn(value,key)))invalid('Missing consent field.');
}
function array(value){if(!Array.isArray(value)||value.length>263||Reflect.ownKeys(value).length!==value.length+1)invalid('Consent selectors must be a bounded dense array.');for(let i=0;i<value.length;i++){const d=Object.getOwnPropertyDescriptor(value,String(i));if(!d?.enumerable||!Object.hasOwn(d,'value'))invalid('Invalid selector property.');}}
export function normalizeStudioConsentOperations(value){
 object(value,['proposal','resume','exit_text_only','generation','continue_generation']);
 for(const k of ['resume','exit_text_only','continue_generation'])if(typeof value[k]!=='boolean')invalid('Consent flags must be boolean.');
 let proposal=null;
 if(value.proposal!==null){const p=value.proposal;object(p,['proposal_id','accept','reject']);if(typeof p.proposal_id!=='string'||!UUID.test(p.proposal_id)||typeof p.reject!=='boolean')invalid('Invalid proposal decision.');array(p.accept);
  if(p.accept.some(x=>typeof x!=='string'||!x||x.length>100)||new Set(p.accept).size!==p.accept.length|| (p.reject?p.accept.length!==0:p.accept.length===0))invalid('Choose unique proposal selectors or explicit rejection.');
  proposal={proposal_id:p.proposal_id.toLowerCase(),accept:[...p.accept],reject:p.reject};
 }
 const g=value.generation;object(g,['mode','runs','backend','intent']);
 if(!['none','use_remaining','add_to_active','new_task'].includes(g.mode)||!Number.isSafeInteger(g.runs)||typeof g.intent!=='string'||g.intent.length>4000)invalid('Invalid generation mode, runs or intent.');
 if(g.mode==='none'){if(g.runs!==0||g.backend!==null||g.intent!==''||value.continue_generation)invalid('None grants zero generation and cannot continue.');}
 else{if(!['moss','k2','qwen'].includes(g.backend))invalid('Generation backend must be explicit.');
  if(g.mode==='use_remaining'&&g.runs!==0||g.mode==='add_to_active'&&(g.runs<1||g.runs>20)||g.mode==='new_task'&&(g.runs<1||g.runs>4))invalid('Invalid run allowance.');
  if(g.mode==='new_task'?!g.intent.trim():g.intent!=='')invalid('Only a new task carries a nonempty intent.');
   if(g.mode==='new_task'&&!isBriefStudioConsentGoal(g.intent))invalid('新任务intent须为不超过80字的单句简短目标；完整prompt放Doc，执行参数放studioPrepare.settings。');
 }
 if(!proposal&&!value.resume&&!value.exit_text_only&&g.mode==='none')invalid('Consent needs at least one explicit operation.');
 return {proposal,resume:value.resume,exit_text_only:value.exit_text_only,generation:{mode:g.mode,runs:g.runs,backend:g.backend,intent:g.intent},continue_generation:value.continue_generation};
}
export function canonicalStudioConsent(value){
 if(Array.isArray(value))return value.map(canonicalStudioConsent);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonicalStudioConsent(value[k])]));
 return value;
}
export function studioConsentQuestion(input){return formatStudioConsentQuestion(input);}
