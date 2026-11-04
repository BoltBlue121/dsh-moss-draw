import {studioConsentStatusText} from './studio-consent.mjs';

const STAGES={reviewed:'已记录实图审查',delivered:'已交付',prepared:'计划已冻结',planning:'构图与提示词',ready:'计划已冻结',generating:'生成中',running:'生成中',reviewing:'等待审图',succeeded:'生成已完成',failed:'执行失败',abandoned:'人工封存（结果未明）',unknown:'状态待对账',editing:'人工微调',paused:'已暂停',awaiting_review:'等待你审查'};
export function createStudioTaskView(React){
 const h=React.createElement;
 function ResultImage({model,runId}){const[image,setImage]=React.useState(null),[error,setError]=React.useState('');React.useEffect(()=>{let live=true;model.loadTaskImage(runId).then(value=>{if(live)setImage(value);}).catch(e=>{if(live)setError(String(e.message??e));});return()=>{live=false;};},[model,runId]);return image?h('img',{src:image.data_url,alt:'此版本实际生成结果',className:'mps-task-image'}):h('small',{className:'mps-muted'},error||'正在读取结果图片…');}
 return function TaskPanel({model,state}){
  const[notice,setNotice]=React.useState(''),task=state.page?.task;
   const consent=state.consent?.page_id===state.page?.page_id?state.consent:null;
   const question=String(consent?.question??''),legacyLong=[...question].length>300;
    const consentPanel=consent?h('section',{'aria-label':'工作台对话确认',className:'mps-proposal'},h('h3',null,`对话确认 · ${studioConsentStatusText(consent.status)}`),
    state.consentHandoffFrozen?h('p',{role:'status'},'正在安全交接，暂时停止编辑；应用完成或最多15秒后自动解除。'):null,
    state.consentHandoffError?h('p',{role:'status'},state.consentHandoffError):null,
    h('p',{'aria-label':'对话确认规范块',style:{whiteSpace:'pre-wrap',lineHeight:1.6}},legacyLong?'旧版确认过长，请重新发起短确认。':question),
    h('details',null,h('summary',null,'技术详情（可选）'),h('small',null,`确认 ${consent.consent_id}`),legacyLong?h('pre',{className:'mps-code'},question):null,consent.receipt?h('pre',{className:'mps-code'},JSON.stringify(consent.receipt,null,2)):null)):null;
   if(!task)return consentPanel;
  const act=fn=>{try{const value=fn();value?.catch?.(e=>setNotice(String(e.message??e)));return value;}catch(e){setNotice(String(e.message??e));}};
  const busy=!!state.busy||!!state.controlPending||!!state.editingBlocked,control={auto:'Agent 自动推进',review:'先审方案',manual:'人工接管',paused:'暂停'}[task.control]??task.control;
  return h('section',{className:'mps-task-panel','aria-label':'Agent任务与干预'},consentPanel,h('h3',null,'当前绘图任务'),h('p',null,task.intent),h('p',{'aria-label':'任务控制状态'},`${control} · ${STAGES[task.stage]??task.stage}`),
   h('small',{className:'mps-muted'},`已占用 ${task.claimed_runs}/${task.max_runs} 次生成 · 当前稿 r${state.page.revision}`),
   h('div',{className:'mps-button-row'},h('button',{type:'button',disabled:busy,onClick:()=>act(()=>model.takeControl())},'接管微调'),h('button',{type:'button',disabled:busy||task.control==='paused',onClick:()=>act(()=>model.pauseTask())},'暂停自动推进'),h('button',{type:'button',disabled:busy||task.control==='auto',onClick:()=>act(()=>model.continueTask())},'保存当前稿并继续')),
   h('button',{type:'button',disabled:busy||task.max_runs>=20,onClick:()=>{if(globalThis.confirm?.(`增加1次GPU child预算（总预算 ${task.max_runs+1}），保存当前稿并交给Agent继续？regions多阶段可能仍需更多次数。`))act(()=>model.continueTask(task.max_runs+1));}},'授权再生成一次并继续'),
   state.continuePending&&state.continuePageId===state.page.page_id?h('button',{type:'button',disabled:busy,title:`重新通知 Agent 继续已交还的 r${state.page.revision} 稿件`,onClick:()=>act(()=>model.retryContinue())},'重发继续指令（不追加预算）'):null,
   task.control==='manual'?h('button',{type:'button',disabled:busy,onClick:()=>{if(globalThis.confirm?.('取代其他窗口的编辑控制？其未保存稿不会自动覆盖本页。'))act(()=>model.takeControl(true));}},'从其他窗口接管'):null,
   h('p',{className:'mps-muted'},state.controlPending?'正在取得编辑控制，修改会在成功后应用。':'查看不会打断；开始修改会先取得人工控制。已提交生成不会因暂停而取消。'),
   notice||state.taskSyncError?h('p',{role:'status'},notice||state.taskSyncError):null,
   ...(state.taskPlans??[]).map(plan=>{const run=plan.run,review=run?.context?.review;return h('article',{className:'mps-task-result',key:plan.plan_id},
    h('strong',null,`r${plan.page_revision}${plan.page_revision!==state.page.revision?' · 旧稿结果':' · 当前稿'} — ${STAGES[plan.settlement?.kind==='human_abandoned'?'abandoned':run?.status??plan.status]??plan.status}`),
     plan.settlement?.kind==='human_abandoned'?h('p',{className:'mps-muted'},'人工封存：原结果未明，保留预算不退款；不重发原请求。'):null,
    h('small',null,`${plan.effective?.backend??''} / ${plan.effective?.mode??''} · ${plan.effective?.width??'?'}×${plan.effective?.height??'?'}`),
    ...(plan.warnings??[]).map((w,i)=>h('p',{className:'mps-muted',key:i},w)),
    run?.status==='succeeded'?h(ResultImage,{model,runId:plan.run_id}):null,
    plan.observation_error?h('p',{role:'status'},plan.observation_error):null,
    review?h('div',null,h('strong',null,'Agent 实图观察'),h('ul',null,...(review.observations??[]).map((v,i)=>h('li',{key:`o${i}`},v))),h('ul',{className:'mps-checks'},...(review.issues??[]).map((v,i)=>h('li',{key:`i${i}`},v))),review.next_change?h('p',null,review.next_change):null):h('small',{className:'mps-muted'},'尚无实图审查记录。'),
    h('details',null,h('summary',null,'实际执行绑定'),h('pre',{className:'mps-code'},JSON.stringify({plan_id:plan.plan_id,run_id:plan.run_id,page_revision:plan.page_revision,digest:plan.digest,effective:plan.effective,settlement:plan.settlement},null,2))));}));
 };
}
