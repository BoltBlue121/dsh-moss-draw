import path from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createStore, atomicWrite, hash } from './store.mjs';
import { fault, strictObject, text, number, strings, runId, STYLES, parseLoras } from './catalog.mjs';
import { validateAssets, extension } from './modes.mjs';
import { decodePng, encodePng, regionCrop, regionComposite, regionOverlay } from './region-pixels.mjs';

const now = () => new Date().toISOString();
const bad = message => { throw fault('INVALID_INPUT', message); };
const corrupt = () => { throw fault('STORE_CORRUPT', 'Region asset or record changed; ask maintenance to inspect.'); };
const seed = () => randomBytes(6).readUIntBE(0, 6);
const inside = (root, file) => { const rel = path.relative(root, file); return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
const assetOnly = ({data,mediaType,width,height}) => ({data,mediaType,width,height});
const pngAsset = data => { const p = decodePng(data); return {data,mediaType:'image/png',width:p.width,height:p.height}; };
const editPrompt = (prompt, region, engine='legacy') => engine==='native'
  ? `Edit the first image, which is a crop of a larger scene. The second image is only the design reference for the replacement subject. ${region.prompt}\nKeep the first image framing, background and floor unless explicitly changed above. Output only the edited first image, not a reference comparison sheet.`
  : `${prompt}\nReference 1 is the scene crop. Reference 2 is the assigned character, not the background. ${region.prompt}`;

export function normalizeRegions(input, assets) {
  strictObject(input, ['mode','action','request_id','prompt','brief','checks','regions','qwen_full_prompt']);
  if (input.mode !== 'regions' || !['draft',undefined].includes(input.action)) bad('Use regions draft or execute.');
  const request_id = text(input.request_id,'request_id',128,true);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(request_id)) bad('Invalid request_id.');
  if (assets.length < 2 || assets[0].mediaType !== 'image/png') bad('Regions require a PNG canvas followed by one to three character references.');
  const {width,height} = decodePng(assets[0].data);
  const prompt = text(input.prompt,'plan prompt',12000,true);
  if (assets.slice(1).some(a => a.width*a.height > 2100000)) bad('Character reference exceeds MOSS 2.1MP; supply a smaller reference.');
  if (!Array.isArray(input.regions) || input.regions.length < 1 || input.regions.length > 4) bad('Use one to four regions.');
  const ids = new Set();
  const regions = input.regions.map(r => {
    strictObject(r,['id','box','reference_index','prompt','style','lora_strength','loras','seed','context_px','feather_px','qwen_prompt','steps','cfg']);
    const id = text(r.id,'region id',40,true);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) bad('Region IDs must be unique identifiers.'); ids.add(id);
    if (!Array.isArray(r.box) || r.box.length !== 4 || r.box.some(v=>!Number.isSafeInteger(v))) bad('Region box must be four integer pixel coordinates.');
    const [l,t,rr,b] = r.box;
    if (l<0 || t<0 || rr>width || b>height || l>=rr || t>=b) bad('Region box must be inside the canvas.');
    const style = r.style ?? 'none'; if (typeof style!=='string' || !Object.hasOwn(STYLES,style)) bad('Unknown region style.');
    const lora_strength = number(r.lora_strength ?? (style==='none'?0:1),'style strength',0,2);
    if (style==='none' && lora_strength!==0) bad('Style none requires zero strength.');
    const loras = parseLoras(r.loras);
    // The actual child prompt, not its fragments, must fit before the draft is
    // claimed. Otherwise an approved plan fails only after partial execution.
    text(editPrompt(prompt,{prompt:text(r.prompt,'region prompt',10000,true)}),'combined edit prompt',12000,true);
    return {id,box:[...r.box],reference_index:number(r.reference_index,'reference index',1,assets.length-1,true),
      prompt:text(r.prompt,'region prompt',10000,true),style,lora_strength,...(loras.length?{loras}:{}),seed:r.seed===undefined?null:number(r.seed,'seed',0,Number.MAX_SAFE_INTEGER,true),
      context_px:number(r.context_px??64,'context pixels',0,512,true),feather_px:number(r.feather_px??8,'feather pixels',0,128,true),
      steps:number(r.steps??30,'edit steps',1,100,true),cfg:number(r.cfg??4,'edit cfg',0,20),qwen_prompt:text(r.qwen_prompt??'','Qwen region prompt',10000)};
  });
  const qwen_full_prompt = text(input.qwen_full_prompt??'','full Qwen prompt',10000);
  if(qwen_full_prompt && (width<256 || height<256 || width%32 || height%32 || width>4096 || height>4096)) bad('Full Qwen requires canvas dimensions >=256 and divisible by 32; no silent canvas resize.');
  return {request_id,backend:'moss',mode:'regions',width,height,prompt,negative:'',
    brief:text(input.brief??'','brief',1000),checks:strings(input.checks??[],'checks',12,160),parent_run_id:null,regions,qwen_full_prompt};
}
function inferenceSize(width,height) {
  const scale = Math.min(1,1536/width,1536/height,Math.sqrt(1048576/(width*height)));
  return {width:Math.max(256,Math.floor(width*scale/32)*32),height:Math.max(256,Math.floor(height*scale/32)*32)};
}
function resizeReference(data, dims) {
  const original=decodePng(data); if(original.width===dims.width && original.height===dims.height)return data;
  const blank=encodePng({...dims,pixels:Buffer.alloc(dims.width*dims.height*4)}),box=[0,0,dims.width,dims.height];
  return regionComposite(blank,data,{box,context_px:0,feather_px:0},box).data;
}

