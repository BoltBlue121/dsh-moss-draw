import {spawn} from 'node:child_process';
import {open,readFile,realpath,lstat,mkdir,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';

const CAP=65536,bridgeScript=fileURLToPath(new URL('../worker/gbc/bridge.py',import.meta.url));
const systemEnv=['SystemRoot','WINDIR','PATH','PATHEXT','TEMP','TMP','HOME','USERPROFILE','LOCALAPPDATA'];
const fixedEnv={HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',PYTHONUNBUFFERED:'1'};
const reservedEnv=new Set([...systemEnv,...Object.keys(fixedEnv),'PYTHONPATH','PYTHONHOME'].map(key=>key.toUpperCase()));
const fault=(code,message)=>Object.assign(new Error(message),{code:`STUDIO_ANALYSIS_${code}`});
const ENV_NAME=/^[A-Z_][A-Z0-9_]{0,127}$/;
// Trusted marker for "no child was ever created": the caller may release its lease and
// retry. Never inferred from an error name; only this module sets the code.
const notStarted=reason=>Object.assign(new Error('Analysis runtime was cancelled before its process started.'),{code:'STUDIO_ANALYSIS_NOT_STARTED',cause:reason});
const absolute=p=>typeof p==='string'&&path.isAbsolute(p)&&!p.includes('\0');
const equalPath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const within=(root,p)=>{const rel=path.relative(root,p);return rel!==''&&!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${path.sep}`);};
function checkedExtraEnv(extraEnv){
 if(extraEnv===undefined)return{};
 if(!extraEnv||typeof extraEnv!=='object'||Array.isArray(extraEnv))throw fault('NO_CONFIG','Trusted analysis environment is invalid.');
 const keys=Object.keys(extraEnv);let total=0;
 if(keys.length>16)throw fault('NO_CONFIG','Trusted analysis environment is too large.');
 const env=Object.create(null);
 for(const key of keys){
  const value=extraEnv[key];
  if(!ENV_NAME.test(key)||reservedEnv.has(key)||typeof value!=='string'||!value.length||value.includes('\0')||Buffer.byteLength(value)>CAP)throw fault('NO_CONFIG','Trusted analysis environment is invalid.');
  total+=Buffer.byteLength(key)+Buffer.byteLength(value);
  if(total>CAP)throw fault('NO_CONFIG','Trusted analysis environment is too large.');
  env[key]=value;
 }
 return env;
}
function redactBytes(data,values){
 let output=data;
 for(const value of values){
  if(typeof value!=='string'||!value.length)continue;
  const needle=Buffer.from(value),parts=[];let offset=0,index;
  while((index=output.indexOf(needle,offset))!==-1){parts.push(output.subarray(offset,index),Buffer.from('[REDACTED]'));offset=index+needle.length;}
  if(parts.length){parts.push(output.subarray(offset));output=Buffer.concat(parts);}
 }
 return output;
}
async function regular(p){const s=await lstat(p);if(!s.isFile()||s.isSymbolicLink())throw fault('NO_CONFIG','A required regular file is unavailable.');return s;}
async function atomic(file,bytes){await mkdir(path.dirname(file),{recursive:true});const temp=`${file}.${randomUUID()}.tmp`,h=await open(temp,'wx',0o600);try{await h.writeFile(bytes);await h.sync();}finally{await h.close();}try{await rename(temp,file);}finally{await unlink(temp).catch(e=>{if(e.code!=='ENOENT')throw e;});}}
const systemTool=name=>path.join(process.env.SystemRoot??'C:\\Windows','System32',name);
function helper(command,args){return new Promise(resolve=>{
 let output='',done=false;const child=spawn(command,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','ignore']});
 const end=code=>{if(done)return;done=true;clearTimeout(timer);resolve({code,output});};
 const timer=setTimeout(()=>{child.kill();end(null);},5000);
 child.stdout.on('data',b=>{output+=b.toString('utf8');if(output.length>8192){child.kill();end(null);}});
 child.on('error',()=>end(null));child.on('close',code=>end(code));
});}

/** Mutation-path only: never call from public status/wait/result. Unknown is not death. */
export async function analysisProcessIdentity(pid){
 if(!Number.isSafeInteger(pid)||pid<1)return{state:'unknown'};
 try{process.kill(pid,0);}catch(e){return{state:e.code==='ESRCH'?'dead':'unknown'};}
 if(process.platform==='win32'){
  const executable=systemTool(path.join('WindowsPowerShell','v1.0','powershell.exe'));
  const script=`$ErrorActionPreference='Stop';$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}';if($null -eq $p){exit 3};[Console]::Write($p.CreationDate.ToUniversalTime().Ticks)`;
  const result=await helper(executable,['-NoProfile','-NonInteractive','-Command',script]);
  if(result.code===3)return{state:'dead'};
  if(result.code===0&&/^\d{12,24}$/.test(result.output.trim()))return{state:'alive',pid,started_at:result.output.trim()};
  return{state:'unknown'};
 }
 if(process.platform==='linux'){
  try{const raw=await readFile(`/proc/${pid}/stat`,'utf8'),fields=raw.slice(raw.lastIndexOf(')')+2).split(' ');if(fields[0]==='Z')return{state:'dead'};return{state:'alive',pid,started_at:fields[19]};}catch(e){return{state:e.code==='ENOENT'?'dead':'unknown'};}
 }
 return{state:'unknown'};
}

