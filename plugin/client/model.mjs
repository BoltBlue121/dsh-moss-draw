import { cameraDescription, bodyFromBox } from '../src/workbench-camera.mjs';
import { parseStudioRestoreAckError } from '../src/studio-restore-contract.mjs';
import { readStudioSessionImage } from './studio-session-image.mjs';

const ACTION_FIELDS = {
 studioConsentHandoff:['consent_id','page_id','expected_revision','nonce','client_id','lease_token'],
 studioAnalysisStatus:['analysis_id','page_id','request_key','analysis_detail'],
 studioSetEditPolicy:['page_id','expected_revision','policy','editing_only','lease_token'],studioConfirmDescriptions:['page_id','expected_revision','lease_token'],studioGetSeriesProfile:['series_id'],studioUpdateSeriesProfile:['series_id','expected_revision','style','cast'],studioApplySeriesProfile:['page_id','expected_revision','profile_revision','bindings','caption_cast_ids','lease_token'],
 studioStart:['page_id','expected_revision','intent','mode','max_runs'],studioAgentUpdate:['page_id','expected_revision','doc','title'],studioOpen:['page_id'],studioTaskState:[],studioTaskStatus:['page_id'],studioInspect:['page_id','expected_revision'],studioPreview:['page_id','expected_revision'],studioTakeover:['page_id','expected_revision','client_id','force'],studioPause:['page_id','expected_revision','lease_token'],studioResume:['page_id','expected_revision','lease_token','max_runs','preferences','editing_only'],studioAckOpen:['page_id','request_id','client_id','surface'],
 studioArchiveList:['query','category','offset','limit'],studioArchiveAdd:['title','category','doc','prompt'],studioArchiveGet:['archive_id'],studioArchiveUpdate:['archive_id','expected_revision','title','category'],studioArchiveDelete:['archive_id','expected_revision'],
 studioState: ['series_id','offset','limit'],studioRenameSeries:['series_id','expected_title','title'],studioDeletePage:['page_id','expected_revision','lease_token'],studioDeleteSeries:['series_id','expected_title','expected_pages'], studioCreateSeries:['title'], studioCreatePage:['series_id','title','doc'], studioGetPage:['page_id'],
 studioUpdatePage:['page_id','expected_revision','title','doc','lease_token','shape_removals'], studioPropose:['page_id','expected_revision','doc','summary'],
 studioResolve:['page_id','expected_revision','proposal_id','accept','reject','lease_token'],studioHistory:['page_id','revision'],studioRestore:['page_id','expected_revision','revision','lease_token','acknowledge'],studioCompile:['doc'],
 state: [], list: ['limit'], create: ['title','canvas','references','regions','prompt','qwen_full_prompt','camera'],
 get: ['document_id'], update: ['document_id','expected_revision','patch'], propose: ['document_id','expected_revision','patch','summary'],
 resolve: ['document_id','expected_revision','proposal_id','accept','reject'], history: ['document_id','limit'],
 restore: ['document_id','expected_revision','revision'], cameraPreview: ['document_id','camera'],
 importPlan: ['run_id','title'], materialize: ['document_id','expected_revision'], asset: ['document_id','reference_index','run_id','variant'],
};
const clone = value => structuredClone(value);
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const problem = code => { throw new Error(code); };

async function imageBase64(blob){
 if(typeof FileReader!=='undefined')return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>{const data=reader.result;if(typeof data!=='string'||!data.includes(','))return reject(Error('WORKBENCH_IMAGE_ENCODING'));resolve(data.slice(data.indexOf(',')+1));};reader.onerror=()=>reject(reader.error??Error('WORKBENCH_IMAGE_ENCODING'));reader.readAsDataURL(blob);});
 const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let start=0;start<bytes.length;start+=16384)binary+=String.fromCharCode(...bytes.subarray(start,start+16384));return btoa(binary);
}

