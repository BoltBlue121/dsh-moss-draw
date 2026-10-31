// A manual-owner acknowledgement is only a temporary safety barrier, never
// approval evidence or authority to execute a consent/GPU operation.
export function createStudioConsentHandoff({request,getState,getLease,clientId,isPending=()=>false,publish,onPage,now=Date.now,setTimeout=globalThis.setTimeout,clearTimeout=globalThis.clearTimeout}) {
 const used=new Set();let active=true,held=null,generation=0;
 const keyOf=value=>value?.handoff?JSON.stringify([value.consent_id,value.page_id,value.expected_revision,value.handoff.nonce]):null;
 const safe=(state,consent)=>!!state.page&&!!state.draft
  &&state.page.page_id===consent.page_id&&state.draft.page_id===consent.page_id
  &&state.page.revision===consent.expected_revision&&state.draft.revision===consent.expected_revision
  &&state.page.task?.control==='manual'&&state.page.task.owner_client===clientId
  &&consent.handoff.owner_client===clientId&&!!getLease(consent.page_id)
  &&!state.dirty&&!state.busy&&!state.gestureActive&&!state.controlPending&&!state.editingBlocked
  &&!state.conflict&&!state.mergeBlocked&&!isPending();
 function release(error=null){
  const prior=held;held=null;if(prior){clearTimeout(prior.timer);prior.abort.abort();prior.finish?.();}
  if(active)publish({consentHandoffFrozen:false,consentHandoffError:error});
 }
 function observe(consent){
  if(!active)return Promise.resolve();
  const turn=++generation,current=()=>active&&generation===turn;
  const state=getState(),key=keyOf(consent);
  if(held&&(key!==held.key||consent?.status!=='awaiting_handoff'||state.page?.page_id!==held.pageId||state.page.revision!==held.revision||state.page.task?.control!=='manual'||state.page.task.owner_client!==clientId||!getLease(held.pageId)))release();
  if(!current())return Promise.resolve();
  publish({consent:consent??null});
  if(!current())return Promise.resolve();
  if(!consent||consent.status!=='awaiting_handoff'||!consent.handoff)return Promise.resolve();
  if(held?.key===key)return Promise.resolve();
  const expiry=consent.handoff.expires_at;
  const end=typeof expiry==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(expiry)?Date.parse(expiry):NaN;
  if(typeof consent.handoff.nonce!=='string'||!consent.handoff.nonce||typeof consent.consent_id!=='string'||!consent.consent_id||!Number.isSafeInteger(consent.expected_revision)||consent.expected_revision<1||!Number.isFinite(end)||end<=now()){
   publish({consentHandoffError:'交接凭据无效或已过期；未发送回执，等待后台更新交接凭据。批准范围未变时无需重复同意。'});return Promise.resolve();
  }
  if(used.has(consent.handoff.nonce))return Promise.resolve();
  const latest=getState();
  if(!safe(latest,consent)){
   publish({consentHandoffError:latest.dirty||latest.conflict||latest.mergeBlocked?'本地稿尚未安全同步；未交接或覆盖。保存会改变版本，请重新确认。':'等待原编辑窗口空闲且版本一致；不会强制接管。'});return Promise.resolve();
  }
  used.add(consent.handoff.nonce);
  const slot={key,pageId:consent.page_id,revision:consent.expected_revision,abort:new AbortController(),timer:null,finish:null};held=slot;
  const expired=new Promise(resolve=>{slot.finish=resolve;});
  slot.timer=setTimeout(()=>{if(held===slot)release('交接等待已超时，编辑已解冻；此 nonce 不会重试。');},Math.min(15000,end-now()));
  publish({consentHandoffFrozen:true,consentHandoffError:null});
  if(!current()||held!==slot)return Promise.resolve();
  const fields={consent_id:consent.consent_id,page_id:consent.page_id,expected_revision:consent.expected_revision,nonce:consent.handoff.nonce,client_id:clientId,lease_token:getLease(consent.page_id)};
  const pending=(async()=>{
   try{
    const result=await request('studioConsentHandoff',fields,slot.abort.signal);
    if(!active||held!==slot)return;
    if(result?.consent?.consent_id!==consent.consent_id||result.consent.page_id!==consent.page_id)throw Error('STUDIO_CONSENT_RESPONSE: 交接响应与当前确认不匹配');
    const current=getState();
    if(current.page?.page_id!==slot.pageId||current.page.revision!==slot.revision||current.dirty||current.gestureActive||current.conflict||current.mergeBlocked||isPending())throw Error('STUDIO_CONSENT_STALE: 本地状态已变化，忽略交接回执');
    const replyGeneration=generation;
    if(result.page)onPage(result.page,slot.pageId,slot.revision);
    if(!active||held!==slot||generation!==replyGeneration)return;
    if(result.consent.status!=='awaiting_handoff')release();
    if(!active||generation!==replyGeneration)return;
    publish({consent:result.consent});
   }catch(error){if(active&&held===slot)publish({consentHandoffError:`交接未完成：${error.message??error}。不重发此 nonce；原稿保留，最多15秒后解除临时阻止。`});}
  })();
  return Promise.race([pending,expired]);
 }
 return {observe,clear(){const turn=++generation;release();if(active&&generation===turn)publish({consent:null});},dispose(){if(!active)return;active=false;generation++;release();used.clear();publish({consentHandoffFrozen:false,consentHandoffError:null});},isFrozen:()=>!!held};
}

export function studioConsentStatusText(status){
 return ({pending:'等待对话确认',presented:'等待对话确认',approved:'对话已批准',awaiting_handoff:'等待安全交接',applied:'已应用',stale:'确认已失效',expired:'确认已过期',rejected:'已拒绝',cancelled:'已取消',superseded:'已被新确认替代'})[status]??String(status??'未知状态');
}
