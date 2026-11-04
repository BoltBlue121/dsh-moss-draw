import {readFile} from 'node:fs/promises';
import {resolveConfig} from './sdk.mjs';
import {MODELS,STYLES,DEFAULTS} from './catalog.mjs';

const t2iNodes=['UNETLoader','CLIPLoader','VAELoader','LoraLoaderModelOnly','ModelSamplingAuraFlow','SkipLayerGuidanceDiTSimple','CLIPTextEncode','EmptyFlux2LatentImage','KSampler','VAEDecode','SaveImage'];
const templates={'moss-edit':'moss-native-edit','k2-t2i':'k2-t2i','qwen-edit':'qwen-edit'};
const warning=(code,message)=>({code,message});
async function requirements(modes){
  const nodes=new Set(),models=[];
  for(const mode of modes){
    if(mode==='moss-t2i'){
      t2iNodes.forEach(n=>nodes.add(n));
      models.push(['UNETLoader','unet_name',MODELS[DEFAULTS.model]],['CLIPLoader','clip_name','qwen3.5_9b_w4a8_gptq.safetensors'],['VAELoader','vae_name','flux2-vae_small.safetensors'],['LoraLoaderModelOnly','lora_name',STYLES[DEFAULTS.style].file]);
    }else{
      const graph=JSON.parse(await readFile(new URL(`../templates/${templates[mode]}.json`,import.meta.url),'utf8'));
      for(const node of Object.values(graph)){
        nodes.add(node.class_type);
        for(const [key,value] of Object.entries(node.inputs))if(typeof value==='string'&&/\.(?:safetensors|gguf|ckpt|pt|bin)$/i.test(value))models.push([node.class_type,key,value]);
      }
    }
  }
  return{nodes:[...nodes],models};
}
async function boundedJson(response,maxBytes,signal){
  if(response.redirected||response.status>=300&&response.status<400){await response.body?.cancel();throw Error('CONNECTION_REDIRECT');}
  if(!response.ok){await response.body?.cancel();throw Error('CONNECTION_HTTP');}
  const length=Number(response.headers.get('content-length'));
  if(Number.isFinite(length)&&length>maxBytes){await response.body?.cancel();throw Error('CONNECTION_RESPONSE_SIZE');}
  if(!response.body)throw Error('CONNECTION_RESPONSE');
  const chunks=[];let size=0;
  for await(const chunk of response.body){signal.throwIfAborted();size+=chunk.length;if(size>maxBytes)throw Error('CONNECTION_RESPONSE_SIZE');chunks.push(Buffer.from(chunk));}
  const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CONNECTION_RESPONSE');
  return value;
}
/** Explicit, bounded, GET-only inspection. Never uploads, submits, installs or starts a model. */
export async function getConnectionDiagnostics(resolvedConfig,{signal,fetchImpl=globalThis.fetch,requiredModes=['moss-t2i'],inspectAnalysisRuntime,timeoutMs=5000,maxBytes=8*1024*1024}={}){
  const config=resolveConfig(resolvedConfig);
  if(typeof fetchImpl!=='function'||!Array.isArray(requiredModes)||requiredModes.length<1||requiredModes.length>4||requiredModes.some(m=>m!=='moss-t2i'&&!Object.hasOwn(templates,m))||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>30000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>8*1024*1024||inspectAnalysisRuntime!==undefined&&typeof inspectAnalysisRuntime!=='function')throw Error('MOSS_DIAGNOSTIC_INPUT');
  signal?.throwIfAborted();
  const configured=!!(config.analysisPython&&config.analysisConfig);
  const result={reachable:false,ready:false,missing_nodes:[],missing_models:[],warnings:[],analysis:{configured,readiness:configured?'unchecked':'unconfigured'}};
  const controller=new AbortController();let timedOut=false;
  const abort=()=>controller.abort(signal.reason);signal?.addEventListener('abort',abort,{once:true});
  let rejectStop;const stopped=new Promise((_,reject)=>{rejectStop=reject;});
  const stop=()=>rejectStop(controller.signal.reason??Error('CONNECTION_ABORTED'));
  controller.signal.addEventListener('abort',stop,{once:true});
  const timer=setTimeout(()=>{timedOut=true;controller.abort(Error('CONNECTION_TIMEOUT'));},timeoutMs);
  const wait=promise=>Promise.race([promise,stopped]);
  try{
    const required=await wait(requirements(requiredModes));
    const response=await wait(Promise.resolve().then(()=>fetchImpl(`${config.comfyUrl}/object_info`,{method:'GET',redirect:'error',signal:controller.signal})));
    const info=await wait(boundedJson(response,maxBytes,controller.signal));result.reachable=true;
    result.missing_nodes=required.nodes.filter(name=>!Object.hasOwn(info,name));
    for(const [node,field,name] of required.models){
      const values=info[node]?.input?.required?.[field]?.[0]??info[node]?.input?.optional?.[field]?.[0];
      if(!Array.isArray(values)||!values.includes(name))result.missing_models.push(`${node}.${field}: ${name}`);
    }
    result.missing_models=[...new Set(result.missing_models)].slice(0,100);
    result.ready=result.missing_nodes.length===0&&result.missing_models.length===0;
    if(config.editEngine==='legacy'&&requiredModes.includes('moss-edit')){
      result.ready=false;result.warnings.push(warning('LEGACY_EDIT_CHECK_UNSUPPORTED','This diagnostic checks the native Edit template only. Verify the existing legacy Edit installation separately.'));
    }
    if(result.missing_nodes.length||result.missing_models.length)result.warnings.push(warning('COMFY_CAPABILITY_MISSING','The existing ComfyUI is missing required nodes or model files; configure it explicitly. Nothing was installed.'));
    if(configured&&inspectAnalysisRuntime){
      try{
        const checked=await wait(Promise.resolve().then(()=>inspectAnalysisRuntime(config,{signal:controller.signal})));
        if(!['ready','not_ready','disabled','unchecked'].includes(checked?.readiness))throw Error('INVALID_DOCTOR');
        result.analysis.readiness=checked.readiness;
      }catch(error){if(controller.signal.aborted)throw error;result.analysis.readiness='not_ready';result.warnings.push(warning('ANALYSIS_CHECK_UNAVAILABLE','The read-only analysis runtime check did not complete.'));}
    }
  }catch(error){
    if(signal?.aborted)throw signal.reason??error;
    const allowed=new Set(['CONNECTION_REDIRECT','CONNECTION_HTTP','CONNECTION_RESPONSE_SIZE','CONNECTION_RESPONSE']);
    result.ready=false;result.warnings.push(warning(timedOut?'CONNECTION_TIMEOUT':allowed.has(error?.message)?error.message:'CONNECTION_UNAVAILABLE','Cannot verify the configured connection. Check the existing ComfyUI address and required capabilities; no work was submitted.'));
  }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',stop);}
  return result;
}