export function createBridge({remote,sessionId,session,query}) {
 if(typeof sessionId!=='string'||!sessionId)problem('WORKBENCH_SESSION');
 return {
  latestSessionImage(){return readStudioSessionImage(session,sessionId);},
  async query(action,fields={},signal){
   if(!['studioTaskState','studioTaskStatus','studioAnalysisStatus'].includes(action))problem('WORKBENCH_QUERY_ACTION');
   if(typeof query!=='function')problem('WORKBENCH_QUERY_UNAVAILABLE');
   if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.keys(fields).some(k=>!ACTION_FIELDS[action].includes(k)))problem('WORKBENCH_FIELD');
   signal?.throwIfAborted();const result=await query(sessionId,{action,...fields},signal);
   if(result?.ok!==true)throw Error(result?.error?.message??'WORKBENCH_QUERY_UNAVAILABLE');return result.value;
  },
  async request(action, fields={}, signal) {
   const allowed=ACTION_FIELDS[action]; if(!allowed)problem('WORKBENCH_ACTION');
   if(!fields||typeof fields!=='object'||Array.isArray(fields)||Object.keys(fields).some(key=>!allowed.includes(key)))problem('WORKBENCH_FIELD');
   const line='/art-workbench '+JSON.stringify({action,...fields});if(line.length>(action.startsWith('studioArchive')?1572864:action.startsWith('studio')?786432:65536))problem('WORKBENCH_REQUEST_SIZE');
   signal?.throwIfAborted();
   const response=await remote.commands.execute(sessionId,line,[],signal);
   if(response?.ok===false)throw Error(`${response.error?.code??'WORKBENCH_REMOTE'}: ${response.error?.message??'Command transport failed'}`);
   // Browser Remote methods return a Result envelope; same-process bridges may return the value directly.
   const reply=response?.ok===true?response.value:response;
   if(action==='studioState'&&reply?.result?.kind==='error'&&reply.result.text==='INVALID_INPUT')throw Error('WORKBENCH_HOST_RELOAD_REQUIRED: 当前 Host 尚未加载提示词编辑接口；请在方便时重启 DSH，再打开工作台。旧区域执行仍可用。');
   if(reply?.result?.kind!=='success'){
    // Only the restore acknowledgement is structured; the strict wire check keeps
    // every other error a plain code and nothing is retried automatically.
    if(action==='studioRestore'){const ack=parseStudioRestoreAckError(reply?.result?.text);if(ack)throw Object.assign(Error(ack.message),{code:ack.code,diff:ack.diff});}
    throw Error(reply?.result?.text??'WORKBENCH_UNAVAILABLE: select the AI drawing preset');
   }
   if(typeof reply.result.text!=='string'||reply.result.text.length>48*1024*1024)problem('WORKBENCH_RESPONSE');
   let value;try{value=JSON.parse(reply.result.text);}catch{problem('WORKBENCH_RESPONSE');}
   if(action==='asset'&&(!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(value?.data_url??'')||!Number.isSafeInteger(value.width)||!Number.isSafeInteger(value.height)||value.width<1||value.height<1))problem('WORKBENCH_ASSET');
   return value;
  },
  async cancel() {
   if(!session?.cancel)problem('WORKBENCH_SESSION');
   const response=await session.cancel();
   if(!response?.ok)throw Error(response?.error?.message??'WORKBENCH_CANCEL_REJECTED');
   return response;
  },
  async promptReference(text,reference,mode='queue',signal){
    if(typeof text!=='string'||!text.trim()||text.length>3000||!['queue','steer'].includes(mode))problem('WORKBENCH_PROMPT');
    if(!(reference?.blob instanceof Blob)||reference.blob.type!=='image/png'||reference.blob.size<1||reference.blob.size>32*1024*1024)problem('WORKBENCH_REFERENCE_IMAGE');
    if(!session?.prompt)problem('WORKBENCH_SESSION');signal?.throwIfAborted();const data=await imageBase64(reference.blob);signal?.throwIfAborted();
    // Public ClientSession.prompt image form; Host admission creates the native user attachment.
    const response=await session.prompt([{type:'image',data,mediaType:'image/png',name:String(reference.name||'reference.png').replace(/[\u0000-\u001f]/g,'_').slice(0,200)},{type:'text',text}],mode,signal);
    if(!response?.ok)throw Error(response?.error?.message??'WORKBENCH_IMAGE_PROMPT_REJECTED');return response;
   },
   async prompt(text,mode='queue',signal,requestId) {
   if(typeof text!=='string'||!text.trim()||text.length>3000||!['queue','steer'].includes(mode))problem('WORKBENCH_PROMPT');
   if(!session?.prompt)problem('WORKBENCH_SESSION');
   const response=await session.prompt([{type:'text',text}],mode,signal,...(requestId===undefined?[]:[requestId]));
   if(!response?.ok)throw Error(response?.error?.message??'WORKBENCH_PROMPT_REJECTED');
   return response;
  },
 };
}