// credentials.resolve has no signal parameter. Stop awaiting on abort, and
// consume any late resolution/rejection without ever starting its child.
async function resolveBeforeSpawn(resolveCredential,ref,signal){
 if(!signal)return resolveCredential(ref);
 const stop=()=>notStarted(signal.reason);
 if(signal.aborted)throw stop();let abort;
 const stopped=new Promise((_,reject)=>{abort=()=>reject(stop());signal.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([Promise.resolve().then(()=>{if(signal.aborted)throw stop();return resolveCredential(ref);}),stopped]);}
 finally{signal.removeEventListener('abort',abort);}
}

// Redact before the tail cap, retaining only a possible cross-chunk match prefix.
// This prevents a cap boundary from retaining an unredacted suffix of a full key.
function privateLog(values){
 let needles=[...new Set(values.filter(value=>typeof value==='string'&&value.length))].map(value=>Buffer.from(value));
 const overlap=Math.max(0,...needles.map(value=>value.length-1));
 let pending=Buffer.alloc(0),marked=Buffer.alloc(0),output=Buffer.alloc(0),seen=0,truncated=false,masked=false;
 const retain=data=>{const joined=Buffer.concat([output,data]);truncated||=joined.length>CAP;output=joined.length>CAP?Buffer.from(joined.subarray(joined.length-CAP)):joined;};
 const consume=(data,final)=>{
  const joined=Buffer.concat([pending,data]),flags=Buffer.alloc(joined.length);marked.copy(flags);
  for(const needle of needles)for(let i=joined.indexOf(needle);i!==-1;i=joined.indexOf(needle,i+1))flags.fill(1,i,i+needle.length);
  const end=final?joined.length:Math.max(0,joined.length-overlap);let start=0;
  for(let i=0;i<end;i++){
   if(flags[i]){if(!masked){retain(joined.subarray(start,i));retain(Buffer.from('[REDACTED]'));masked=true;}start=i+1;}
   else if(masked){masked=false;start=i;}
  }
  if(!masked)retain(joined.subarray(start,end));
  pending=Buffer.from(joined.subarray(end));marked=Buffer.from(flags.subarray(end));
 };
 return{push(data){seen=Math.min(CAP+1,seen+data.length);truncated||=seen>CAP;consume(data,false);},finish(){consume(Buffer.alloc(0),true);needles=[];pending=marked=Buffer.alloc(0);return output;},get truncated(){return truncated;}};
}

export function createAnalysisRunner({python,configPath,jobRoot,timeoutMs=180000,resolveCredential,extraEnv}={}){
 if(![python,configPath,jobRoot].every(absolute)||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000||resolveCredential!==undefined&&typeof resolveCredential!=='function')throw fault('NO_CONFIG','Trusted analysis runtime configuration is invalid.');
 const trustedEnv=checkedExtraEnv(extraEnv);
 return{async start({requestPath,resultPath},{signal}={}){
  const stopPreSpawn=()=>{if(signal?.aborted)throw notStarted(signal.reason);};
  stopPreSpawn();let config;
  try{
   if(![requestPath,resultPath].every(absolute)||path.basename(requestPath)!=='request.json'||path.basename(resultPath)!=='result.json'||path.dirname(requestPath)!==path.dirname(resultPath))throw Error();
   const root=await realpath(jobRoot),job=await realpath(path.dirname(requestPath));
   if(!within(root,job)||!equalPath(job,path.resolve(path.dirname(requestPath))))throw Error();
   for(const p of [python,configPath,bridgeScript,requestPath]){await regular(p);if(!equalPath(await realpath(p),path.resolve(p)))throw Error();}
   try{await lstat(resultPath);throw Error();}catch(e){if(e.code!=='ENOENT')throw e;}
   const info=await regular(configPath);if(info.size>65536)throw Error();config=JSON.parse(await readFile(configPath,'utf8'));
  }catch{throw fault('NO_CONFIG','Analysis runtime files or job paths are unavailable.');}
  stopPreSpawn();const env={};
  for(const key of systemEnv)if(process.env[key]!==undefined)env[key]=process.env[key];
  const credential=config?.vlm?.api_key_env;let secret;
  // A Host-supplied literal value is already the resolved credential for that exact name.
  // It is trusted caller input, so it must not also be looked up in the credential store.
  const literalCredential=typeof credential==='string'&&Object.hasOwn(trustedEnv,credential)?credential:undefined;
  if(credential!==undefined&&literalCredential===undefined&&Object.keys(trustedEnv).some(key=>key.toUpperCase()===String(credential).toUpperCase()))throw fault('NO_CONFIG','Analysis environment collides with its credential.');
  if(credential!==undefined&&literalCredential===undefined){
    if(typeof credential!=='string'||!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(credential)||reservedEnv.has(credential.toUpperCase()))throw fault('NO_CONFIG','Analysis credential reference is invalid.');
    try{
     // The Host SDK returns {value,source}; a configured resolver is authoritative.
     // Never fall back to an ambient value after a missing/failed store lookup.
     secret=resolveCredential?(await resolveBeforeSpawn(resolveCredential,credential,signal))?.value:process.env[credential];
     if(secret!==undefined||resolveCredential){if(typeof secret!=='string'||!secret.length||secret.includes('\0')||Buffer.byteLength(secret)>CAP)throw Error();env[credential]=secret;}
    }catch(e){if(e?.code==='STUDIO_ANALYSIS_NOT_STARTED')throw e;stopPreSpawn();throw fault('NO_CONFIG','Analysis credential is unavailable.');}
   }
   stopPreSpawn();
  Object.assign(env,fixedEnv);
  for(const key of Object.keys(trustedEnv))env[key]=trustedEnv[key];
  const child=spawn(python,['-X','utf8','-I',bridgeScript,'--request',requestPath,'--result',resultPath,'--config',configPath,'--watchdog-seconds',String(Math.ceil(timeoutMs/1000)+20)],{shell:false,windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env});
  let exited=false,timedOut=false,identity={state:'unknown'},stop;
  const extraSecrets=Object.values(trustedEnv);
  const secrets=[secret,...extraSecrets],stdout=privateLog(secrets),stderr=privateLog(secrets);

  child.stdout.on('data',b=>stdout.push(b));
  child.stderr.on('data',b=>stderr.push(b));
  const spawned=new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',()=>reject(fault('RUNNER_FAILED','Analysis process could not start.')));});
  let exitResolve;const exit=new Promise(resolve=>{exitResolve=resolve;});
  child.once('close',(exitCode,exitSignal)=>{exited=true;exitResolve({exitCode,signal:exitSignal,timedOut});});
  const terminate=()=>stop??=(async()=>{
   if(exited)return;
   const current=await analysisProcessIdentity(child.pid);
   if(exited)return;
   if(identity.state!=='alive'||current.state!=='alive'||current.started_at!==identity.started_at)throw fault('LEASE_HELD','Managed child identity cannot be confirmed.');
   if(process.platform==='win32'){
    const result=await helper(systemTool('taskkill.exe'),['/PID',String(child.pid),'/T','/F']);
    if(result.code!==0&&!exited)throw fault('LEASE_HELD','Managed child could not be stopped safely.');
   }else process.kill(-child.pid,'SIGKILL');
   await exit;
  })();
  let timer,abort;
  const done=exit.then(async value=>{
   clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort);
   const logs=path.join(path.dirname(requestPath),'logs');
   try{await atomic(path.join(logs,'stdout.log'),stdout.finish());await atomic(path.join(logs,'stderr.log'),stderr.finish());}catch{value.logWriteFailed=true;}
   return{...value,stdoutTruncated:stdout.truncated,stderrTruncated:stderr.truncated};
  });
  try{await spawned;}catch(e){await done;throw e;}
  // Capture exact creation identity while this process is owned; never synthesize it from PID.
  identity=await analysisProcessIdentity(child.pid);
  if(!exited){
   timer=setTimeout(()=>{timedOut=true;terminate().catch(()=>{});},timeoutMs);
   abort=()=>{terminate().catch(()=>{});};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  }
  return{pid:child.pid,identity,get alive(){return !exited;},done,cancel:async()=>{await terminate();await done;}};
 }};
}
