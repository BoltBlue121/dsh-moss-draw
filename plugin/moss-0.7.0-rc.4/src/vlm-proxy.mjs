import {createServer} from 'node:http';
import {randomBytes,randomUUID,timingSafeEqual,createHash} from 'node:crypto';

const IMAGE_TYPES=new Set(['image/png','image/jpeg','image/webp','image/gif']);
class ProxyError extends Error{constructor(status,code){super(code);this.status=status;this.code=code;}}
const validSelection=v=>v&&typeof v.provider==='string'&&v.provider.length>0&&v.provider.length<=128&&typeof v.model==='string'&&v.model.length>0&&v.model.length<=256&&!/[\u0000-\u001f]/.test(v.provider+v.model);
const bounded=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
function abortable(work,signal){
 if(signal.aborted)return Promise.reject(signal.reason);
 return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});Promise.resolve(work).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
function dataImage(url){
 const m=typeof url==='string'&&/^data:([a-z0-9.+/-]+);base64,([A-Za-z0-9+/=\r\n]+)$/i.exec(url);
 if(!m||!IMAGE_TYPES.has(m[1].toLowerCase()))throw new ProxyError(400,'unsupported_image');
 const data=Buffer.from(m[2],'base64');if(!data.length)throw new ProxyError(400,'unsupported_image');
 return{data:new Uint8Array(data),mediaType:m[1].toLowerCase()};
}