export function canvasPoint(event,rect,canvas) {
 if(!(rect.width>0&&rect.height>0))problem('WORKBENCH_BOUNDS');
 return [(event.clientX-rect.left)*canvas.width/rect.width,(event.clientY-rect.top)*canvas.height/rect.height];
}
function validBox(box,canvas){if(box.length!==4||box.some(x=>!Number.isFinite(x))||box[0]<0||box[1]<0||box[2]>canvas.width||box[3]>canvas.height||box[0]>=box[2]||box[1]>=box[3])problem('WORKBENCH_BOUNDS');return box;}
export function moveRegion(region,dx,dy,canvas) {
 if(region.locked)return clone(region);
 const [l,t,r,b]=region.box;const result={...clone(region),box:validBox([l+Math.round(dx),t+Math.round(dy),r+Math.round(dx),b+Math.round(dy)],canvas)};
 // 2D edits invalidate a derived body; it is recreated from the new box.
 delete result.body;return result;
}
export function resizeRegion(region,dx,dy,canvas) {
 if(region.locked)return clone(region);
 const [l,t,r,b]=region.box;const result={...clone(region),box:validBox([l,t,r+Math.round(dx),b+Math.round(dy)],canvas)};delete result.body;return result;
}
export function nudgeRegions(regions,selected,key,large,canvas) {
 const step=large?10:1,deltas={ArrowLeft:[-step,0],ArrowRight:[step,0],ArrowUp:[0,-step],ArrowDown:[0,step]};
 const delta=deltas[key];if(!delta)return clone(regions);
 return regions.map(region=>selected.includes(region.id)?moveRegion(region,...delta,canvas):clone(region));
}
export function previewRegions(regions,bodies) {
 return regions.map(region=>{const result=clone(region),body=bodies[region.id]??region.body;if(body===undefined)delete result.body;else result.body=clone(body);return result;});
}
export function projectionPatch(document,projection,camera) {
 if(!projection?.valid)problem('WORKBENCH_PROJECTION');
 const regions=document.regions.map(region=>{
  if(region.locked)return clone(region);
  const projected=projection.regions.find(item=>item.id===region.id);
  if(!projected?.visible||projected.clipped||!projected.box)problem('WORKBENCH_PROJECTION');
  const exact=projected.box.map(value=>Math.abs(value-Math.round(value))<1e-8?Math.round(value):value);
  validBox(exact,document.canvas);
  return {...clone(region),body:clone(region.body??bodyFromBox(region.box,document.canvas)),box:validBox(exact.map(value=>Math.round(value)||0),document.canvas)};
 });
 return {camera:clone(camera),regions,prompt:`${document.prompt}\n${cameraDescription(camera)}`.trim()};
}
export function proposalChanges(proposal) {
 const base=proposal.base??{},next=proposal.proposed??{...base,...proposal.patch},changes=[];
 for(const key of ['title','prompt','camera','qwen_full_prompt'])if(!same(base[key],next[key]))changes.push({key,label:key,before:base[key],after:next[key]});
 if(!same(base.regions,next.regions)) {
  const before=base.regions??[],after=next.regions??[],ids=[...new Set([...before,...after].map(r=>r.id))];
  for(const id of ids){const a=before.find(r=>r.id===id),b=after.find(r=>r.id===id);if(!same(a,b))changes.push({key:`region:${id}`,label:`区域 ${id}`,before:a,after:b});}
  if(same([...before.map(r=>r.id)].sort(),[...after.map(r=>r.id)].sort())&&!same(before.map(r=>r.id),after.map(r=>r.id)))changes.push({key:'regions',label:'区域顺序',before:before.map(r=>r.id),after:after.map(r=>r.id)});
 }
 return changes;
}