export function createRegionService({dataRoot,childService,editEngine='legacy'}) {
  if(!['legacy','native'].includes(editEngine))throw fault('INVALID_CONFIG','Unknown region edit engine.');
  if (!childService || typeof childService.generate!=='function' || typeof childService.run!=='function') throw fault('INVALID_CONFIG','Region service requires a child drawing service.');
  const store=createStore(path.join(dataRoot,'region-pipelines'));
  // SQLite owns the OS lock across awaits; process death releases it without an
  // expiring lease or guessing whether another Host is still alive. No run data
  // lives in this database. JSON + child request claims remain authoritative.
  async function locked(operation,signal) {
    return store.locked(async()=>{
      signal?.throwIfAborted(); await mkdir(store.root,{recursive:true});
      signal?.throwIfAborted();
      const db=new DatabaseSync(path.join(store.root,'scheduler.sqlite'));
      db.exec('PRAGMA busy_timeout=0'); let acquired=false;
      try {
        const deadline=Date.now()+25000;
        while(!acquired) {
          signal?.throwIfAborted();
          try {db.exec('BEGIN IMMEDIATE');acquired=true;}
          catch(e) {if(!/locked|busy/i.test(e.message))throw e;if(Date.now()>=deadline)throw fault('PIPELINE_BUSY','Another Host is advancing this pipeline; query the same run again.');await delay(50,undefined,{signal});}
        }
        signal?.throwIfAborted();
        return await operation();
      } finally {if(acquired)db.exec('ROLLBACK');db.close();}
    },signal);
  }
  async function write(record,signal) {signal?.throwIfAborted();record.updated_at=now();await store.write(record);return compact(record);}
  function compact(r,full=false) {
    const regions=r.params.regions;
    return {run_id:r.run_id,status:r.status,created_at:r.created_at,updated_at:r.updated_at,
      params:{backend:'moss',mode:'regions',edit_engine:r.edit_engine??'legacy',width:r.params.width,height:r.params.height,...(full?{...r.params}:{regions:regions.map(({id,box,reference_index,style,lora_strength,loras})=>({id,box,reference_index,style,lora_strength,...(loras?.length?{loras}:{})}))})},
      context:{brief:r.params.brief,prompt_excerpt:r.params.prompt.slice(0,500),checks:r.params.checks},
      progress:{region_index:r.cursor,total_regions:regions.length,phase:r.phase,child_run_id:r.pending?.child_run_id??null,completed_calls:r.history?.length??0,
        total_calls:regions.length+regions.filter(x=>x.qwen_prompt).length+(r.params.qwen_full_prompt?1:0)},
      preview_artifact:r.preview_artifact,...(r.artifact?{artifact:r.artifact}:{}),...(r.protection?{protection:r.protection}:{}),...(r.error?{error:r.error}:{}),
      next_action:r.status==='draft'?'Inspect preview using art_view variant preview; execute this plan only under user authorization. Do not wait on a draft.':r.status==='unknown'?'Query this same run; never resubmit children or change request_id.':undefined};
  }
  async function put(id,name,data,signal) {
    signal?.throwIfAborted();
    const file=path.join(store.directory(id),name);await atomicWrite(file,data);const img=decodePng(data);
    return {path:file,sha256:hash(data),width:img.width,height:img.height};
  }
  async function checked(receipt,root=dataRoot) {
    if(!receipt || typeof receipt.path!=='string' || !/^[0-9a-f]{64}$/.test(receipt.sha256??''))corrupt();
    let handle;
    try {
      const resolved=await realpath(receipt.path),allowed=await realpath(root),session=await realpath(dataRoot);
      // A symlinked child directory must not redefine the permission boundary.
      if(!inside(session,allowed)||!inside(allowed,resolved)||resolved===allowed)corrupt();
      handle=await open(resolved,'r');const info=await handle.stat();
      if(!info.isFile()||info.size<12||info.size>32*1024*1024)corrupt();
      const bytes=await handle.readFile();if(bytes.length!==info.size||hash(bytes)!==receipt.sha256)corrupt();return bytes;
    } catch {corrupt();} finally {await handle?.close();}
  }
  function sameAsset(a,b) {
    return a&&b&&['path','sha256','width','height'].every(k=>a[k]===b[k]);
  }
  function pendingRoot(r,p,index) {
    if(r.phase==='edit') {
      const expected=index===0?path.join(store.directory(r.run_id),`crop-${r.cursor}.png`):r.assets[r.params.regions[r.cursor].reference_index]?.path;
      if(p.assets.length!==2||p.assets[index]?.path!==expected||(index===1&&!sameAsset(p.assets[index],r.assets[r.params.regions[r.cursor].reference_index])))corrupt();
      return store.directory(r.run_id);
    }
    if(r.phase==='qwen') {
      if(p.assets.length!==1||!sameAsset(p.assets[0],r.stage_artifact))corrupt();
      return path.join(dataRoot,'runs',runId(r.stage_child_id));
    }
    if(r.phase==='full') {
      if(p.assets.length!==1||!sameAsset(p.assets[0],r.canvas))corrupt();
      return store.directory(r.run_id);
    }
    corrupt();
  }
  async function inputAssets(r) {
    const result=[];
    for(const a of r.assets)result.push({data:await checked(a,store.directory(r.run_id)),mediaType:a.mediaType,width:a.width,height:a.height});
    return result;
  }
  async function advance(r,signal,beforeStage) {
    signal?.throwIfAborted();
    if(['draft','succeeded','failed'].includes(r.status))return compact(r);
    const assets=await inputAssets(r); // Verify all frozen references before any inference.
    const canvasBytes=await checked(r.canvas,store.directory(r.run_id));
    if(r.cursor===r.params.regions.length && r.phase!=='full') {
      if(r.params.qwen_full_prompt) {r.phase='full';r.pending=null;}
      else {
        const base=decodePng(assets[0].data),final=decodePng(canvasBytes);let outside=0;
        for(let y=0;y<base.height;y++)for(let x=0;x<base.width;x++) {
          if(r.params.regions.some(v=>x>=v.box[0]&&x<v.box[2]&&y>=v.box[1]&&y<v.box[3]))continue;
          const i=(y*base.width+x)*4;if(!base.pixels.subarray(i,i+4).equals(final.pixels.subarray(i,i+4)))outside++;
        }
        if(outside)corrupt();
        r.protection={scope:'outside_region_union',outside_changed_pixels:outside};r.artifact=r.canvas;r.status='succeeded';return write(r,signal);
      }
    }
    const region=r.params.regions[r.cursor];
    if(r.phase==='composite') {
      const patch=await checked(r.stage_artifact,path.join(dataRoot,'runs',r.stage_child_id));
      const result=regionComposite(canvasBytes,patch,region,r.crop_box);
      r.canvas=await put(r.run_id,`canvas-${r.cursor+1}.png`,result.data,signal);
      await put(r.run_id,`mask-${r.cursor+1}.png`,result.mask,signal);
      r.cursor++;r.phase='edit';r.pending=null;r.stage_artifact=null;r.stage_child_id=null;r.status='running';delete r.error;
      return write(r,signal);
    }
    if(!r.pending) {
      let stageAssets,input;
      if(r.phase==='edit') {
        const crop=regionCrop(canvasBytes,region);r.crop_box=crop.crop_box;
        const dims=inferenceSize(crop.width,crop.height),cropData=resizeReference(crop.data,dims);
        const cropReceipt=await put(r.run_id,`crop-${r.cursor}.png`,cropData,signal);
        stageAssets=[{...cropReceipt,mediaType:'image/png'},r.assets[region.reference_index]];
        input={backend:'moss',mode:'edit',model:'sft',prompt:editPrompt(r.params.prompt,region,r.edit_engine??'legacy'),style:region.style,lora_strength:region.lora_strength,...(region.loras?.length?{loras:region.loras}:{}),seed:region.seed,steps:region.steps,cfg:region.cfg,...dims};
      } else if(r.phase==='qwen') {
        stageAssets=[{...r.stage_artifact,mediaType:'image/png'}];
        input={backend:'qwen',mode:'edit',prompt:region.qwen_prompt,seed:region.seed,width:r.stage_artifact.width,height:r.stage_artifact.height};
      } else if(r.phase==='full') {
        stageAssets=[{...r.canvas,mediaType:'image/png'}];
        input={backend:'qwen',mode:'edit',prompt:r.params.qwen_full_prompt,seed:r.params.regions[0].seed,width:r.params.width,height:r.params.height};
      } else corrupt();
      input.request_id=`${r.run_id}:r${r.cursor}:${r.phase}`;
      r.pending={input,assets:stageAssets,child_run_id:null};r.status='running';delete r.error;signal?.throwIfAborted();await store.write(r);
    }
    const p=r.pending;signal?.throwIfAborted();let child;
    if(!p.child_run_id) {
      const stageAssets=[];for(let i=0;i<p.assets.length;i++){const a=p.assets[i];stageAssets.push({...assetOnly(a),data:await checked(a,pendingRoot(r,p,i))});}
      signal?.throwIfAborted();
      // If interrupted before this ID is saved, generate with the SAME request
      // hash recovers the child's permanent claim, never a second remote POST.
      await beforeStage?.({run_id:r.run_id,request_id:p.input.request_id,backend:p.input.backend??'moss'});
      child=await childService.generate(p.input,stageAssets,{signal,pipelineRunId:r.run_id,editEngine:r.edit_engine??'legacy'});
      // Receipt reconciliation is intentionally cancellation-shielded: once a
      // child has submitted, persist its ID before honoring abort below.
      p.child_run_id=runId(child.run_id);await store.write(r);
    } else child=await childService.run({run_id:p.child_run_id},{signal});
    signal?.throwIfAborted();
    if(child.status==='failed'||child.status==='unknown') {r.status=child.status;r.error=child.error??{code:child.status==='unknown'?'CHILD_UNKNOWN':'CHILD_FAILED',message:'Original child requires reconciliation; do not resubmit.'};return write(r,signal);}
    // Mirror the child's latest observation: a stale lost-reply error on a live
    // child reads as an offline worker; a fresh one lets art_run stop early.
    if(child.status!=='succeeded') {r.status='running';if(child.error)r.error=child.error;else delete r.error;return write(r,signal);}
    const bytes=await checked(child.artifact,path.join(dataRoot,'runs',p.child_run_id)),image=decodePng(bytes);
    if(image.width!==p.input.width||image.height!==p.input.height||child.artifact.width!==image.width||child.artifact.height!==image.height)corrupt();
    r.history.push({phase:r.phase,region:r.cursor,child_run_id:p.child_run_id,artifact:child.artifact});
    r.stage_artifact=child.artifact;r.stage_child_id=p.child_run_id;r.pending=null;r.status='running';delete r.error;
    if(r.phase==='full') {r.artifact=child.artifact;r.status='succeeded';r.protection={scope:'none_after_full_qwen',prior_region_composite:r.canvas};}
    else if(r.phase==='edit' && region.qwen_prompt)r.phase='qwen';
    else r.phase='composite';
    return write(r,signal);
  }
  return Object.freeze({
    async has(id) {runId(id);try{await store.read(id);return true;}catch(e){if(e.code==='RUN_NOT_FOUND')return false;throw e;}},
    async generate(input,assets=[],{signal}={}) {
      signal?.throwIfAborted();
      if(input?.action==='execute') {
        strictObject(input,['mode','action','plan_id']);if(input.mode!=='regions'||assets.length)bad('Execute a saved plan with no replacement inputs.');
        const id=runId(input.plan_id);
        return locked(async()=>{
          signal?.throwIfAborted();const r=await store.read(id);await inputAssets(r);signal?.throwIfAborted();
          if(r.status==='draft'){r.status='running';const result=await write(r);signal?.throwIfAborted();return result;}return compact(r);
        },signal);
      }
      const safe=validateAssets(assets,4500000),params=normalizeRegions(input,safe);
      for(const region of params.regions)text(editPrompt(params.prompt,region,editEngine),'combined edit prompt',12000,true);
      const input_hash=hash(JSON.stringify({params,assets:safe.map(({sha256,mediaType,width,height})=>({sha256,mediaType,width,height}))}));
      // Freeze before awaiting locks; neither input objects nor Buffers remain shared.
      for(const r of params.regions)if(r.seed===null)r.seed=seed();
      return locked(async()=>{
        signal?.throwIfAborted();
        const id=randomUUID(),at=now();
        const r={schemaVersion:1,run_id:id,request_id:params.request_id,input_hash,params,edit_engine:editEngine,status:'draft',cursor:0,phase:'edit',pending:null,history:[],created_at:at,updated_at:at,assets:[]};
        signal?.throwIfAborted();
        // Cancellation before claim performs no draft write. Once this local,
        // GPU-free transaction starts, settle assets + preview + run before
        // surfacing abort; otherwise the permanent claim cannot be recovered.
        const claim=await store.claim(params.request_id,r);
        if(!claim.owner){signal?.throwIfAborted();if(claim.value.input_hash!==input_hash)throw fault('REQUEST_CONFLICT','Region request_id belongs to another immutable plan.');const old=await store.read(claim.value.run_id);signal?.throwIfAborted();if(!old.preview_artifact)corrupt();return compact(old);}
        for(let i=0;i<safe.length;i++){
          const a=safe[i],file=path.join(store.directory(id),`ref${i+1}.${extension(a.mediaType)}`);await atomicWrite(file,a.data);
          r.assets.push({path:file,sha256:a.sha256,mediaType:a.mediaType,width:a.width,height:a.height});
        }
        r.canvas={...r.assets[0]};r.preview_artifact=await put(id,'preview.png',regionOverlay(safe[0].data,params.regions));
        const result=await write(r);signal?.throwIfAborted();return result;
      },signal);
    },
    run(input,{signal,beforeStage}={}) {strictObject(input,['run_id']);const id=runId(input.run_id);return locked(async()=>advance(await store.read(id),signal,beforeStage),signal);},
    context(input={}) {strictObject(input,['limit','run_id']);return store.locked(async()=>{const ids=input.run_id?[runId(input.run_id)]:await store.recent(number(input.limit??3,'limit',1,3,true));const runs=[];for(const id of ids){const r=await store.read(id);runs.push({...compact(r,!!input.run_id),review:await store.review(id)});}return {schemaVersion:1,runs};});},
    review(input) {strictObject(input,['run_id','observations','issues','next_change']);const id=runId(input.run_id);return locked(async()=>{await store.read(id);const review={observations:strings(input.observations,'observations',12,500),issues:strings(input.issues,'issues',12,160),next_change:text(input.next_change,'next change',500),updated_at:now()};await store.writeReview(id,review);return {run_id:id,review};});},
  });
}
