import test from 'node:test';
import assert from 'node:assert/strict';
import {studioConsentAuthorityFromEvents as replayEvents, registerStudioConsentAuthority} from '../src/studio-consent-authority.mjs';
const ID='11111111-1111-4111-8111-111111111111',OTHER='33333333-3333-4333-8333-333333333333',PAGE='22222222-2222-4222-8222-222222222222',D='a'.repeat(64);
const Q='采纳当前提案，人物和机位不变。\n本次不生成，额度不变。\n同意吗？';
const user=(id,text='可以',extra={})=>({type:'user/message',surfaceOp:'append',data:{id,role:'user',source:{kind:'user'},content:[{type:'text',text}],...extra}});
const call=(id='call')=>({type:'tool/call',data:{callId:id,name:'art_generate',arguments:{mode:'workbench',workbench:{action:'studioRequestConsent',page_id:PAGE,expected_revision:1,request_key:'key'}}}});
const receipt=(id='call',extra={})=>({type:'tool/result',surfaceOp:'append',data:{message:{id:'result-'+id,role:'tool',source:{kind:'tool',callId:id},toolCallId:id,isError:false,content:[{type:'text',text:JSON.stringify({consent:{consent_id:ID,page_id:PAGE,expected_revision:1,request_key:'key',question:Q,presentation_version:2,presentation_digest:D,status:'pending',...extra}})}]}}});
const say=(id,text=Q,content)=>({type:'assistant/message',surfaceOp:'append',data:{message:{id,role:'assistant',source:{kind:'model',provider:'test',model:'test'},content:content??[{type:'text',text}]}}});
const request=()=>[user('ask','请确认当前提案'),call(),receipt()];
const replay=events=>replayEvents(events.map((event,seq)=>({...event,seq})),{session_id:'recovery-native'});
const shown=()=>[...request(),say('question')];

test('natural clear confirmation with Markdown explanation and multiple native text parts authorizes only the frozen receipt',()=>{
  const bodies=[
    '我会只校准这套服设，保留人物和机位。你同意采纳这个提案吗？',
    '**确认当前提案**\n- 只采纳修改，不生成。\n\n可以吗？',
    '> '+Q.replaceAll('\n','\n> '),
    '同意吗？',
  ];
  for(const text of bodies) for(const answer of ['好','行','YES','ok!','好的。','没问题','同意']){
    const evidence=replay([...request(),say('question',text),user('reply',answer)]);
    assert.equal(evidence.decisions[ID].status,'approved',text+' / '+answer);
    assert.equal(evidence.session_id,'recovery-native');assert.equal(evidence.reply_only,true);
  }
  for(const parts of [Q.split('\n').map(text=>({type:'text',text})),[{type:'text',text:'说明：不会删除文件。\n'},{type:'text',text:Q.slice(0,12)},{type:'text',text:Q.slice(12)},{type:'text',text:'\n仅针对当前提案。'}]]){
    assert.equal(replay([...request(),say('question','',parts),user('reply')]).decisions[ID].status,'approved');
  }
});

test('another question, multiple questions, hidden question and opposite generation or run count cannot receive approval',()=>{
  const unsafe=['你想喝茶吗？','你同意喝茶吗？','同意吗？你要喝茶吗？','是否采纳？是否继续？','<!-- 同意吗？ -->','`同意吗？`','```\n'+Q+'\n```','<div>'+Q+'</div>','本次生成1张，同意吗？','采纳并继续生成，同意吗？','不生成。实际生成一张，同意吗？'];
  for(const text of unsafe) assert.notEqual(replay([...request(),say('q',text),user('reply','好')]).decisions[ID]?.status,'approved',text);
  const generating='采纳当前提案。\n增加2次Moss额度，继续生成2次。\n同意吗？';
  for(const text of ['增加3次Moss额度，继续生成3次。同意吗？','本次不生成，同意吗？'])assert.notEqual(replay([user('ask'),call(),receipt('call',{question:generating}),say('q',text),user('reply','ok')]).decisions[ID]?.status,'approved',text);
});

test('only never-answered invalid display can rearm the same receipt, including after a failed short answer',()=>{
  for(const before of [[say('bad','正在整理。')],[say('bad','正在整理。'),user('too-early','同意')]]){
    const evidence=replay([...request(),...before,call('retry'),receipt('retry'),say('question','只采纳当前提案，不生成，可以吗？'),user('reply','行')]);
    assert.equal(evidence.decisions[ID].status,'approved');assert.equal(evidence.decisions[ID].question_message_id,'question');
  }
});

test('answered, invalidated-after-answer, displayed-then-displaced and superseded receipts never rearm',()=>{
  const histories=[...['同意','取消','可以，但不生成','先等等'].map(answer=>[...shown(),user('first',answer)]),[...shown(),user('first'),user('later','新消息')],[...shown(),say('other','你想喝茶吗？')],[...request(),say('bad','整理中'),call('other'),receipt('other',{consent_id:OTHER})]];
  for(const history of histories){const evidence=replay([...history,call('retry'),receipt('retry'),say('q2'),user('second')]);assert.notEqual(evidence.decisions[ID]?.status,'approved');}
});

