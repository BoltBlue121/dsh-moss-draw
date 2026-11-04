import path from 'node:path';
import {open,readFile,realpath,lstat,mkdir,rename,unlink,link,chmod} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {validateStudioDoc} from './studio-domain.mjs';
import {validateGbcGraph,summarizeGbcGraph,buildGenerationPrompt} from './analysis-graph.mjs';
import {createAnalysisRunner,analysisProcessIdentity} from './analysis-runner.mjs';
import {createHostVlmProxy} from './vlm-proxy.mjs';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
// A GBC pass is dozens of VLM calls: the child's own deadline publishes the coded timeout first,
// this is only the outer backstop so a wedged child can never hold a workspace forever.
const ANALYSIS_TIMEOUT_MS=420000;
const STAT_KEYS=['vertices','model_calls','model_errors','blocked','edges','captions','depth','roots','leaves','seconds'];
const CORE_VERSION_KEYS=['python','kohakugbc','togeari','kohakugbc-data','kohakunode','kohakuvault'];
const VERSION=/^(?:\d+!)?\d+(?:\.\d+)*(?:(?:a|b|rc)\d+|-(?:alpha|beta|rc)\.?\d+)?(?:\.post\d+)?(?:\.dev\d+)?(?:\+[a-z0-9]+(?:[._-][a-z0-9]+)*)?$/i;
const HOST_AGENT_TOKEN_ENV='MOSS_GBC_VLM_TOKEN';
const VLM_ATTEMPTS=Object.freeze(['host-agent','http']);
const extensions=Object.freeze(Object.assign(Object.create(null),{'image/png':'png','image/jpeg':'jpg','image/webp':'webp'}));
const pendingKeys=new Map(),jobQueues=new Map();let ownerPromise;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code:`STUDIO_ANALYSIS_${code}`});};
const hash=value=>createHash('sha256').update(value).digest('hex');
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const digest=value=>hash(JSON.stringify(stable(value)));
const encoded=value=>Buffer.from(JSON.stringify(value));
const absolute=p=>typeof p==='string'&&path.isAbsolute(p)&&!p.includes('\0');
const equal=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const id=value=>{if(typeof value!=='string'||!UUID.test(value))fail('RESULT_INVALID','Invalid analysis identity.');return value;};
const now=()=>new Date().toISOString();
const keyOf=(pageId,requestKey)=>{id(pageId);if(typeof requestKey!=='string'||!requestKey.trim()||requestKey.length>100)fail('RESULT_INVALID','Invalid request key.');return digest([pageId,requestKey]);};
async function atomic(filename,data,exclusive=false){
 const temp=`${filename}.${randomUUID()}.tmp`,handle=await open(temp,'wx',0o600);try{await handle.writeFile(data);await handle.sync();}finally{await handle.close();}
 try{
  if(exclusive){try{await link(temp,filename);return true;}catch(e){if(e.code==='EEXIST')return false;throw e;}}
  // Windows readers without FILE_SHARE_DELETE can transiently deny replacement.
  // Retry only this already-fsynced rename, never its caller/model work or target deletion.
  for(let attempt=0;;attempt++){
   try{await rename(temp,filename);return true;}
   catch(error){
    if(process.platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(error?.code)||attempt>=5)fail('UNKNOWN','Analysis record replacement could not be confirmed.');
    await delay(10*2**attempt);
   }
  }
 }
 finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
}
async function bytes(filename,max){
 try{const s=await lstat(filename);if(!s.isFile()||s.isSymbolicLink()||s.size>max||!equal(await realpath(filename),path.resolve(filename)))throw Error();
 const handle=await open(filename,'r');try{const info=await handle.stat();if(!info.isFile()||info.size>max)throw Error();const data=await handle.readFile();if(data.length!==info.size||data.length>max)throw Error();return data;}finally{await handle.close();}
 }catch(e){if(e.code==='ENOENT')throw e;fail('RESULT_INVALID','An analysis record is invalid.');}
}
async function json(filename,max=1048576){try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(await bytes(filename,max)),(_key,value)=>{if(typeof value==='number'&&!Number.isFinite(value))throw Error();return value;});}catch(e){if(e.code==='ENOENT')throw e;fail('RESULT_INVALID','An analysis record is invalid.');}}
async function optionalJson(file,max){try{return await json(file,max);}catch(e){if(e.code==='ENOENT')return undefined;throw e;}}
async function canonicalAncestor(directory){
 let current=path.resolve(directory);
 while(true){try{if(!equal(await realpath(current),current))fail('RESULT_INVALID','An analysis storage ancestor is invalid.');return;}
 catch(e){if(e.code!=='ENOENT')throw e;const parent=path.dirname(current);if(parent===current)fail('RESULT_INVALID','Analysis storage is unavailable.');current=parent;}}
}
async function fileGuard(filename,work){
 const token=randomUUID();let handle;
 for(let n=0;n<500;n++){try{handle=await open(filename,'wx',0o600);break;}catch(e){if(e.code!=='EEXIST')throw e;await delay(10);}}
 if(!handle)fail('LEASE_HELD','Analysis record mutation is already held.');
 try{await handle.writeFile(token);await handle.sync();await handle.close();return await work();}
 finally{await handle?.close().catch(()=>{});try{if((await bytes(filename,100)).toString()===token)await unlink(filename);}catch(e){if(e.code!=='ENOENT')throw e;}}
}
async function plainDirectory(directory,create=false){
 if(create){await canonicalAncestor(directory);await mkdir(directory,{recursive:true});}
 const actual=await realpath(directory);if(!equal(actual,path.resolve(directory))||!(await lstat(directory)).isDirectory())fail('RESULT_INVALID','An analysis directory is invalid.');return actual;
}
function queue(key,work){const previous=jobQueues.get(key)??Promise.resolve(),result=previous.catch(()=>{}).then(work),tail=result.catch(()=>{});jobQueues.set(key,tail);tail.finally(()=>{if(jobQueues.get(key)===tail)jobQueues.delete(key);});return result;}
async function owner(){ownerPromise??=analysisProcessIdentity(process.pid);const value=await ownerPromise;if(value.state!=='alive'){ownerPromise=undefined;fail('LEASE_HELD','Host process identity is unavailable.');}return{pid:value.pid,started_at:value.started_at};}
async function dead(identity){if(!identity||!Number.isSafeInteger(identity.pid)||typeof identity.started_at!=='string')return null;const current=await analysisProcessIdentity(identity.pid);if(current.state==='unknown')return null;return current.state==='dead'||current.started_at!==identity.started_at;}
const safeError=(code,message)=>({code:`STUDIO_ANALYSIS_${code}`,message});
function strict(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail('RESULT_INVALID','Invalid analysis fields.');}
function validAttempts(value){
 if(!Array.isArray(value)||value.length<1||value.length>VLM_ATTEMPTS.length)return undefined;
 const seen=new Set();
 for(const item of value){if(typeof item!=='string'||!VLM_ATTEMPTS.includes(item)||seen.has(item))return undefined;seen.add(item);}
 return[...value];
}
function selectedModel(value){
 try{
  const valid=(text,max)=>typeof text==='string'&&text.length>0&&text.length<=max&&!/[\u0000-\u001f\u007f]/.test(text);
  if(value&&valid(value.sessionId,256)&&valid(value.provider,128)&&valid(value.model,256)&&(value.reasoningEffort===undefined||valid(value.reasoningEffort,128)))return Object.freeze({sessionId:value.sessionId,provider:value.provider,model:value.model,...(value.reasoningEffort===undefined?{}:{reasoningEffort:value.reasoningEffort})});
 }catch{/* Only a valid trusted per-admission snapshot may select an account route. */}
 return null;
}
function validateEnvelope(e,m){
 strict(e,['schema_version','analysis_id','source_sha256','width','height','status','graph','stats','warnings','versions','error','vlm_attempts']);
 if(e.schema_version!==1||e.analysis_id!==m.analysis_id||e.source_sha256!==m.source.sha256||e.width!==m.source.width||e.height!==m.source.height||!['succeeded','degraded','failed','not_ready'].includes(e.status))fail('RESULT_INVALID','Analysis result identity is invalid.');
 if(e.vlm_attempts!==undefined&&validAttempts(e.vlm_attempts)===undefined)fail('RESULT_INVALID','Invalid analysis VLM attempts.');
 if(!Array.isArray(e.warnings)||e.warnings.length>32)fail('RESULT_INVALID','Invalid analysis warnings.');
 for(const w of e.warnings){strict(w,['code','message']);if(typeof w.code!=='string'||!w.code||w.code.length>64||typeof w.message!=='string'||w.message.length>200)fail('RESULT_INVALID','Invalid analysis warning.');}
 if(e.stats!==undefined){
  strict(e.stats,STAT_KEYS);
  for(const [key,value] of Object.entries(e.stats))if(key==='seconds'?typeof value!=='number'||!Number.isFinite(value)||value<0||value>86400:!Number.isSafeInteger(value)||value<0||value>1000000)fail('RESULT_INVALID','Invalid analysis statistics.');
 }
 if(e.versions!==undefined){
  strict(e.versions,[...CORE_VERSION_KEYS,'kohakugbc_source_commit','kohakugbc_archive_sha256']);
  for(const [key,value] of Object.entries(e.versions)){
   const valid=CORE_VERSION_KEYS.includes(key)?value===null||typeof value==='string'&&value.length<=80&&VERSION.test(value):typeof value==='string'&&(key==='kohakugbc_source_commit'?/^[0-9a-f]{40}$/.test(value):HASH.test(value));
   if(!valid)fail('RESULT_INVALID','Invalid analysis version metadata.');
  }
 }
 if(['succeeded','degraded'].includes(e.status)){
  if(e.error!==undefined||!e.graph||typeof e.graph!=='object'||Buffer.byteLength(JSON.stringify(e.graph))>1048576)fail('RESULT_INVALID','Invalid graph result.');
  try{e.graph=validateGbcGraph(e.graph);}catch{fail('RESULT_INVALID','Invalid graph result.');}
  if(e.graph.img_size!=null&&(e.graph.img_size[0]!==m.source.width||e.graph.img_size[1]!==m.source.height))fail('RESULT_INVALID','Graph source dimensions differ.');
 }else{
  if(Object.hasOwn(e,'graph'))fail('RESULT_INVALID','Failure cannot contain a graph.');strict(e.error,['code','message']);
  if(typeof e.error.code!=='string'||!/^[A-Za-z0-9_.-]{1,64}$/.test(e.error.code)||typeof e.error.message!=='string'||e.error.message.length>200)fail('RESULT_INVALID','Invalid runtime error.');
 }
 return e;
}

