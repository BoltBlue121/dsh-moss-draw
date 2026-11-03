import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {realpath,open} from 'node:fs/promises';
import {atomicWrite,hash} from './store.mjs';
import {fault,strictObject,runId,number,text} from './catalog.mjs';
import {decodePng} from './region-pixels.mjs';
import {projectLayout,cameraDescription,validateCamera,DEFAULT_CAMERA} from './workbench-camera.mjs';
import {isStudioAction,handleStudioAction} from './studio-host.mjs';
import {STUDIO_ANALYSIS_ACTIONS,validateStudioAnalysisInput} from './studio-analysis-host.mjs';
import {studioRequestAuthorization} from './studio-authorization.mjs';

const REGION_FIELDS=['id','box','reference_index','prompt','style','lora_strength','loras','seed','context_px','feather_px','qwen_prompt','steps','cfg'];
const CREATE_FIELDS=['title','canvas','references','regions','prompt','qwen_full_prompt','camera'];
const STORE_ACTIONS=new Set(['get','update','propose','resolve','history','restore']);
const invalid=()=>{throw fault('INVALID_INPUT','Invalid workbench action or fields.');};
const integrity=()=>{throw fault('WORKBENCH_ASSET_INTEGRITY','Frozen workbench image is missing or changed; do not regenerate from a different source.');};
const within=(root,file)=>{const rel=path.relative(root,file);return rel!==''&&!rel.startsWith(`..${path.sep}`)&&rel!=='..'&&!path.isAbsolute(rel);};
async function boundedRead(file,root,max){
  const actual=await realpath(file);if(!within(await realpath(root),actual))integrity();
  const handle=await open(actual,'r');try{const stat=await handle.stat();if(!stat.isFile()||stat.size>max||stat.size<1)integrity();const data=await handle.readFile();if(data.length!==stat.size)integrity();return data;}finally{await handle.close();}
}
// Workbench documents are workspace artifacts: they must survive the end of a
// conversation, so their root is the shared studio root, not the session ledger.
const rootOf=entry=>entry.studioRoot??entry.dataRoot;
const assetDirectory=(entry,id)=>path.join(rootOf(entry),'workbench','assets',runId(id));
function validateAsset(asset,index){
  if(!asset||!(asset.data instanceof Uint8Array)||asset.data.length>32*1024*1024||asset.data.length<12||!['image/png','image/jpeg','image/webp'].includes(asset.mediaType))integrity();
  number(asset.width,'image width',1,4096,true);number(asset.height,'image height',1,4096,true);
  if(asset.width*asset.height>(index===0?4500000:2100000))invalid();
  if(index===0){if(asset.mediaType!=='image/png')throw fault('INVALID_INPUT','Regional canvas must be PNG.');const p=decodePng(asset.data);if(p.width!==asset.width||p.height!==asset.height)integrity();}
}
// Separate immutable anchor in the document database: changing both an image
// and its JSON manifest is not a valid way to change an existing document.
function manifestAnchor(entry,id,digest){
  const db=new DatabaseSync(path.join(rootOf(entry),'workbench','documents.sqlite'));
  try{db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS asset_manifests(document_id TEXT PRIMARY KEY,digest TEXT NOT NULL);');
    if(digest!==undefined)db.prepare('INSERT INTO asset_manifests VALUES(?,?)').run(id,digest);
    return db.prepare('SELECT digest FROM asset_manifests WHERE document_id=?').get(id)?.digest;
  }finally{db.close();}
}
async function freezeAssets(entry,document,assets){
  if(assets.length!==document.references.length)integrity();const root=assetDirectory(entry,document.document_id),receipts=[];
  for(let i=0;i<assets.length;i++){const a=assets[i];validateAsset(a,i);const file=`reference-${i}.${a.mediaType==='image/png'?'png':a.mediaType==='image/jpeg'?'jpg':'webp'}`;await atomicWrite(path.join(root,file),a.data);receipts.push({file,sha256:hash(a.data),width:a.width,height:a.height,mediaType:a.mediaType});}
  const manifest=JSON.stringify({document_id:document.document_id,references:document.references,assets:receipts});
  await atomicWrite(path.join(root,'manifest.json'),manifest);manifestAnchor(entry,document.document_id,hash(manifest));
}
async function frozenAssets(entry,document){
  const root=assetDirectory(entry,document.document_id);try{
    const bytes=await boundedRead(path.join(root,'manifest.json'),rootOf(entry),65536);
    if(manifestAnchor(entry,document.document_id)!==hash(bytes))integrity();
    const m=JSON.parse(bytes.toString('utf8'));
    if(m.document_id!==document.document_id||JSON.stringify(m.references)!==JSON.stringify(document.references)||m.assets.length!==document.references.length)integrity();
    const assets=[];for(let i=0;i<m.assets.length;i++){const a=m.assets[i];if(!new RegExp(`^reference-${i}\\.(png|jpg|webp)$`).test(a.file??'')||!/^([0-9a-f]{64})$/.test(a.sha256??''))integrity();const data=await boundedRead(path.join(root,a.file),rootOf(entry),32*1024*1024);if(hash(data)!==a.sha256)integrity();const value={data,mediaType:a.mediaType,width:a.width,height:a.height};validateAsset(value,i);assets.push(value);}return assets;
  }catch(e){if(e.code==='INVALID_INPUT')throw e;integrity();}
}

