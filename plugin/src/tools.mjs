import { realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { readGuide, GUIDE_TOPICS } from './guide.mjs';
import { loadSdk, resolveConfig } from './sdk.mjs';
import { installScopePolicy } from './preset.mjs';
import { waitForRun, WAIT_TOOL_TIMEOUT_MS } from './wait.mjs';
import { createWorkbenchStore } from './workbench-store.mjs';
import { createStudioStore, studioProposalSelectors } from './studio-store.mjs';
import {studioRequestAuthorization,registerStudioAuthorization} from './studio-authorization.mjs';
import {registerStudioConsentAuthority} from './studio-consent-authority.mjs';
import { createWorkbenchBridge, registerWorkbenchCommand } from './workbench-host.mjs';

export const name = 'moss-draw-scope';
export const inject = ['tools', 'systemPrompt', 'attachments', 'sessionProjections', 'commands'];
const fail = code => { throw Object.assign(new Error(code), { code }); };
// Normalize only JSON omissions at the tool boundary. Never invoke getters or
// toJSON, silently stringify classes, or turn corrupt numeric data into null.
export function losslessOutput(value) {
  const ancestors=new Set();
  const bad=()=>fail('MOSS_OUTPUT_INVALID');
  function copy(input) {
    if(input===null||typeof input==='string'||typeof input==='boolean')return input;
    if(typeof input==='number'){if(!Number.isFinite(input))bad();return Object.is(input,-0)?0:input;}
    if(typeof input!=='object'||ancestors.has(input))bad();
    const array=Array.isArray(input);
    if(!array&&![Object.prototype,null].includes(Object.getPrototypeOf(input)))bad();
    ancestors.add(input);
    const entries=[];
    for(const key of Reflect.ownKeys(input)){
      if(array&&key==='length')continue;
      const d=Object.getOwnPropertyDescriptor(input,key);
      if(typeof key!=='string'||!d.enumerable||!Object.hasOwn(d,'value')||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=input.length))bad();
      if(!array&&d.value!==undefined)entries.push([key,copy(d.value)]);
    }
    let result;
    if(array){result=Array.from({length:input.length},(_,i)=>{const d=Object.getOwnPropertyDescriptor(input,String(i));return !d||d.value===undefined?null:copy(d.value);});}
    else result=Object.fromEntries(entries);
    ancestors.delete(input);return result;
  }
  return copy(value);
}
const CONTEXT_SHAPES='MOSS_INPUT: limit means recent runs: integer 1..3 (default 3), alone or with run_id. Choose one shape: {} | {limit:1..3} | {studio_pages:true} | {studio_tasks:true} | {studio_consent:true} | {studio_page_id} (+ studio_status:true OR studio_inspect:true) | {documents:true} | {document_id} | {run_id}. Do not mix shapes; use studio_pages/documents to list pages, not a larger limit.';
function contextInput(){throw Object.assign(new Error(CONTEXT_SHAPES),{code:'MOSS_INPUT'});}
function validateContextShape(args){
  const keys=Object.keys(args);
  if(!keys.length)return;
  if(keys.length===1&&Number.isSafeInteger(args.limit)&&args.limit>=1&&args.limit<=3)return;
  if(['studio_pages','studio_tasks','studio_consent','documents'].some(key=>keys.length===1&&args[key]===true))return;
  if(keys.length===1&&typeof args.document_id==='string')return;
  if(typeof args.studio_page_id==='string'&&keys.every(k=>['studio_page_id','studio_status','studio_inspect'].includes(k))&&(!Object.hasOwn(args,'studio_status')||args.studio_status===true)&&(!Object.hasOwn(args,'studio_inspect')||args.studio_inspect===true)&&!(args.studio_status&&args.studio_inspect))return;
  if(typeof args.run_id==='string'&&keys.every(k=>['run_id','limit'].includes(k))&&(!Object.hasOwn(args,'limit')||Number.isSafeInteger(args.limit)&&args.limit>=1&&args.limit<=3))return;
  contextInput();
}
const safeCoreCodes = new Set(['INVALID_INPUT','MODEL_STYLE_MISMATCH','REQUEST_CONFLICT','RUN_NOT_FOUND','STORE_CORRUPT','LOCAL_ERROR','INVALID_CONFIG','UNSAFE_OUTPUT','RESPONSE_TOO_LARGE','INVALID_RESPONSE','REDIRECT_BLOCKED','NETWORK_UNKNOWN','HTTP_ERROR','INVALID_ARTIFACT','RECONCILE_AMBIGUOUS']);
function safeError(error) {
  if(['STUDIO_EDIT_SCOPE','STUDIO_SHARED_PROTECTED','STUDIO_DESCRIPTION_CHECK'].includes(error.code))return `${error.code}: ${String(error.message).slice(0,500)}`;
  if(error.code?.startsWith('STUDIO_CONSENT_'))return `${error.code}: ${String(error.message).slice(0,500)}`;
  if(error.code==='STUDIO_TEXT_ONLY')return 'STUDIO_TEXT_ONLY: This workbench request authorizes text editing only. Do not start/prepare/execute or use raw/another page to bypass it. A human must explicitly end text-only mode in the workbench.';
  if(error.code==='STUDIO_AUTHORIZATION_HISTORY')return 'STUDIO_AUTHORIZATION_HISTORY: Native session provenance could not be verified. Retry after the drawing plugin loads normally; do not create a page or reset a budget to bypass it.';
  if(error.code==='STUDIO_REGION_BINDING')return `${error.code}: ${String(error.message).slice(0,600)}`;
  if(error.code==='STUDIO_INVALID_INPUT')return `${error.code}: ${String(error.message).slice(0,600)}`;
  if(['STUDIO_TASK_EXISTS','STUDIO_TASK_UNSETTLED','STUDIO_NEW_REQUEST_REQUIRED','STUDIO_BUDGET_EXHAUSTED'].includes(error.code))return `${error.code}: ${String(error.message).slice(0,400)} Delivered, failed or human-abandoned, fully settled tasks can use studioStart on the SAME page for a new human request; do not create pages merely to reset a budget.`;
  if(error.code==='STUDIO_TASK_BINDING_REQUIRED')return `${error.code}: Read art_context(studio_tasks:true); save the full Doc via studioAgentUpdate, then studioPrepare -> studioExecute. Raw generation is not this task route; pausing does not unlock it. Do not shorten the prompt or spend a run to clear the task.`;
  if (/^(MOSS|WORKBENCH|STUDIO)_[A-Z0-9_]+$/.test(error.code ?? error.message)) return error.code ?? error.message;
  if (safeCoreCodes.has(error.code)) return `${error.code}: ${String(error.message).slice(0, 250)}`;
  return 'MOSS_OPERATION_FAILED: use the maintenance conversation; do not retry unknown';
}
const str = (description, required = false) => ({ type: 'string', description, ...(required ? { required: true } : {}) });
const number = description => ({ type: 'number', description });
const strings = (description, required = false) => ({ type: 'array', items: { type: 'string' }, description, ...(required ? { required: true } : {}) });
const runParam = { run_id: str('This session run UUID.', true) };
const loraProperties = { file: { type: 'string' }, strength: { type: 'number' }, trigger: { type: 'string' } };
const loraList = description => ({ type: 'array', items: { type: 'object', additionalProperties: false, properties: loraProperties }, description });
const compactStudio = value => !Array.isArray(value?.proposals)?value:{...value,proposals:value.proposals.map(p=>{const{proposal_id,status,summary,base_revision,submitted_revision,accepted}=p;return{proposal_id,status,summary,base_revision,submitted_revision,accepted,...(p.base_doc&&p.proposed_doc?{changed_selectors:studioProposalSelectors(p),proposed_kind:p.proposed_doc.kind}:{})};})};
const characterProperties = { prompt: str('One character description.', true), style: { type: 'string', enum: ['none'] }, x: number('Normalized center x.'), y: number('Normalized center y.'), lora_strength: number('Must be 0; no style LoRA ships in this package.') };
const regionProperties = {
  id: str('Stable region label.'), box: { type:'array', items:{type:'integer'}, description:'Observed pixel [left,top,right,bottom]; right/bottom exclusive.' },
  reference_index:{type:'integer',description:'Index in references; 0 is canvas, character starts at 1.'}, prompt:str('Region edit instruction.'),
  style:{type:'string',enum:['none']},lora_strength:number('Must be 0; no built-in style LoRA ships here.'),loras:loraList('Stacked LoRAs: file/strength/trigger, max 4.'),seed:{type:'integer'},
  context_px:{type:'integer'},feather_px:{type:'integer'},steps:{type:'integer'},cfg:number('Edit CFG.'),qwen_prompt:str('Optional subsequent local Qwen repair.')
};
const WORKBENCH_AGENT_ACTIONS=['create','propose','materialize','importPlan','studioCreateSeries','studioCreatePage','studioPropose','studioResolve','studioStart','studioAgentUpdate','studioOpen','studioPrepare','studioExecute','studioRequestConsent','studioApplyConsent'];
const workbenchProperties = {
  action:{type:'string',enum:WORKBENCH_AGENT_ACTIONS},
  proposal_id:str(''),accept:strings(''),reject:{type:'boolean'},
   consent_id:str('Saved conversation consent UUID; apply only.'),operations:{type:'object',additionalProperties:true,description:'完整五项：proposal/resume/exit_text_only/generation/continue_generation；例见studio。'},
  descriptions_checked:{type:'boolean',description:'True after description updates with saved geometry unchanged; not generation consent.'},intent:str('studioStart intent'),mode:{type:'string',enum:['auto','review']},max_runs:{type:'integer'},request_key:str('Stable plan key.'),plan_id:str('Frozen Studio plan UUID.'),settings:{type:'object',additionalProperties:true,description:'Backend settings; saved-page prompt. Regions: Layout canvas + region_bindings.'},
  series_id:str('Studio series UUID.'),page_id:str('Studio page UUID.'),doc_json:str('Full Doc JSON; caption≤12000 chars. Size: doc.layout, not workbench.canvas.'),
  doc:{type:'object',additionalProperties:true,description:'Full Doc structure; alternative to doc_json, no stringifying.'},
  document_id:str('Document UUID.'),expected_revision:{type:'integer'},run_id:str('Regional plan UUID to import.'),title:str('Document title.'),
  canvas:{type:'object',properties:{width:{type:'integer'},height:{type:'integer'},reference:str('Same as references[0].')},additionalProperties:false},
  references:strings('Visible base PNG, then character images.'),regions:{type:'array',items:{type:'object',additionalProperties:true},description:'Region fields; optional body{x,y,z,width,height,depth,yaw}, group, locked.'},
  prompt:str('Scene intent.'),qwen_full_prompt:str('Optional full Qwen.'),camera:{type:'object',additionalProperties:true,description:'orbit/pitch/roll/distance/fov/pan_x/pan_y/pan_z numeric fields.'},
  patch:{type:'object',additionalProperties:true,description:'Proposal patch: prompt/camera/regions/title/qwen_full_prompt; host validates.'},summary:str('Only studioPropose/propose. Omit for studioAgentUpdate.')
};
const schemas = {
  art_guide: { topic: { type: 'string', enum: [...GUIDE_TOPICS] }, offset: { type: 'integer' }, limit: { type: 'integer', description: 'At most 9000 characters.' } },
  art_context: { studio_consent:{type:'boolean',description:'单独传true。'},studio_tasks:{type:'boolean',description:'仅{studio_tasks:true}；不混其他字段。'},studio_inspect:{type:'boolean',description:'只搭配studio_page_id，不混status。'},studio_status:{type:'boolean',description:'只搭配studio_page_id，不混inspect。'},studio_pages:{type:'boolean',description:'单独传true。'},studio_page_id:str('Studio page UUID.'),limit: { type: 'integer', description: 'Recent runs, default 3.' }, run_id: str('Optional run UUID for full prompt and brief.'), document_id:str('Workbench document UUID; returns its current content.'), documents:{type:'boolean',description:'List workbench documents instead of runs.'} },
  art_generate: {
    backend: { type: 'string', enum: ['moss','k2','qwen'], description: 'Default moss. K2 text-to-image without style LoRA; Qwen edits references.' },
    mode: { type: 'string', enum: ['t2i','edit','inpaint','characters','regions','workbench'] },
    workbench:{type:'object',additionalProperties:false,properties:workbenchProperties,description:'仅{mode:"workbench",workbench:{...}}；不带外层request_id/prompt。动作字段见studio。'},
    references: strings('1..4 visible paths or run:<UUID>; regions: PNG canvas, then characters.'),
    action: {type:'string',enum:['draft','execute']}, plan_id:str('Saved region plan UUID for execute.'),
    regions:{type:'array',items:{type:'object',additionalProperties:false,properties:regionProperties},description:'1..4 ordered Agent-planned regions.'},
    qwen_full_prompt:str('Optional whole-canvas Qwen pass; changes outside regions allowed.'),
    characters: { type: 'array', items: { type: 'object', additionalProperties: false, properties: characterProperties }, description: 'Moss characters mode: 1..2 character objects.' },
    request_id: str('仅原始生成；workbench/execute不传。'), prompt: str('原始prompt≤12000；workbench/execute不传。'),
    negative: str('Optional negative prompt.'), style: { type: 'string', enum: ['none'] }, model: str('Model ID from art_context catalog.'),
    width: { type: 'integer' }, height: { type: 'integer' }, steps: { type: 'integer' }, cfg: number('Backend/mode default from art_context.'), shift: number('Only if this backend/mode supports it.'),
    sampler: { type: 'string', description: 'T2i sampler; default euler.' },
    scheduler: { type: 'string', description: 'T2i scheduler; default sgm_uniform.' },
    seed: { type: 'integer' },
    lora_strength: number('Only style none ships; must be 0.'), loras: loraList('Stacked caller LoRAs: file/strength/trigger, max 4; Qwen rejects them.'), brief: str('Short user intent.'), checks: strings('Visible acceptance items.'), parent_run_id: str('Optional prior UUID in this session.'),
  },
  art_run: runParam,
  art_review: { ...runParam, observations: strings('Observed pixels: up to 12 items, 500 chars each.', true), issues: strings('Visible issues: up to 12 items, 160 chars each.', true), next_change: str('One proposed change, max 500 chars; not user score.', true) },
  art_view: { studio_page_id:str('Studio blockout preview page UUID.'),expected_revision:{type:'integer'},run_id: str('This session run UUID; use exactly one selector.'), path: str('User-supplied workspace image or this session attachment host path.'), variant:{type:'string',enum:['result','preview']} },
  art_deliver: runParam,
};
function validate(name, args) {
  const schema = schemas[name];
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !Object.hasOwn(schema, k))) fail('MOSS_INPUT');
  if(name==='art_context')validateContextShape(args);
  for (const [key, spec] of Object.entries(schema)) {
    const value = args[key];
    if (value === undefined) { if (spec.required) fail('MOSS_INPUT'); continue; }
    // Hand-written JSON is the most common way a long Doc dies (one missing bracket).
    // Accept the structure itself as well as a string, so the model can skip stringifying.
    if (key === 'doc_json' && (typeof value === 'string' || (value && typeof value === 'object' && !Array.isArray(value)))) continue;
    if (spec.type === 'array' ? !Array.isArray(value) || value.some(x => spec.items.type === 'object' ? !x || typeof x !== 'object' || Array.isArray(x) : typeof x !== 'string') : spec.type === 'integer' ? !Number.isSafeInteger(value) : spec.type === 'number' ? typeof value !== 'number' || !Number.isFinite(value) : typeof value !== spec.type) fail('MOSS_INPUT');
    if (spec.enum && !spec.enum.includes(value)) fail('MOSS_INPUT');
  }
  if (name==='art_context') {
    if(args.studio_consent!==undefined){if(args.studio_consent!==true||Object.keys(args).length!==1)fail('MOSS_INPUT');}
    if(args.studio_pages!==undefined||args.studio_tasks!==undefined){if(Object.keys(args).length!==1||args.studio_pages!==true&&args.studio_tasks!==true)fail('MOSS_INPUT');}
    if(args.studio_page_id!==undefined){if(Object.keys(args).some(k=>!['studio_page_id','studio_inspect','studio_status'].includes(k))||args.studio_inspect!==undefined&&args.studio_inspect!==true||args.studio_status!==undefined&&args.studio_status!==true||args.studio_inspect&&args.studio_status)fail('MOSS_INPUT');}
    else if(args.studio_inspect!==undefined||args.studio_status!==undefined)fail('MOSS_INPUT');
    if(args.document_id!==undefined && (args.run_id!==undefined||args.documents!==undefined||args.limit!==undefined))fail('MOSS_INPUT');
    if(args.documents!==undefined && (args.run_id!==undefined||args.limit!==undefined))fail('MOSS_INPUT');
  }
  if(name==='art_generate'&&args.mode==='workbench') {
    const action=args.workbench?.action;if(['studioRequestConsent','studioApplyConsent'].includes(action)){const keys=action==='studioApplyConsent'?['action','consent_id']:['action','page_id','expected_revision','request_key','operations'];if(Object.keys(args.workbench).some(k=>!keys.includes(k)))fail('MOSS_INPUT');}
    if(Object.keys(args).some(k=>!['mode','workbench'].includes(k))||!args.workbench||typeof args.workbench!=='object'||Array.isArray(args.workbench)||!WORKBENCH_AGENT_ACTIONS.includes(args.workbench.action))fail('MOSS_INPUT');
    return;
  }
  if(name==='art_generate'&&args.workbench!==undefined)fail('MOSS_INPUT');
  if (name === 'art_generate') {
    const executePlan=args.mode==='regions'&&args.action==='execute';
    if(executePlan) {
      if(!args.plan_id || Object.keys(args).some(k=>!['mode','action','plan_id','backend'].includes(k))) fail('MOSS_INPUT');
    } else if(typeof args.request_id!=='string'||!args.request_id.trim()||typeof args.prompt!=='string'||!args.prompt.trim()) fail('MOSS_INPUT');
    if(args.mode!=='regions' && ['action','plan_id','regions','qwen_full_prompt'].some(k=>args[k]!==undefined)) fail('MOSS_INPUT');
    if(args.mode==='regions' && (args.backend!==undefined&&args.backend!=='moss')) fail('MOSS_INPUT');
    if(args.mode==='regions'&&!executePlan) {
      if(args.plan_id!==undefined||!Array.isArray(args.regions)||args.regions.length<1||args.regions.length>4) fail('MOSS_INPUT');
      for(const r of args.regions) {
        if(Object.keys(r).some(k=>!Object.hasOwn(regionProperties,k))||typeof r.id!=='string'||typeof r.prompt!=='string'||!Array.isArray(r.box)||r.box.length!==4||r.box.some(x=>!Number.isSafeInteger(x))||!Number.isSafeInteger(r.reference_index))fail('MOSS_INPUT');
        for(const [k,v] of Object.entries(r)) {const s=regionProperties[k]; if(s.type==='array')continue;
          if(s.type==='integer'?!Number.isSafeInteger(v):s.type==='number'?typeof v!=='number'||!Number.isFinite(v):typeof v!==s.type)fail('MOSS_INPUT');
          if(s.enum&&!s.enum.includes(v))fail('MOSS_INPUT');
        }
      }
    }
    if (args.references !== undefined && (args.references.length < 1 || args.references.length > 4 || !['edit','inpaint','regions'].includes(args.mode))) fail('MOSS_INPUT');
    if (args.characters !== undefined) {
      if (args.characters.length < 1 || args.characters.length > 2 || args.mode !== 'characters') fail('MOSS_INPUT');
      for (const character of args.characters) {
        if (Object.keys(character).some(k => !Object.hasOwn(characterProperties, k)) || typeof character.prompt !== 'string' || !character.prompt.trim()) fail('MOSS_INPUT');
        for (const [key, value] of Object.entries(character)) {
          const spec = characterProperties[key];
          if (typeof value !== spec.type || spec.type === 'number' && !Number.isFinite(value) || spec.enum && !spec.enum.includes(value)) fail('MOSS_INPUT');
        }
      }
    }
  }
  if (args.run_id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.run_id)) fail('MOSS_INPUT');
  if (args.plan_id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(args.plan_id)) fail('MOSS_INPUT');
  if (name === 'art_view' && ([args.run_id,args.path,args.studio_page_id].filter(x=>x!==undefined).length!==1 || args.variant!==undefined&&args.run_id===undefined || args.expected_revision!==undefined&&args.studio_page_id===undefined)) fail('MOSS_INPUT');
}
function inside(root, file) { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative); }
function mime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
  fail('MOSS_IMAGE_FORMAT');
}
async function imageBytes(file) {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size < 12 || info.size > 32 * 1024 * 1024) fail('MOSS_IMAGE_SIZE');
    const data = await handle.readFile();
    if (data.length !== info.size) fail('MOSS_IMAGE_CHANGED');
    return { data, mediaType: mime(data), sha256: createHash('sha256').update(data).digest('hex') };
  } finally { await handle.close(); }
}
function mentionsPath(text, candidate, workspaceRoot) {
  // Quoted/Markdown destinations are indivisible: never authorize their tail
  // basename. Paths containing whitespace must be quoted, in <...>, or backticks.
  const tokens = [];
  const rest = text.replace(/@?(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|<([^<>\r\n]+)>)/g, (_all, ...groups) => {
    tokens.push(groups.slice(0, 4).find(value => value !== undefined));
    return ' ';
  });
  tokens.push(...(rest.match(/[^\s"'`<>()[\]，。；：]+/g) ?? []));
  const normalized = value => process.platform === 'win32' ? value.toLowerCase() : value;
  return tokens.some(token => {
    token = token.replace(/^@/, '');
    if (!token || /^(?:https?:|data:|file:)/i.test(token)) return false;
    return normalized(path.resolve(workspaceRoot, token)) === normalized(candidate);
  });
}
async function referencePath(input, exec, config, attachments) {
  if (typeof input !== 'string' || !input || input.length > 4096 || input.includes('\0') || /^(?:https?:|data:|file:)/i.test(input)) fail('MOSS_IMAGE_NOT_VISIBLE');
  const candidate = path.resolve(config.workspaceRoot, input);
  const file = await realpath(candidate);
  const messages = exec.agent?.session.deriveMessages() ?? [];
  let supplied = false;
  for (const message of messages) {
    if (message.source?.kind !== 'user') continue;
    for (const part of message.content ?? []) {
      if (part.type === 'text' && mentionsPath(part.text, candidate, config.workspaceRoot)) supplied = true;
      if (part.type === 'image' || part.type === 'file') {
        const hostPath = part.type === 'image' ? await attachments.imageHostPath?.(part.attachment) : await attachments.fileHostPath?.(part.attachment);
        if (hostPath && path.resolve(hostPath) === candidate && await realpath(hostPath) === file) return file;
      }
    }
  }
  if (supplied && inside(await realpath(config.workspaceRoot), file)) return file;
  fail('MOSS_IMAGE_NOT_VISIBLE');
}

// Per-native-session service boundaries prevent request_id collisions and prompt
// discovery across independent drawing conversations. No cross-session scan.
export function sessionServices(config, factory) {
  const services = new Map();
  return exec => {
    const id = exec.agent?.id ?? exec.agent?.session.id;
    if (typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id)) fail('MOSS_SESSION_REQUIRED');
    let entry = services.get(id);
    if (!entry) {
      const dataRoot = path.join(config.dataRoot, 'sessions', id);
      // The generation ledger is per conversation; the workbench is per workspace.
      entry = { service: factory({ dataRoot, comfyUrl: config.comfyUrl, workspaceRoot: config.workspaceRoot, ...(config.editEngine!==undefined?{editEngine:config.editEngine}:{}) }), dataRoot, studioRoot: config.dataRoot };
      services.set(id, entry);
    }
    return entry;
  };
}

export function registerTools(ctx, { sdk, service, getService, readGuide: guide, config, attachments }) {
  const baseAuthorization=ctx.sessionProjections?registerStudioAuthorization(ctx.sessionProjections):studioRequestAuthorization;
  const consentAuthorization=ctx.sessionProjections?registerStudioConsentAuthority(ctx.sessionProjections):()=>{throw Object.assign(Error('Native consent projection is required.'),{code:'STUDIO_CONSENT_HISTORY'});};
  const requestAuthorization=exec=>({...baseAuthorization(exec),...(ctx.sessionProjections?{consentEvidence:consentAuthorization(exec)}:{})});
  const assertGeneration=(entry,exec,input)=>{const authority=requestAuthorization(exec);return entry.studio.assertConsentGeneration?.({...input,message_id:authority.message_id??null},authority.consentEvidence);};
  const pending = new WeakMap();
  const localEntry={service,dataRoot:config.dataRoot}, workbenches=new Map();
  const serviceFor = exec => {
    const entry=getService?getService(exec):localEntry;entry.editEngine=config.editEngine??'native';
    // Pages, series and workbench documents are workspace artifacts: a new
    // conversation must reopen the same workbench. Only generation ledgers
    // (requests/runs/region pipelines) stay inside the per-session dataRoot.
    entry.studioRoot=config.dataRoot;
    if(!entry.workbench){if(!workbenches.has(entry.studioRoot))workbenches.set(entry.studioRoot,createWorkbenchStore({dataRoot:entry.studioRoot}));entry.workbench=workbenches.get(entry.studioRoot);}
    return entry;
  };
  async function artifact(args, exec) {
    exec.signal?.throwIfAborted();
    const entry = serviceFor(exec);
    // Inspection must not advance a multi-stage plan or submit its next child.
    const state = await entry.service.context({run_id:args.run_id},{signal:exec.signal});
    exec.signal?.throwIfAborted();
    const run=state.runs.find(r=>r.run_id===args.run_id) ?? state.runs[0];
    const receipt=args.variant==='preview'?run?.preview_artifact:run?.status==='succeeded'?run.artifact:null;
    if (!receipt) fail('MOSS_ARTIFACT_NOT_READY');
    const file = await realpath(receipt.path);
    if (!inside(await realpath(entry.dataRoot), file)) fail('MOSS_IMAGE_NOT_VISIBLE');
    const image = await imageBytes(file);
    if (image.sha256 !== receipt.sha256) fail('MOSS_ARTIFACT_INTEGRITY');
    return { ...image, file, run_id: args.run_id, width: receipt.width, height: receipt.height };
  }
  async function resolvedImage(reference,exec){
    const image=reference.startsWith('run:')?await artifact({run_id:reference.slice(4)},exec):await imageBytes(await referencePath(reference,exec,config,attachments));
    const ref=await attachments.saveImage({data:image.data,mediaType:image.mediaType});
    const dims=ref.originalDimensions??ref;return{...image,width:image.width??dims.width,height:image.height??dims.height};
  }
  const bridge=createWorkbenchBridge({getEntry:serviceFor,resolveReference:resolvedImage,readRunImage:artifact,requestAuthorization,consentAuthorization,
    previewImage:async(image,exec)=>{
      const ref=await attachments.saveImage({data:image.data,mediaType:image.mediaType});
      const size=Math.min(1,768/Math.max(ref.width,ref.height));
      const preview=await attachments.readImageRequest(ref,{width:Math.max(1,Math.round(ref.width*size)),height:Math.max(1,Math.round(ref.height*size)),maxBytes:180000},exec.signal);
      return{data:preview.data,mediaType:preview.mediaType};
    },
    inspectPlan:async(id,exec)=>{
      validate('art_run',{run_id:id});const entry=serviceFor(exec),root=await realpath(entry.dataRoot),dir=await realpath(path.join(root,'region-pipelines','runs',id));if(!inside(root,dir))fail('MOSS_IMAGE_NOT_VISIBLE');
      const file=await realpath(path.join(dir,'run.json'));if(!inside(dir,file))fail('MOSS_IMAGE_NOT_VISIBLE');
      const h=await open(file,'r');let record;try{const stat=await h.stat();if(!stat.isFile()||stat.size>8*1024*1024)fail('MOSS_INPUT');record=JSON.parse(await h.readFile('utf8'));}finally{await h.close();}
      if(record.run_id!==id||record.params?.mode!=='regions'||!Array.isArray(record.assets)||record.assets.length<2||record.assets.length>4)fail('MOSS_INPUT');
      const assets=[];for(const a of record.assets){const p=await realpath(a.path);if(!inside(dir,p))fail('MOSS_IMAGE_NOT_VISIBLE');const img=await imageBytes(p);if(img.sha256!==a.sha256)fail('MOSS_ARTIFACT_INTEGRITY');assets.push({...img,width:a.width,height:a.height});}
      return{params:record.params,assets};
    }});
  if(ctx.commands)registerWorkbenchCommand(ctx,{bridge});
  const definitions = [
    ['art_guide', 'Read this private drawing guide by topic; start with quick. No global skills.', args => guide(args)],
    ['art_context', 'Read session runs/catalog or editor documents. No cross-session scan.', async (args, exec) => {
      if(args.studio_consent)return bridge({action:'studioConsentState'},exec,'agent');
      if(args.studio_pages)return bridge({action:'studioState'},exec,'agent');
      if(args.studio_tasks)return bridge({action:'studioTaskState'},exec,'agent');
      if(args.studio_page_id!==undefined){if(args.studio_inspect||args.studio_status)return bridge({action:args.studio_inspect?'studioInspect':'studioTaskStatus',page_id:args.studio_page_id},exec,'agent');const page=await bridge({action:'studioGetPage',page_id:args.studio_page_id},exec,'agent');return{page:compactStudio(page)};}
      if(args.document_id!==undefined){const d=await bridge({action:'get',document_id:args.document_id},exec);const {proposals,...content}=d;return{document:content,proposals:proposals.map(({proposal_id,summary,status})=>({proposal_id,summary,status}))};}
      if(args.documents)return serviceFor(exec).workbench.list({});
      const {documents,...query}=args;return serviceFor(exec).service.context(query);
    }],
    ['art_generate', 'Generate an image/region plan, or edit workbench drafts. Stable request_id; never retry unknown.', async (args, exec) => {
      if(args.mode==='workbench'){const value=await bridge(args.workbench,exec,'agent');return args.workbench.action.startsWith('studio')?compactStudio(value):value;}
      const entry=serviceFor(exec);entry.studio??=createStudioStore({dataRoot:entry.dataRoot});await assertGeneration(entry,exec,{backend:args.backend??'moss',action:'raw'});
       const activeTasks=await bridge({action:'studioTaskState'},exec,'agent');if(activeTasks.editing_only)fail('STUDIO_TEXT_ONLY');
       if(activeTasks.tasks.some(row=>row.binding_active!==false))fail('STUDIO_TASK_BINDING_REQUIRED');
      const { references, ...input } = args, assets = [];
      for (const reference of references ?? []) {
        let image;
        if (reference.startsWith('run:')) {
          const selector = { run_id: reference.slice(4) };
          validate('art_run', selector);
          image = await artifact(selector, exec);
        } else image = await imageBytes(await referencePath(reference, exec, config, attachments));
        if (!['image/png','image/jpeg','image/webp'].includes(image.mediaType)) fail('MOSS_IMAGE_FORMAT');
        const decoded = await attachments.saveImage({ data: image.data, mediaType: image.mediaType });
        const dimensions = decoded.originalDimensions ?? decoded;
        if (!Number.isSafeInteger(dimensions.width) || !Number.isSafeInteger(dimensions.height) || dimensions.width < 1 || dimensions.height < 1) fail('MOSS_IMAGE_FORMAT');
        assets.push({ data: image.data, mediaType: image.mediaType, width: dimensions.width, height: dimensions.height });
      }
      exec.signal?.throwIfAborted();
      await assertGeneration(entry,exec,{backend:args.backend??'moss',action:'raw'});
      const result = await entry.service.generate(input, assets, {signal:exec.signal});
      return { ...result, next_action: result.status==='draft' ? 'Inspect art_view(run_id, variant="preview"); after checking layout, execute this plan under the existing user authorization. If user requested approval, present preview and wait. Do not art_run a draft.' : 'Call art_run once for this run_id; it waits internally. Then inspect, review and deliver in the same turn without a continuation request.' };
    }],
    ['art_run', 'Wait internally for the original run (up to 30 min), collect when ready. Call once, not rapid polling. Never resubmit.', async (args, exec) => {
      const entry=serviceFor(exec);entry.studio??=createStudioStore({dataRoot:entry.dataRoot});
      return waitForRun({run:async(input,options)=>{
        const binding=await entry.studio.boundRun(input);
        if(binding?.settlement?.kind==='human_abandoned')return{run_id:input.run_id,status:'abandoned',settlement:binding.settlement,next_action:'This unresolved result was explicitly abandoned by a human; do not advance, re-submit or refund it. Read the page for review and new-request requirements.'};
        if(binding?.mode==='regions'&&binding.control!=='auto')return{run_id:input.run_id,status:'paused',next_action:'Human control prevents starting another regional stage; keep the original run and wait for explicit resume.'};
        const result=await entry.service.run(input,{...options,beforeStage:async(stage={})=>{
          // Every regional child boundary is guarded, including legacy/raw runs
          // without a Studio plan. Observation and draft reads never call this.
          const consentBinding=await entry.studio.boundRun(input);
          await assertGeneration(entry,exec,{action:'region_stage',page_id:consentBinding?.page_id??null,task_id:consentBinding?.task_id??null,...(stage.backend?{backend:stage.backend}:{})});
          const state=await entry.studio.taskState({});
          if(state.editing_only)fail('STUDIO_TEXT_ONLY');
          const latest=await entry.studio.boundRun(input);
          if((binding?.mode==='regions'||latest?.mode==='regions')&&latest?.control!=='auto')fail('STUDIO_HUMAN_CONTROL');
        }});
        if(binding){const plan=await entry.studio.finishPlan({plan_id:binding.plan_id,run_id:input.run_id,status:['succeeded','failed','unknown'].includes(result.status)?result.status:'running'});if(plan.settlement?.kind==='human_abandoned')return{run_id:input.run_id,status:'abandoned',settlement:plan.settlement};}
        return result;
      }},args,{signal:exec.signal});
    }],
    ['art_review', 'Save AI pixel observations/issues and one next change; never user score or acceptance.', async (args, exec) => {const entry=serviceFor(exec),result=await entry.service.review(args);entry.studio??=createStudioStore({dataRoot:entry.dataRoot});const binding=await entry.studio.boundRun({run_id:args.run_id});if(binding?.status==='succeeded')await entry.studio.notePlan({plan_id:binding.plan_id,stage:'reviewed'});return result;}],
    ['art_view', 'Attach real pixels from a run or user-provided visible reference. No arbitrary file reads.', async (args, exec) => {
      if(args.studio_page_id){const preview=await bridge({action:'studioPreview',page_id:args.studio_page_id,...(args.expected_revision===undefined?{}:{expected_revision:args.expected_revision})},exec,'agent');const {data_url,...value}=preview;const ref=await attachments.saveImage({data:Buffer.from(data_url.split(',')[1],'base64'),mediaType:'image/png'});pending.set(exec,[{type:'text',text:JSON.stringify(value)},{type:'image',attachment:ref}]);return value;}
      const image = args.run_id ? await artifact(args, exec) : await imageBytes(await referencePath(args.path, exec, config, attachments));
      const ref = await attachments.saveImage({ data: image.data, mediaType: image.mediaType });
      const value = { ...(image.run_id ? { run_id: image.run_id } : {}), sha256: image.sha256, width: image.width ?? ref.width, height: image.height ?? ref.height, visual_review: 'not_yet_performed' };
      pending.set(exec, [{ type: 'text', text: JSON.stringify(value) }, { type: 'image', attachment: ref }]);
      return value;
    }],
    ['art_deliver', 'Deliver exact original generated bytes with a normalized image preview.', async (args, exec) => {
      const image = await artifact(args, exec);
      const entry=serviceFor(exec);entry.studio??=createStudioStore({dataRoot:entry.dataRoot});const binding=await entry.studio.boundRun({run_id:args.run_id});
      const preview = await attachments.saveImage({ data: image.data, mediaType: image.mediaType });
      const file = await attachments.saveFile({ data: image.data, name: `moss-${args.run_id}.png` });
      const linkPath = image.file.replaceAll('\\', '/');
      const target = linkPath.split('/').map((part, i) => i === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join('/');
      const value = { run_id: args.run_id, sha256: image.sha256, width: image.width, height: image.height,
        path: linkPath, markdown_link: `[在侧边栏查看原图](<${target}>)`,
        next_action: 'Include markdown_link verbatim in your final reply alongside a short visual review. The user clicks it to open the official sidebar.' };
      if(binding){await entry.studio.finishPlan({plan_id:binding.plan_id,run_id:args.run_id,status:'succeeded'});await entry.studio.notePlan({plan_id:binding.plan_id,stage:'delivered'},await requestAuthorization(exec));}
      pending.set(exec, [{ type: 'text', text: JSON.stringify(value) }, { type: 'file', attachment: file }, { type: 'image', attachment: preview }]);
      return value;
    }],
  ];
  for (const [name, description, execute] of definitions) ctx.tools.register(sdk.tools.defineTool({
    name, description, parameters: schemas[name],
    ...(name === 'art_run' ? { timeoutMs: WAIT_TOOL_TIMEOUT_MS } : {}),
    output: { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (args, exec) => {
      exec.signal?.throwIfAborted();
      validate(name, args);
      try { return losslessOutput(await execute(args, exec)); }
      catch (error) { exec.signal?.throwIfAborted(); if (error?.name === 'AbortError') throw error; throw new Error(safeError(error)); }
    },
    projectContent: (exec, result) => result.isError ? undefined : pending.get(exec),
  }));
}

export async function apply(ctx, input) {
  const { createDrawingService } = await import('./dispatcher.mjs');
  const config = resolveConfig(input), sdk = loadSdk();
  registerTools(ctx, { sdk, getService: sessionServices(config, createDrawingService), readGuide, config, attachments: ctx.attachments });
  installScopePolicy(ctx, { sdk });
}