/** One immutable caller route and one authenticated loopback job; never stores credentials. */
export async function createHostVlmProxy({attachments,llm,selection,fallbackModel,logger,signal,timeoutMs=60000,maxInflight=4,maxQueued=8,maxBodyBytes=8*1024*1024,maxOutputBytes=1024*1024,maxImages=128,closeTimeoutMs=1000}={}){
 if(!attachments||typeof attachments.saveImage!=='function'||!llm||typeof llm.prepareCall!=='function')throw new Error('MOSS_VLM_PROXY_CONFIG');
 if(!bounded(timeoutMs,1,600000)||!bounded(maxInflight,1,64)||!bounded(maxQueued,0,64)||!bounded(maxBodyBytes,1,8*1024*1024)||!bounded(maxOutputBytes,1,2*1024*1024)||!bounded(maxImages,1,256)||!bounded(closeTimeoutMs,1,5000))throw new Error('MOSS_VLM_PROXY_CONFIG');
 let selected;try{selected=typeof selection==='function'?selection():selection;}catch{}
 if(!validSelection(selected))selected=fallbackModel;
 if(!validSelection(selected))throw new Error('MOSS_VLM_PROXY_MODEL_UNAVAILABLE');
 const model=Object.freeze({provider:selected.provider,model:selected.model,...(typeof selected.reasoningEffort==='string'?{reasoningEffort:selected.reasoningEffort}:{}),...(typeof selected.sessionId==='string'?{sessionId:selected.sessionId}:{})});
 const route={provider:model.provider,model:model.model,...(model.reasoningEffort?{reasoningEffort:model.reasoningEffort}:{})};
 const preflight=new AbortController(),preflightAbort=()=>preflight.abort(new ProxyError(499,'aborted'));
 signal?.addEventListener('abort',preflightAbort,{once:true});if(signal?.aborted)preflightAbort();
 const preflightTimer=setTimeout(()=>preflight.abort(new ProxyError(504,'timeout')),timeoutMs);
 try{const prepared=await abortable(llm.prepareCall({...route,maxTokens:4096},preflight.signal),preflight.signal);if(!prepared?.inputModalities?.includes('image')||typeof prepared.stream!=='function')throw Error();}
 catch{throw new Error('MOSS_VLM_PROXY_IMAGE_UNAVAILABLE');}
 finally{clearTimeout(preflightTimer);signal?.removeEventListener('abort',preflightAbort);}
 const token=randomBytes(32).toString('hex'),expected=Buffer.from(`Bearer ${token}`),controllers=new Set(),running=new Set(),upstream=new Set(),waiters=[],images=new Map();
 let active=0,closing=false,closePromise;
 const track=p=>{const task=Promise.resolve(p);upstream.add(task);task.then(()=>upstream.delete(task),()=>upstream.delete(task));return task;};
 const send=(res,status,body)=>{if(res.destroyed||res.writableEnded)return;const data=Buffer.from(JSON.stringify(body));res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':data.length,'cache-control':'no-store','connection':'close'});res.end(data);};
 const failure=(res,status,code)=>send(res,status,{error:{code,message:code==='timeout'?'Host model call timed out.':code==='aborted'?'Host model call was aborted.':'Host model call failed.'}});
 const release=()=>{active--;while(waiters.length){const next=waiters.shift();next.cleanup();if(next.signal.aborted)continue;active++;next.resolve();break;}};
 async function withSlot(work,s){
  s.throwIfAborted();if(closing)throw new ProxyError(503,'closed');
  if(active<maxInflight)active++;
  else await new Promise((resolve,reject)=>{const entry={resolve,reject,signal:s,cleanup:()=>s.removeEventListener('abort',abort)};const abort=()=>{const i=waiters.indexOf(entry);if(i>=0)waiters.splice(i,1);entry.cleanup();reject(s.reason);};waiters.push(entry);s.addEventListener('abort',abort,{once:true});if(s.aborted)abort();});
  try{s.throwIfAborted();if(closing)throw new ProxyError(503,'closed');return await work();}finally{release();}
 }
 async function readBody(req){return new Promise((resolve,reject)=>{const chunks=[];let size=0;const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);};const error=e=>{cleanup();reject(e);},aborted=()=>error(new ProxyError(499,'aborted')),end=()=>{cleanup();resolve(Buffer.concat(chunks));},data=chunk=>{size+=chunk.length;if(size>maxBodyBytes){req.pause();error(new ProxyError(413,'request_too_large'));return;}chunks.push(chunk);};req.on('data',data);req.once('end',end);req.once('error',error);req.once('aborted',aborted);});}
 async function complete(body,s){
  if(!Array.isArray(body.messages)||body.messages.length<1||body.messages.length>128)throw new ProxyError(400,'unsupported_content');
  const system=[],messages=[];
  for(const message of body.messages){
   if(!message||!['system','user'].includes(message.role))throw new ProxyError(400,'unsupported_content');
   const parts=typeof message.content==='string'?[{type:'text',text:message.content}]:message.content;
   if(!Array.isArray(parts)||parts.length>256)throw new ProxyError(400,'unsupported_content');const content=[];
   for(const part of parts){
    s.throwIfAborted();
    if(part?.type==='text'&&typeof part.text==='string'){if(message.role==='system')system.push(part.text);else content.push({type:'text',text:part.text});continue;}
    if(message.role!=='user'||part?.type!=='image_url')throw new ProxyError(400,'unsupported_content');
    const image=dataImage(part.image_url?.url),key=createHash('sha256').update(image.mediaType).update(image.data).digest('hex');
    if(!images.has(key)){if(images.size>=maxImages)throw new ProxyError(413,'image_limit');const saved=track(attachments.saveImage({...image,name:'gbc-vlm.png'}));images.set(key,saved);saved.catch(()=>images.delete(key));}
    content.push({type:'image',attachment:await abortable(images.get(key),s)});
   }
   if(message.role==='user')messages.push({role:'user',content});
  }
  const controls={...route,maxTokens:typeof body.max_tokens==='number'&&Number.isFinite(body.max_tokens)&&body.max_tokens>=1?Math.min(Math.floor(body.max_tokens),4096):4096};
  // OpenAI/GBC sampling is not portable across native caller providers (e.g. Codex).
  // Leave temperature absent so the captured native adapter owns supported defaults.
  const prepared=await abortable(track(llm.prepareCall(controls,s)),s);s.throwIfAborted();
  if(!prepared?.inputModalities?.includes('image')||typeof prepared.stream!=='function')throw new ProxyError(503,'model_unavailable');
  const options={...prepared.config,messages,signal:s,...(model.sessionId?{sessionId:model.sessionId}:{}),...(system.length?{system:system.join('\n\n')}:{})};
  let text='',bytes=0,finish,usage=null;
  const consume=track((async()=>{
   for await(const chunk of prepared.stream(options)){
    s.throwIfAborted();
    if(chunk?.type==='text-delta'&&typeof chunk.text==='string'){bytes+=Buffer.byteLength(chunk.text);if(bytes>maxOutputBytes)throw new ProxyError(502,'output_too_large');text+=chunk.text;}
    else if(chunk?.type==='usage'&&Number.isSafeInteger(chunk.usage?.inputTokens)&&chunk.usage.inputTokens>=0&&Number.isSafeInteger(chunk.usage?.outputTokens)&&chunk.usage.outputTokens>=0){const u=chunk.usage;usage={prompt_tokens:u.inputTokens,completion_tokens:u.outputTokens,total_tokens:Number.isSafeInteger(u.totalTokens)&&u.totalTokens>=0?u.totalTokens:u.inputTokens+u.outputTokens};}
    else if(chunk?.type==='finish')finish=chunk.reason;
   }
  })());
  await abortable(consume,s);s.throwIfAborted();
  if(finish?.kind==='error'){const code=['NO_ADAPTER','MISSING_CREDENTIAL','INVALID_CREDENTIAL','AUTH','RATE_LIMIT','rate_limit','QUOTA','ACCOUNT_QUOTA','CONTEXT_WINDOW_EXCEEDED','IMAGE_OFFLOAD_REQUIRED'].includes(finish.failure?.code)?finish.failure.code:'upstream_error';throw new ProxyError(502,code);}
  if(finish?.kind==='aborted')throw new ProxyError(499,'aborted');
  if(!['stop','max-tokens'].includes(finish?.kind))throw new ProxyError(502,'invalid_finish');
  return{id:`chatcmpl-${randomUUID()}`,object:'chat.completion',created:Math.floor(Date.now()/1000),model:model.model,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:finish.kind==='max-tokens'?'length':'stop'}],usage};
 }
 async function handle(req,res){
  if(closing)return failure(res,503,'closed');
  if(req.method!=='POST'||req.url!=='/v1/chat/completions')return failure(res,req.method==='POST'?404:405,'not_found');
  const actual=Buffer.from(typeof req.headers.authorization==='string'?req.headers.authorization:'');
  if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return failure(res,401,'unauthorized');
  if(Number(req.headers['content-length'])>maxBodyBytes)return failure(res,413,'request_too_large');
  if(controllers.size>=maxInflight+maxQueued)return failure(res,429,'queue_full');
  const controller=new AbortController(),s=controller.signal;controllers.add(controller);
  const disconnected=()=>{if(!res.writableEnded)controller.abort(new ProxyError(499,'aborted'));};res.once('close',disconnected);req.once('aborted',disconnected);
  const timer=setTimeout(()=>controller.abort(new ProxyError(504,'timeout')),timeoutMs);
  try{
   const result=await withSlot(async()=>{
    let body;try{const raw=await abortable(readBody(req),s);body=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch(e){if(e instanceof ProxyError)throw e;if(s.aborted)throw s.reason;throw new ProxyError(400,'invalid_json');}
    if(!body||typeof body!=='object'||Array.isArray(body))throw new ProxyError(400,'invalid_json');return complete(body,s);
   },s);send(res,200,result);
  }catch(error){const e=error instanceof ProxyError?error:s.aborted?s.reason:error;failure(res,e instanceof ProxyError?e.status:502,e instanceof ProxyError?e.code:'upstream_error');}
  finally{clearTimeout(timer);controllers.delete(controller);res.off('close',disconnected);req.off('aborted',disconnected);if(!req.complete)req.destroy();}
 }
 const server=createServer((req,res)=>{const work=handle(req,res).catch(()=>failure(res,502,'upstream_error'));running.add(work);work.finally(()=>running.delete(work));});
 server.on('clientError',(_error,socket)=>socket.destroy());
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
 server.on('error',()=>{try{logger?.warn?.('host_vlm_proxy_error');}catch{}});
 const close=()=>{
  if(closePromise)return closePromise;closing=true;signal?.removeEventListener('abort',onAbort);
  for(const c of controllers)c.abort(new ProxyError(499,'aborted'));
  closePromise=(async()=>{const closed=new Promise(resolve=>server.close(resolve));server.closeIdleConnections?.();await Promise.allSettled([...running]);server.closeAllConnections?.();await closed;
   let timer;await Promise.race([Promise.allSettled([...upstream]),new Promise(resolve=>{timer=setTimeout(resolve,closeTimeoutMs);})]);clearTimeout(timer);return{quiescent:upstream.size===0};})();return closePromise;
 };
 const baseUrl=`http://127.0.0.1:${server.address().port}`;
 const onAbort=()=>{void close();};signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)onAbort();
 return{baseUrl,token,mode:'host-agent',close};
}
