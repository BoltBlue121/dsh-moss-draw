// Host-only native history projection. No transcript scanning, DB writes or wire view.
const KEY='moss-draw.layout-evidence',MAX=128;
const id=v=>typeof v==='string'&&v.length>0&&v.length<=200;
const uuid=v=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const seq=v=>Number.isSafeInteger(v)&&v>=0;
const binding=v=>v&&uuid(v.plan_id)&&uuid(v.page_id)&&/^[a-f0-9]{64}$/.test(v.digest)&&Number.isSafeInteger(v.page_revision)&&v.page_revision>0;
const fail=()=>{throw Object.assign(Error('Native Layout preview evidence is unavailable.'),{code:'STUDIO_LAYOUT_PREVIEW_REQUIRED'});};
const trim=value=>Object.fromEntries(Object.entries(value).slice(-MAX));
const initial=(header,inherited=0)=>{if(!id(header?.id)||!seq(inherited))fail();return{session_id:header.id,inherited_count:inherited,last_seq:-1,pending:{},execute:{},receipts:{}};};
function apply(state,event){
 if(!seq(event?.seq)||event.seq<=state.last_seq)fail();let next={...state,last_seq:event.seq};
 if(event.seq<state.inherited_count)return next;
 if(['turn/start','turn/end','step/start','step/end'].includes(event.type))return{...next,pending:{},execute:{}};
 if(event.type==='tool/call'){
  const c=event.data;if(c?.name!=='art_generate'||!id(c.callId)||event.surfaceOp!==undefined||event.sourceEventSeqs!==undefined)return next;
  let input;try{input=JSON.parse(c.arguments);}catch{return next;}if(input?.mode!=='workbench')return next;const w=input.workbench;
  if(w?.action==='studioPrepare'&&uuid(w.page_id)&&Number.isSafeInteger(w.expected_revision))return{...next,pending:trim({...state.pending,[c.callId]:{page_id:w.page_id,page_revision:w.expected_revision,call_seq:event.seq,turn:c.turn,step:c.step}})};
  if(w?.action==='studioExecute'&&uuid(w.plan_id))return{...next,execute:trim({...state.execute,[c.callId]:{plan_id:w.plan_id,call_seq:event.seq}})};
  return next;
 }
 if(event.type!=='tool/result'||event.surfaceOp!=='append')return next;
 const m=event.data?.message;if(m?.role!=='tool'||m.source?.kind!=='tool'||m.source.callId!==m.toolCallId||!Object.hasOwn(state.pending,m.toolCallId))return next;
 const call=state.pending[m.toolCallId],pending={...state.pending};delete pending[m.toolCallId];next={...next,pending};
 if(event.sourceEventSeqs!==undefined&&(!Array.isArray(event.sourceEventSeqs)||event.sourceEventSeqs.length!==1||event.sourceEventSeqs[0]!==call.call_seq))return next;
 if(m.isError||event.data.error||call.turn!==event.data.turn||call.step!==event.data.step||call.call_seq>=event.seq||!Array.isArray(m.content))return next;
 if(!m.content.some(p=>p.type==='image'&&!p.offloaded&&id(p.attachment?.attachmentId)&&p.attachment.mediaType==='image/png'&&p.attachment.width>0&&p.attachment.height>0))return next;
 for(const part of m.content){if(part.type!=='text'||typeof part.text!=='string'||part.text.length>2*1024*1024)continue;let value;try{value=JSON.parse(part.text);}catch{continue;}
  const b=value?.preview_binding;if(value?.execution_contract!=='layout-preview-v1'||!binding(b)||b.page_id!==call.page_id||b.page_revision!==call.page_revision||['plan_id','digest','page_id','page_revision'].some(k=>b[k]!==value[k]))continue;
  const receipt={plan_id:b.plan_id,digest:b.digest,page_id:b.page_id,page_revision:b.page_revision,result_seq:event.seq};
  return{...next,receipts:trim({...state.receipts,[b.plan_id]:receipt})};
 }
 return next;
}
function parseState(value){
 if(!value||!id(value.session_id)||!seq(value.inherited_count)||!Number.isSafeInteger(value.last_seq)||value.last_seq< -1)fail();
 for(const key of ['pending','execute','receipts'])if(!value[key]||typeof value[key]!=='object'||Array.isArray(value[key])||Object.keys(value[key]).length>MAX)fail();
 for(const [key,r]of Object.entries(value.receipts))if(key!==r.plan_id||!binding(r)||!seq(r.result_seq)||r.result_seq>value.last_seq)fail();
 for(const [key,c]of Object.entries(value.pending))if(!id(key)||!uuid(c.page_id)||!seq(c.call_seq)||!Number.isSafeInteger(c.page_revision)||c.page_revision<1)fail();
 for(const [key,c]of Object.entries(value.execute))if(!id(key)||!uuid(c.plan_id)||!seq(c.call_seq))fail();
 return structuredClone(value);
}
export function registerStudioLayoutEvidence(registry){
 if(typeof registry?.register!=='function'||typeof registry.stateOf!=='function')fail();
 registry.register({key:KEY,stateVersion:1,stateSchema:{parse:parseState},init:initial,apply});
 return exec=>{const session=exec?.agent?.session,state=session&&registry.stateOf(session,KEY);if(!state||state.session_id!==session.id||state.inherited_count!==(session.inheritedEventCount??0))fail();const call=state.execute[exec.callId];return{session_id:state.session_id,call_seq:call?.call_seq??null,plan_id:call?.plan_id??null,receipts:call?Object.values(state.receipts).filter(r=>r.plan_id===call.plan_id&&r.result_seq<call.call_seq).map(r=>({...r})):[]};};
}
export function assertStudioLayoutEvidence(plan,authorization){
 if(plan.execution_contract!=='layout-preview-v1')return;
 const evidence=authorization?.layoutEvidence;
 if(!evidence||!id(evidence.session_id)||!seq(evidence.call_seq)||evidence.plan_id!==plan.plan_id||authorization?.consentEvidence?.session_id&&evidence.session_id!==authorization.consentEvidence.session_id||!Array.isArray(evidence.receipts)||!evidence.receipts.some(r=>binding(r)&&r.plan_id===plan.plan_id&&r.digest===plan.digest&&r.page_id===plan.page_id&&r.page_revision===plan.page_revision&&seq(r.result_seq)&&r.result_seq<evidence.call_seq))fail();
}