export function createWorkbenchModel(bridge) {
 let state={documents:[],runs:[],document:null,draft:null,selected:[],dirty:false,busy:false,error:null,conflict:false,history:[],lastPlan:null};
 const listeners=new Set();let active=true;
 const emit=patch=>{if(!active)return;state={...state,...patch};for(const listener of listeners)listener();};
 const adopt=document=>{
  const switched=state.document?.document_id!==document.document_id;
  emit({document:clone(document),draft:clone(document),dirty:false,error:null,conflict:false,history:[],lastPlan:null,selected:switched?[]:state.selected.filter(id=>document.regions.some(r=>r.id===id))});
 };
 const adoptMutation=(document,submitted)=>{
  const later={};for(const key of ['title','prompt','camera','qwen_full_prompt','regions'])if(!same(submitted[key],state.draft[key]))later[key]=clone(state.draft[key]);
  adopt(document);
  if(Object.keys(later).length)emit({draft:{...state.draft,...later},dirty:true,conflict:true,error:'WORKBENCH_LOCAL_EDITS: response applied; newer local edits were preserved for review, not saved.'});
 };
 const planIsCurrent=()=>state.lastPlan&&!state.dirty&&state.document?.document_id===state.lastPlan.document_id&&state.document?.revision===state.lastPlan.revision;
 async function operation(work){if(state.busy)problem('WORKBENCH_BUSY');emit({busy:true,error:null});try{return await work();}catch(e){emit({error:String(e.message),conflict:/WORKBENCH_CONFLICT/.test(e.message)});throw e;}finally{emit({busy:false});}}
 const requireDocument=()=>{if(!state.document)problem('WORKBENCH_DOCUMENT_REQUIRED');return state.document;};
 return {
  getSnapshot:()=>state,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},dispose(){active=false;listeners.clear();},
  async refresh(signal){return operation(async()=>{const value=await bridge.request('state',{},signal);emit({documents:value.documents??[],runs:value.runs??[]});return value;});},
  async open(document_id,signal){return operation(async()=>{const value=await bridge.request('get',{document_id},signal);adopt(value);return value;});},
  async create(input,signal){return operation(async()=>{const value=await bridge.request('create',input,signal);adopt(value);return value;});},
  patch(patch){if(!state.draft)problem('WORKBENCH_DOCUMENT_REQUIRED');emit({draft:{...state.draft,...clone(patch)},dirty:true,lastPlan:null});},
  select(id,append=false){emit({selected:append?[...new Set([...state.selected,id])]:[id]});},
  async save(signal){const document=requireDocument(),submitted=clone(state.draft),patch={};for(const key of ['title','prompt','camera','qwen_full_prompt','regions'])if(!same(document[key],submitted[key]))patch[key]=clone(submitted[key]);return operation(async()=>{const value=await bridge.request('update',{document_id:document.document_id,expected_revision:document.revision,patch},signal);adoptMutation(value,submitted);return value;});},
  async propose(patch,summary,signal){const document=requireDocument(),submitted=clone(state.draft);if(state.dirty)problem('WORKBENCH_SAVE_FIRST');return operation(async()=>{const value=await bridge.request('propose',{document_id:document.document_id,expected_revision:document.revision,patch,summary},signal);adoptMutation(value,submitted);return value;});},
  async resolve(proposal_id,accept,reject=false,signal){const document=requireDocument(),submitted=clone(state.draft);if(state.dirty)problem('WORKBENCH_SAVE_FIRST');return operation(async()=>{const value=await bridge.request('resolve',{document_id:document.document_id,expected_revision:document.revision,proposal_id,...reject?{reject:true,accept:[]}:{accept}},signal);adoptMutation(value,submitted);return value;});},
  async history(signal){const document=requireDocument();return operation(async()=>{const value=await bridge.request('history',{document_id:document.document_id,limit:30},signal);emit({history:value.revisions??[]});return value;});},
  async restore(revision,signal){const document=requireDocument(),submitted=clone(state.draft);if(state.dirty)problem('WORKBENCH_SAVE_FIRST');return operation(async()=>{const value=await bridge.request('restore',{document_id:document.document_id,expected_revision:document.revision,revision},signal);adoptMutation(value,submitted);return value;});},
  async importPlan(run_id,signal){return operation(async()=>{const value=await bridge.request('importPlan',{run_id},signal);adopt(value);return value;});},
  async materialize(signal){const document=requireDocument();if(state.dirty)problem('WORKBENCH_SAVE_FIRST');emit({lastPlan:null});return operation(async()=>{const value=await bridge.request('materialize',{document_id:document.document_id,expected_revision:document.revision},signal);if(!state.dirty&&state.document?.document_id===document.document_id&&state.document?.revision===document.revision)emit({lastPlan:{document_id:document.document_id,revision:document.revision,run:clone(value)}});return value;});},
  canAuthorizePlan:()=>!!planIsCurrent()&&!state.busy,
  async authorizePlan(signal){if(!planIsCurrent()||state.busy)problem('WORKBENCH_PLAN_STALE');const binding=clone(state.lastPlan);return bridge.prompt(`AI画画工作台 document_id=${binding.document_id} revision=${binding.revision}\n我授权执行区域计划 ${binding.run.run_id}。先看preview，自主确认布局后execute并等待完成、审图交付。`,'queue',signal);},
  asset:(fields,signal)=>bridge.request('asset',fields,signal),
  cancel:()=>bridge.cancel(),
  async sendToAgent(request,mode='queue',signal){const document=state.document;const text=`AI画画工作台${document?` document_id=${document.document_id} revision=${document.revision} selection=${state.selected.join(',')||'none'}`:'（尚无文档，请按需求创建）'}\n${String(request).trim()}\n请通过art_context按需读取共享文档；保存或提案不等于生成授权。`;return bridge.prompt(text,mode,signal);},
 };
}