test('reply_only blocks qualified and ambiguous replies; fresh drawing requests exit pending',()=>{
  // With a displayed pending receipt, negative/ambiguous text is reply_only=true; without one, it's a new instruction (reply_only=false).
  for(const text of ['不同意，别画','不画了','先别画','可以，但不要画','可以，但不生成','画面不要变','按之前画的来','是否可以画？','继续','先等等','画','不要只生成一张','画得不对']){
    const withPending=replay([...shown(),user('reply',text)]);assert.equal(withPending.reply_only,true,text);assert.notEqual(withPending.decisions[ID].status,'approved',text);
    const noPending=replay([user('bare',text)]);assert.equal(noPending.reply_only,false,text);
  }
  for(const text of ['帮我画一只猫','请生成一张海边日落图','用K2画一只白色的杯子','Please draw a red cat']){
    assert.equal(replay([user('direct',text)]).reply_only,false,text);
    const evidence=replay([...shown(),user('direct',text)]);assert.equal(evidence.reply_only,false,text);assert.notEqual(evidence.decisions[ID].status,'approved');
  }
  assert.equal(replay([user('ask','请整理这份方案')]).reply_only,false);
  for(const text of ['好','同意','取消','no']){
    const withPending=replay([...shown(),user('bare',text)]);assert.equal(withPending.reply_only,true,text);
    // Without a displayed question a bare yes is fresh chat authority; a bare refusal never is.
    const bare=replay([user('bare',text)]);assert.equal(bare.reply_only,['取消','no'].includes(text),text);
  }
});

test('a paraphrase cannot hide a larger added allowance behind a smaller count or unchanged-budget claim',()=>{
 const q='增加3次Moss额度（总5次，已用1次）；本次不生成。\n同意吗？';
 for(const text of ['增加1次Moss额度，本次不生成，可以吗？','采纳当前方案，额度不变，本次不生成，可以吗？']){
  const evidence=replay([user('ask'),call(),receipt('call',{question:q}),say('q',text),user('reply','同意')]);
  assert.notEqual(evidence.decisions[ID]?.status,'approved',text);
 }
});
test('explicit fresh drawing requests may preserve costume or background constraints without becoming consent replies',()=>{
 for(const text of ['请画一只猫，不要改变背景','帮我再画一张海边日落图，但不要添加人物','Please draw a white cup without changing the background']){
  const evidence=replay([...shown(),user('new',text)]);assert.equal(evidence.reply_only,false,text);assert.notEqual(evidence.decisions[ID]?.status,'approved');
 }
});
test('preserving unrelated details does not negate generation and budget nouns are not execution promises',()=>{
 const generating='采纳当前提案。\n保留现有Moss额度，继续生成1次。\n同意吗？';
 const good=replay([user('ask'),call(),receipt('call',{question:generating}),say('q','保持人物不变并生成一张，可以吗？'),user('reply','好')]);
 assert.equal(good.decisions[ID].status,'approved');
 const noImage=replay([...request(),say('q','采纳当前提案，本次不生成图片，生成额度不变，可以吗？'),user('reply','好')]);
 assert.equal(noImage.decisions[ID].status,'approved');
 const contradicted=replay([user('ask'),call(),receipt('call',{question:generating}),say('q','采纳当前提案，不出新图，可以吗？'),user('reply','好')]);
 assert.notEqual(contradicted.decisions[ID].status,'approved');
});
test('v4 checkpoint strictly validates reply_only text_only and nonrevivable recovery provenance',()=>{
  let def;registerStudioConsentAuthority({register:value=>{def=value;},stateOf:()=>null});assert.equal(def.stateVersion,4);
  let state=def.init({id:'recovery-native'},0);for(const [seq,event] of [...request(),say('bad','整理中')].entries())state=def.apply(state,{...event,seq});
  const saved=def.stateSchema.parse(JSON.parse(JSON.stringify(state)));assert.equal(saved.reply_only,false);assert.equal(saved.text_only,false);
  for(const value of [undefined,0,1,'false',null]){const bad=structuredClone(saved);if(value===undefined)delete bad.reply_only;else bad.reply_only=value;assert.throws(()=>def.stateSchema.parse(bad),/STUDIO_CONSENT_HISTORY/);}
  for(const value of [undefined,0,1,'false',null]){const bad=structuredClone(saved);if(value===undefined)delete bad.text_only;else bad.text_only=value;assert.throws(()=>def.stateSchema.parse(bad),/STUDIO_CONSENT_HISTORY/);}
  for(const [seq,event] of [call('retry'),receipt('retry'),say('question'),user('reply','好')].entries())state=def.apply(saved.last_seq===state.last_seq?saved:state,{...event,seq:seq+saved.last_seq+1});
  assert.equal(state.decisions[ID].status,'approved');
  assert.doesNotThrow(()=>def.stateSchema.parse(JSON.parse(JSON.stringify(state))));
});