export function createAnalysisService({dataRoot,workspaceAnalysisRoot,runtime,runner,resolveCredential,attachments,llm,agentDefaultModel,logger,fallbackModel}={}){
 if(!absolute(dataRoot)||!absolute(workspaceAnalysisRoot)||resolveCredential!==undefined&&typeof resolveCredential!=='function')fail('NO_CONFIG','Trusted analysis storage roots are required.');
 dataRoot=path.resolve(dataRoot);workspaceAnalysisRoot=path.resolve(workspaceAnalysisRoot);
 const root=path.join(dataRoot,'analysis'),indexRoot=path.join(root,'keys'),leaseRoot=path.join(workspaceAnalysisRoot,'analysis'),leaseFile=path.join(leaseRoot,'.lease'),session=digest(dataRoot),active=new Map(),launches=new Map();
 const directory=analysisId=>path.join(root,id(analysisId));
 async function runtimeIdentity(){
  if(!runtime||!absolute(runtime.python)||!absolute(runtime.configPath))fail('NO_CONFIG','Analysis runtime is not configured.');
  try{const python=await realpath(runtime.python),configPath=await realpath(runtime.configPath);if(!(await lstat(python)).isFile())throw Error();const config=await bytes(configPath,65536);return{identity:{python,configPath,config_sha256:hash(config)},config};}
  catch{fail('NO_CONFIG','Analysis runtime files are unavailable.');}
 }
 async function freezeSnapshot(config){
  const configs=path.join(root,'configs');await plainDirectory(configs,true);
  const sha=hash(config),snapshot=path.join(configs,`${sha}.json`);
  await atomic(snapshot,config,true);
  const stored=await bytes(snapshot,65536);
  if((await lstat(snapshot)).nlink!==1||hash(stored)!==sha||!stored.equals(config))fail('RESULT_INVALID','Analysis configuration snapshot is invalid.');
  await chmod(snapshot,0o400);return{path:snapshot,sha};
 }
 async function freezeConfig(identity,config){
  const {path:snapshot,sha}=await freezeSnapshot(config);
  if(sha!==identity.config_sha256)fail('RESULT_INVALID','Analysis configuration snapshot is invalid.');
  return snapshot;
 }
 async function index(key){const entry=await optionalJson(path.join(indexRoot,`${key}.json`),4096);if(entry!==undefined&&(!entry||entry.schema_version!==1||entry.session!==session||entry.key!==key||!HASH.test(entry.fingerprint??'')||!UUID.test(entry.analysis_id??'')))fail('RESULT_INVALID','Invalid analysis index.');return entry;}
 async function load(analysisId){
  const dir=directory(analysisId);try{await plainDirectory(dir);}catch(e){if(e.code==='ENOENT')fail('UNKNOWN','Analysis not found in this session.');throw e;}
  let m,c,request;try{[m,c,request]=await Promise.all([json(path.join(dir,'metadata.json')),json(path.join(dir,'claim.json'),65536),json(path.join(dir,'request.json'),32768)]);}catch{fail('RESULT_INVALID','Analysis metadata is missing or invalid.');}
  if(!m||!c||!request||typeof m!=='object'||typeof c!=='object'||typeof request!=='object'||!m.frozen||typeof m.frozen!=='object')fail('RESULT_INVALID','Analysis record shape is invalid.');
  if(m.schema_version!==1||m.session!==session||m.analysis_id!==analysisId||c.schema_version!==1||c.analysis_id!==analysisId||!HASH.test(m.fingerprint??'')||digest(m.frozen)!==m.fingerprint||m.frozen?.pageId!==m.pageId||!HASH.test(c.metadata_hash??'')||hash(encoded(m))!==c.metadata_hash)fail('RESULT_INVALID','Analysis metadata integrity failed.');
  const source=m.frozen.source,filename=path.join(dir,`input.${extensions[source?.mime]}`);
  if(!extensions[source?.mime]||!HASH.test(source.sha256??''))fail('RESULT_INVALID','Invalid frozen source.');
  const expected={schema_version:1,analysis_id:analysisId,input:{path:filename,sha256:source.sha256,width:source.width,height:source.height,media_type:source.mime},profile:m.frozen.detail};
  if(digest(request)!==digest(expected))fail('RESULT_INVALID','Frozen request integrity failed.');
  return{dir,m:{...m,...m.frozen,source},c,request};
 }
 async function update(analysisId,mutate){return queue(directory(analysisId),async()=>{
  await load(analysisId);
  return fileGuard(path.join(directory(analysisId),'.claim.guard'),async()=>{
   const {dir,c}=await load(analysisId),previous=digest(c),next=mutate(structuredClone(c));if(!next)return c;
   if(digest(await json(path.join(dir,'claim.json'),65536))!==previous)fail('CONFLICT','Analysis lifecycle changed.');
   next.updated_at=now();await atomic(path.join(dir,'claim.json'),encoded(next));return next;
  });
 });}
 async function guarded(work){await plainDirectory(leaseRoot,true);return fileGuard(path.join(leaseRoot,'.lease.guard'),work);}
 async function changeLease(token,transform){return guarded(async()=>{const current=await optionalJson(leaseFile,8192);if(current?.token!==token)return false;const next=transform(current);if(next)await atomic(leaseFile,encoded(next));else await unlink(leaseFile);return true;});}
 async function acquire(analysisId,key){
  const identity=await owner(),token=randomUUID();
  return guarded(async()=>{
   const old=await optionalJson(leaseFile,8192);
   if(old!==undefined){
    if(!old||old.schema_version!==1||!UUID.test(old.token??'')||!['prepared','launching','running'].includes(old.phase))fail('LEASE_HELD','Workspace lease cannot be verified.');
    if(old.phase==='launching')fail('LEASE_HELD','Previous launch identity is uncertain; operator recovery is required.');
    const childDead=old.child?await dead(old.child):old.phase==='prepared'?true:null;
    if(childDead===false)fail('BUSY','An analysis child is still active in this workspace.');
    if(childDead===null)fail('LEASE_HELD','Previous child identity is uncertain.');
    if(await dead(old.owner)!==true)fail('BUSY','An analysis owner still holds this workspace.');
   }
   const value={schema_version:1,token,analysis_id:analysisId,session,key,phase:'prepared',owner:identity,child:null};
   await atomic(leaseFile,encoded(value));return value;
  });
 }
 async function envelope(dir,m){
  // Host evidence annotation replaces result.json atomically. On Windows a reader can
  // briefly observe the delete-pending path (EBADF); retry before treating it as corrupt.
  for(let attempt=0;;attempt++){
   try{const e=await optionalJson(path.join(dir,'result.json'),2097152);return e===undefined?null:validateEnvelope(e,m);}
   catch(error){if(attempt>=2||error?.code!=='STUDIO_ANALYSIS_RESULT_INVALID')throw error;await delay(5);}
  }
 }
 async function inspect(analysisId,detail=false,internal=false){
  const {dir,m,c}=await load(analysisId),entry=active.get(analysisId);
  let cancelled=c.state==='cancelled';try{await bytes(path.join(dir,'cancel.requested'),100);cancelled=true;}catch(e){if(e.code!=='ENOENT')throw e;}
  let e=null;if(!cancelled)e=await envelope(dir,m);
  let state=entry&&!entry.outcome&&!entry.lost?'running':'unknown',error;
  if(cancelled)state='cancelled';
  else if(c.state==='unknown'&&c.error?.code==='STUDIO_ANALYSIS_UPSTREAM_UNKNOWN'){state='unknown';error=c.error;}
  else if(entry&&!entry.outcome&&!entry.lost)state='running';
  else if(c.exit?.timedOut){state='failed';error=safeError('TIMEOUT','Analysis exceeded its local deadline.');}
  else if(e){
   if(c.exit&&c.exit.exitCode!==0&&['succeeded','degraded'].includes(e.status))fail('RESULT_INVALID','Result disagrees with recorded process exit.');
   state=e.status;if(e.error)error={code:e.error.code,message:state==='not_ready'?'Analysis runtime is not ready.':'Analysis runtime failed.'};
  }else if(c.exit){state='failed';error=c.error??safeError('RUNNER_FAILED','Analysis process exited without a valid result.');}
  else if(['failed','not_ready','cancelled'].includes(c.state)){state=c.state;error=c.error;}
  const readable=e?.graph&&['succeeded','degraded'].includes(state),attempts=validAttempts(c.vlm_attempts);
  const value={analysis_id:analysisId,state,status:state,page_id:m.pageId,base_revision:m.baseRevision,source:{...m.source},summary:readable?summarizeGbcGraph(e.graph,{detail}):null,...(detail&&readable?{generation:buildGenerationPrompt(e.graph)}:{}),warnings:e?.warnings??[],versions:e?.versions??{},...(attempts?{vlm_attempts:attempts}:{}),...(error?{error}:{}),...(cancelled||error?.code==='STUDIO_ANALYSIS_UPSTREAM_UNKNOWN'?{remote_work_uncertain:true}:{})};
  if(internal){
   let actual;try{actual=await bytes(path.join(dir,`input.${extensions[m.source.mime]}`),33554432);}catch{fail('RESULT_INVALID','Frozen source is missing or invalid.');}if(hash(actual)!==m.source.sha256)fail('RESULT_INVALID','Frozen source integrity failed.');
   Object.assign(value,{pageId:m.pageId,baseRevision:m.baseRevision,baseDoc:structuredClone(m.baseDoc),detail:m.detail,fit:m.fit,configIdentity:structuredClone(m.runtime),...(c.proposal?{proposal:structuredClone(c.proposal)}:{})});
   if(e?.graph&&['succeeded','degraded'].includes(state))value.graph=structuredClone(e.graph);
  }
  return value;
 }
 async function finish(analysisId,token,outcome,attempts){
  const entry=active.get(analysisId);if(entry)entry.outcome=outcome;
  try{await update(analysisId,c=>{c.exit=outcome;if(attempts)c.vlm_attempts=[...attempts];return c;});
   let view;try{view=await inspect(analysisId);}catch{view={state:'failed',error:safeError('RESULT_INVALID','Analysis result is invalid.')};}
   await update(analysisId,c=>{if(c.state!=='cancelled'){c.state=view.state;if(view.error)c.error=view.error;}return c;});
  }finally{await changeLease(token,()=>null);}
 }
 async function annotateResultFile(file,attempts){
  if(!attempts)return;
  try{
   const value=JSON.parse(await readFile(file,'utf8'));
   if(!value||typeof value!=='object'||Array.isArray(value)||value.vlm_attempts!==undefined)return;
   value.vlm_attempts=[...attempts];await atomic(file,encoded(value));
  }catch{/* Evidence annotation is best effort; the claim remains authoritative. */}
 }
 async function admit(input,admittedImage,signal,modelSelection){
  // Capture caller-owned bytes and Doc before yielding; input paths are never accepted here.
  const image={...admittedImage,bytes:Buffer.isBuffer(admittedImage?.bytes)?Buffer.from(admittedImage.bytes):null};
  strict(input,['pageId','baseRevision','baseDoc','requestKey','detail','fit']);const key=keyOf(input.pageId,input.requestKey);
  const baseDoc=validateStudioDoc(input.baseDoc),detail=input.detail??'balanced',fit=input.fit??'contain';
  if(!Number.isSafeInteger(input.baseRevision)||input.baseRevision<1||!['quick','balanced','detailed'].includes(detail)||!['contain','cover','stretch'].includes(fit)||!image.bytes||image.bytes.length<1||image.bytes.length>33554432||!extensions[image.mime]||!HASH.test(image.sha256??'')||hash(image.bytes)!==image.sha256||![image.width,image.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=4096)||image.width*image.height>16000000)fail('RESULT_INVALID','Invalid frozen analysis input.');
  input={...input,baseDoc};
  signal?.throwIfAborted();const {identity:rt,config}=await runtimeIdentity();await canonicalAncestor(root);await canonicalAncestor(leaseRoot);signal?.throwIfAborted();
  // The switch is read from the same bytes the worker will validate. A malformed config is
  // left exactly as before for the worker to report; only a clear host-agent request activates it.
  const hostAgent=(()=>{try{const value=JSON.parse(config.toString('utf8'));if(value?.vlm?.mode==='host-agent')return{fallback:value.vlm.fallback!==false};}catch{/* Worker reports invalid config unchanged. */}return null;})();
  const hostAgentUnavailable=()=>{try{if(logger?.warn)return logger.warn('host_agent_unavailable');}catch{/* Warning only. */}try{console.warn('[moss-draw] host_agent_unavailable');}catch{/* Warning only; never let logging break admission. */}};
  const frozen={pageId:input.pageId,baseRevision:input.baseRevision,baseDoc,requestKey:input.requestKey,detail,fit,source:{sha256:image.sha256,width:image.width,height:image.height,mime:image.mime},runtime:rt,...(hostAgent?{modelSelection}: {})},fingerprint=digest(frozen),scope=`${dataRoot}:${key}`;
  const operation=async()=>{
   const prior=await index(key);if(prior){if(prior.fingerprint!==fingerprint)fail('CONFLICT','This request key identifies different frozen input.');return inspect(prior.analysis_id);}
   const analysisId=randomUUID();let lease;
   try{lease=await acquire(analysisId,key);}catch(e){
    if(e.code==='STUDIO_ANALYSIS_BUSY'||e.code==='STUDIO_ANALYSIS_LEASE_HELD'){
      // A concurrent same-key admission may still be writing its index; a lease that
      // names another session or key is re-read a few times instead of trusted once.
      let foreignSince=0;const deadline=Date.now()+15000;
      while(Date.now()<deadline){
       const known=await index(key);if(known){if(known.fingerprint!==fingerprint)fail('CONFLICT','This request key identifies different frozen input.');return inspect(known.analysis_id);}
       const current=await optionalJson(leaseFile,8192);
       if(current&&(current.session!==session||current.key!==key)){if(!foreignSince)foreignSince=Date.now();if(Date.now()-foreignSince>1500)throw e;}else foreignSince=0;
       await delay(10);
      }
    }throw e;
   }
   const dir=directory(analysisId),jobController=new AbortController(),jobSignal=signal?AbortSignal.any([signal,jobController.signal]):jobController.signal;let launched=false,proxy=null,vlmAttempts;
   try{
    const priorAfterLease=await index(key);if(priorAfterLease){if(priorAfterLease.fingerprint!==fingerprint)fail('CONFLICT','This request key identifies different frozen input.');return await inspect(priorAfterLease.analysis_id);}
    await plainDirectory(root,true);const configSnapshot=await freezeConfig(rt,config);await mkdir(dir);await plainDirectory(indexRoot,true);
    const metadata={schema_version:1,analysis_id:analysisId,session,pageId:input.pageId,frozen,fingerprint};
    const request={schema_version:1,analysis_id:analysisId,input:{path:path.join(dir,`input.${extensions[image.mime]}`),sha256:image.sha256,width:image.width,height:image.height,media_type:image.mime},profile:detail};
    const claim={schema_version:1,analysis_id:analysisId,token:lease.token,metadata_hash:hash(encoded(metadata)),state:'claimed',created_at:now(),updated_at:now()};
    for(const[name,data]of[['metadata.json',encoded(metadata)],['claim.json',encoded(claim)],['request.json',encoded(request)],[`input.${extensions[image.mime]}`,image.bytes]])if(!await atomic(path.join(dir,name),data,true))fail('RESULT_INVALID','Analysis job already exists.');
    if(!await atomic(path.join(indexRoot,`${key}.json`),encoded({schema_version:1,analysis_id:analysisId,session,key,fingerprint}),true))fail('CONFLICT','Analysis admission raced another claim.');
    signal?.throwIfAborted();
    if(!await changeLease(lease.token,l=>({...l,phase:'launching'}))){for(let n=0;n<500;n++){const taken=await index(key);if(taken){if(taken.fingerprint!==fingerprint)fail('CONFLICT','This request key identifies different frozen input.');return inspect(taken.analysis_id);}await delay(10);}fail('LEASE_HELD','Analysis launch lease was lost.');}
    const beforeLaunch=await inspect(analysisId);if(beforeLaunch.state==='cancelled')return beforeLaunch;
    signal?.throwIfAborted();launched=true;launches.set(analysisId,jobController);
    // The immutable snapshot above remains the frozen identity. A host-agent attempt gets
    // its own content-addressed snapshot outside the job (the worker refuses in-job config).
    let launchConfig=configSnapshot,extraEnv;
    if(hostAgent){
     const selected=modelSelection;let candidate,unavailable=!selected;
     if(selected)try{
      candidate=await createHostVlmProxy({attachments,llm,selection:()=>selected,logger,signal:jobSignal});
      const rewritten=JSON.parse(config.toString('utf8'));
      rewritten.vlm={...rewritten.vlm,protocol:'openai',flavour:'openai',structured:'prompt',model:selected.model,base_url:`${candidate.baseUrl}/v1`,api_key_env:HOST_AGENT_TOKEN_ENV};
      launchConfig=(await freezeSnapshot(encoded(rewritten))).path;
      proxy=candidate;extraEnv={[HOST_AGENT_TOKEN_ENV]:candidate.token};vlmAttempts=['host-agent'];
     }catch{
      if(candidate)await candidate.close().catch(()=>{});
      unavailable=true;
     }
     if(unavailable){
      hostAgentUnavailable();
      if(!hostAgent.fallback||jobSignal.aborted){
       await update(analysisId,c=>({...c,state:c.state==='cancelled'?'cancelled':'not_ready',error:safeError('MODEL_UNAVAILABLE','The caller model is unavailable for image analysis.')}));
       launched=false;return await inspect(analysisId);
      }
      // Only zero-dispatch preflight can choose HTTP. A worker is never replayed.
      launchConfig=configSnapshot;extraEnv=undefined;vlmAttempts=['http'];
     }
    }
    // The proxy setup awaits; cancellation written during it must stop the child before spawn.
    if(hostAgent){
     try{const prepared=await inspect(analysisId);if(prepared.state==='cancelled'){if(proxy)await proxy.close().catch(()=>{});launched=false;return prepared;}}
     catch(error){if(proxy)await proxy.close().catch(()=>{});launched=false;throw error;}
    }
    const runnerOptions=(configPath,env)=>({python:rt.python,configPath,jobRoot:root,resolveCredential,timeoutMs:ANALYSIS_TIMEOUT_MS,...(env?{extraEnv:env}:{})});
    let implementation;
    try{implementation=typeof runner==='function'?runner(runnerOptions(launchConfig,extraEnv)):runner??createAnalysisRunner(runnerOptions(launchConfig,extraEnv));}
    catch(error){if(proxy)await proxy.close().catch(()=>{});launched=false;throw error;}
     const launchSignal=jobSignal;launches.set(analysisId,jobController);
    let handle;try{handle=await implementation.start({requestPath:path.join(dir,'request.json'),resultPath:path.join(dir,'result.json')},{signal:launchSignal});}
    catch(e){
     if(proxy){await proxy.close().catch(()=>{});proxy=null;}
     const preSpawn=e?.code==='STUDIO_ANALYSIS_NOT_STARTED';
     const noSpawn=preSpawn||['STUDIO_ANALYSIS_NO_CONFIG','STUDIO_ANALYSIS_RUNNER_FAILED'].includes(e.code)||(!e?.code&&e?.name==='AbortError');
     await update(analysisId,c=>({...c,state:c.state==='cancelled'?'cancelled':noSpawn?'failed':'unknown',error:safeError(e.code==='STUDIO_ANALYSIS_NO_CONFIG'?'NO_CONFIG':'NOT_STARTED',noSpawn?'Analysis process could not start.':'Analysis launch outcome is uncertain.'),...(noSpawn?{exit:{exitCode:null,signal:null,timedOut:false}}:{})}));
     if(noSpawn){launched=false;throw e;}
     fail('RUNNER_FAILED','Analysis launch outcome is uncertain; it will not be replayed.');
    }
    launches.delete(analysisId);
     const completion=Promise.resolve(handle.done).then(value=>({ok:true,value}),()=>({ok:false}));
    const entry={handle,controller:jobController,outcome:null,lost:false,settled:null};active.set(analysisId,entry);
    const closeProxy=async()=>{const current=proxy;proxy=null;if(!current)return true;try{return(await current.close())?.quiescent!==false;}catch{return false;}};
    const cancelledAnalysis=async()=>{
     try{await lstat(path.join(dir,'cancel.requested'));return true;}catch(e){if(e.code!=='ENOENT')throw e;}
     const loaded=await load(analysisId);return loaded.c.state==='cancelled';
    };
    const settle=()=>{
     entry.settled??=completion.then(async outcome=>{
      const quiet=await closeProxy();
      if(!outcome.ok||!quiet){
       entry.lost=true;
       await update(analysisId,c=>({...c,state:c.state==='cancelled'?'cancelled':'unknown',error:safeError(!quiet?'UPSTREAM_UNKNOWN':'UNKNOWN',!quiet?'Upstream termination could not be confirmed.':'Managed process completion is unavailable.')}));
       return; // Retain the lease while upstream or child completion is uncertain.
      }
      const cancelled=await cancelledAnalysis();
      if(!cancelled&&vlmAttempts)await annotateResultFile(path.join(dir,'result.json'),vlmAttempts);
      return finish(analysisId,lease.token,outcome.value,cancelled?undefined:vlmAttempts);
     });entry.settled.catch(()=>{});return entry.settled;
    };
    const child=handle.identity??await analysisProcessIdentity(handle.pid);
    if(child.state==='alive'&&!await changeLease(lease.token,l=>({...l,phase:'running',child:{pid:child.pid,started_at:child.started_at}}))){
     settle();jobController.abort();await handle.cancel();await entry.settled;fail('LEASE_HELD','Analysis lease was lost; its owned child was stopped.');
    }
    if(handle.alive!==false)await update(analysisId,c=>({...c,state:c.state==='cancelled'?'cancelled':'running',child:child.state==='alive'?{pid:child.pid,started_at:child.started_at}:null}));
    settle();const view=await inspect(analysisId);
    if(view.state==='cancelled'){jobController.abort();await handle.cancel();await entry.settled;return inspect(analysisId);}
    return view;
   }finally{launches.delete(analysisId);if(!launched)await changeLease(lease.token,()=>null);}
  };
  const previous=pendingKeys.get(scope);if(previous){await previous.catch(()=>{});return operation();}
  const work=operation();pendingKeys.set(scope,work);try{return await work;}finally{if(pendingKeys.get(scope)===work)pendingKeys.delete(scope);}
 }
 const service={
  start(input,image,{signal,modelSelection}={}){return admit(input,image,signal,selectedModel(modelSelection));},
  async status(selector={}, {signal}={}){
   signal?.throwIfAborted();strict(selector,['analysisId','pageId','requestKey','detail']);if(selector.detail!==undefined&&typeof selector.detail!=='boolean')fail('RESULT_INVALID','Invalid detail selector.');let analysisId;
   if(Object.hasOwn(selector,'analysisId')){if(Object.hasOwn(selector,'pageId')||Object.hasOwn(selector,'requestKey'))fail('RESULT_INVALID','Choose one analysis selector.');analysisId=id(selector.analysisId);}
   else{const found=await index(keyOf(selector.pageId,selector.requestKey));if(!found)return{analysis_id:null,status:'not_started',state:'not_started'};analysisId=found.analysis_id;}
   return inspect(analysisId,selector.detail??false);
  },
  async result({analysisId}={}, {signal}={}){signal?.throwIfAborted();return inspect(id(analysisId),false,true);},
  async wait({analysisId}={}, {signal,timeoutMs=30000}={}){
   id(analysisId);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)fail('RESULT_INVALID','Invalid wait duration.');const deadline=Date.now()+timeoutMs;
   while(true){signal?.throwIfAborted();const owned=active.get(analysisId);if((owned?.outcome||owned?.lost)&&owned?.settled)await owned.settled.catch(()=>{});let value=await inspect(analysisId);if((owned?.outcome||owned?.lost)&&owned?.settled){await owned.settled.catch(()=>{});value=await inspect(analysisId);}if(!['running','claimed'].includes(value.state))return value;if(Date.now()>=deadline)return{...value,wait_timed_out:true};await delay(Math.min(25,deadline-Date.now()),undefined,{signal});}
  },
  async cancel({analysisId}={}, {signal}={}){
   signal?.throwIfAborted();const {dir,c}=await load(id(analysisId));
   // Worker output is not cancellation authority. A live owned handle remains
   // stoppable even when its receipt is malformed, foreign or oversized.
   const stoppable=()=>{const owned=active.get(analysisId);return owned&&!owned.outcome&&!owned.lost?owned:null;};
   if(!stoppable()&&['succeeded','degraded','failed','not_ready','cancelled'].includes(c.state))return inspect(analysisId);
   signal?.throwIfAborted();
   await atomic(path.join(dir,'cancel.requested'),Buffer.from(now()),true);await update(analysisId,current=>({...current,state:'cancelled'}));
   // The launch->active handoff runs without an await, and `launches` is only cleared in the
   // operation's own finally, so at least one of them is present in every state after the
   // writes above. Re-read both instead of trusting the handle observed before them.
   const giveUp=Date.now()+200;
   for(;;){
    launches.get(analysisId)?.abort();
    const owned=stoppable();
    if(owned){owned.controller?.abort();await owned.handle.cancel();await owned.settled;break;}
    if(!launches.has(analysisId)||Date.now()>=giveUp)break;
    await delay(1);
   }
   return inspect(analysisId);
  },
  async recordProposal({analysisId,pageId,proposalId,submittedRevision}={}){
   id(analysisId);id(pageId);id(proposalId);if(!Number.isSafeInteger(submittedRevision)||submittedRevision<1)fail('RESULT_INVALID','Invalid proposal revision.');
   const result=await service.result({analysisId},{});if(result.pageId!==pageId||!['succeeded','degraded'].includes(result.state)||submittedRevision<=result.baseRevision)fail('CONFLICT','Proposal receipt does not match this analysis.');
   const receipt={page_id:pageId,proposal_id:proposalId,submitted_revision:submittedRevision};
   const claim=await update(analysisId,c=>{if(c.proposal&&digest(c.proposal)!==digest(receipt))fail('CONFLICT','Analysis already has a different proposal receipt.');if(c.proposal)return null;c.proposal=receipt;return c;});return structuredClone(claim.proposal);
  },
 };
 return Object.freeze(service);
}