// Transport-independent, exact-session bridge. Adapters must admit references
// before they enter this module; persisted documents never authorize new paths.
export function createWorkbenchBridge({getEntry,resolveReference,resolveAnalysisReference,readRunImage,previewImage,inspectPlan,requestAuthorization=studioRequestAuthorization,consentAuthorization,analysisModelSelection}){
  return async function bridge(request,exec,actor='ui'){
    exec.signal?.throwIfAborted();if(!request||typeof request!=='object'||Array.isArray(request))invalid();
    const {action,...args}=request;
    const modelSelection=action==='studioAnalyzeReference'?analysisModelSelection?.(exec):undefined;
    if(STUDIO_ANALYSIS_ACTIONS.includes(action))validateStudioAnalysisInput(action,args);
    const entry=getEntry(exec),store=entry.workbench;
    if(isStudioAction(action))return handleStudioAction(entry,action,args,exec.signal,{actor,modelSelection,session_id:exec.agent?.session?.id??exec.agent?.id,readAuthorization:()=>requestAuthorization(exec),resolveReference:ref=>resolveReference(ref,exec),resolveAnalysisReference:resolveAnalysisReference?ref=>resolveAnalysisReference(ref,exec):undefined,authorization:actor==='agent'&&['studioStart','studioPrepare','studioExecute','studioRequestConsent'].includes(action)?await requestAuthorization(exec):undefined,consentEvidence:actor==='agent'&&action==='studioApplyConsent'?await consentAuthorization?.(exec):undefined});
    if(action==='state'){strictObject(args,[]);const [state,context]=await Promise.all([store.list({}),entry.service.context({})]);return{...state,runs:context.runs};}
    if(STORE_ACTIONS.has(action))return store[action](args);
    if(action==='create'){
      strictObject(args,CREATE_FIELDS);if(!Array.isArray(args.references)||args.references.length<2||args.references.length>4)invalid();const assets=[];
      for(const ref of args.references){exec.signal?.throwIfAborted();assets.push(await resolveReference(ref,exec));}exec.signal?.throwIfAborted();
      assets.forEach(validateAsset);if(args.canvas?.width!==assets[0].width||args.canvas?.height!==assets[0].height)throw fault('WORKBENCH_CANVAS_MISMATCH','Canvas dimensions must match the actual base image.');
      const doc=await store.create(args);await freezeAssets(entry,doc,assets);return doc;
    }
    if(action==='importPlan'){
      strictObject(args,['run_id','title']);runId(args.run_id);const source=await inspectPlan(args.run_id,exec);exec.signal?.throwIfAborted();
      const refs=source.assets.map((_,i)=>`plan:${args.run_id}:${i}`);source.assets.forEach(validateAsset);
      const d=await store.create({title:args.title??'Imported regional plan',canvas:{width:source.assets[0].width,height:source.assets[0].height,reference:refs[0]},references:refs,prompt:source.params.prompt,regions:source.params.regions,qwen_full_prompt:source.params.qwen_full_prompt??''});await freezeAssets(entry,d,source.assets);return d;
    }
    if(action==='cameraPreview'){
      strictObject(args,['document_id','camera']);const d=await store.get({document_id:args.document_id}),camera=validateCamera({...d.camera,...args.camera});return{projection:projectLayout(d.regions,camera,d.canvas),description:cameraDescription(camera)};
    }
    if(action==='materialize'){
      strictObject(args,['document_id','expected_revision']);number(args.expected_revision,'expected revision',1,Number.MAX_SAFE_INTEGER,true);
      const d=await store.get({document_id:args.document_id});if(d.revision!==args.expected_revision)throw fault('WORKBENCH_CONFLICT','Document changed; reload before materializing.');
      const assets=await frozenAssets(entry,d);exec.signal?.throwIfAborted();
      const current=await store.get({document_id:args.document_id});if(current.revision!==d.revision)throw fault('WORKBENCH_CONFLICT','Document changed while preparing its draft.');
      // Only the observed revision is frozen. Subsequent edits cannot mutate it.
      return entry.service.generate({mode:'regions',action:'draft',request_id:`workbench:${d.document_id}:${d.revision}`,prompt:d.prompt,
        regions:d.regions.map(r=>({...Object.fromEntries(REGION_FIELDS.filter(k=>Object.hasOwn(r,k)).map(k=>[k,r[k]])),prompt:r.prompt+(Object.keys(DEFAULT_CAMERA).some(k=>d.camera[k]!==DEFAULT_CAMERA[k])?`\n${cameraDescription(d.camera)}`:'')})),...(d.qwen_full_prompt?{qwen_full_prompt:d.qwen_full_prompt}:{})},assets,{signal:exec.signal});
    }
    if(action==='asset'){
      strictObject(args,['document_id','reference_index','run_id','variant']);let image;
      if(args.document_id!==undefined){if(args.run_id!==undefined||args.variant!==undefined)invalid();const d=await store.get({document_id:args.document_id});number(args.reference_index,'reference index',0,d.references.length-1,true);image=(await frozenAssets(entry,d))[args.reference_index];}
      else{if(args.reference_index!==undefined)invalid();runId(args.run_id);if(args.variant!==undefined&&!['preview','result'].includes(args.variant))invalid();image=await readRunImage(args,exec);}
      exec.signal?.throwIfAborted();const preview=await previewImage(image,exec);exec.signal?.throwIfAborted();
      if(!preview||!(preview.data instanceof Uint8Array)||preview.data.length>512*1024||!['image/png','image/jpeg','image/webp'].includes(preview.mediaType))throw fault('WORKBENCH_PREVIEW_LIMIT','Preview is too large; use original delivery.');
      return{data_url:`data:${preview.mediaType};base64,${Buffer.from(preview.data).toString('base64')}`,width:image.width,height:image.height};
    }
    invalid();
  };
}
export function registerWorkbenchCommand(ctx,{bridge}){
  return ctx.commands.register({definitionId:'moss-draw.workbench',name:'art-workbench',description:'Inspect and adjust this drawing session workbench; does not execute GPU tasks.',input:{hint:'JSON workbench action'},recordInput:false,
    handler:async exec=>{try{if(typeof exec.rawInput!=='string'||exec.rawInput.length>1572864)invalid();let request;try{request=JSON.parse(exec.rawInput);}catch{invalid();}const result=await bridge(request,exec);return{kind:'success',text:JSON.stringify(result)};}catch(e){exec.signal?.throwIfAborted();const code=/^(WORKBENCH|MOSS|STUDIO)_[A-Z0-9_]+$/.test(e.code??'')||e.code==='INVALID_INPUT'?e.code:'WORKBENCH_OPERATION_FAILED';return{kind:'error',text:code};}}});
}
