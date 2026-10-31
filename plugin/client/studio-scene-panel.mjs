import {studioSceneSummary} from '../src/studio-scene.mjs';

export function createStudioScenePanel(React){
 const h=React.createElement;
 return function StudioScenePanel({model,state}){
  const policy=state.page?.edit_policy??{mode:'full'},policyKey=JSON.stringify(policy);
  const asDraft=p=>({item_ids:p.mode==='descriptions'?structuredClone(p.item_ids??null):null,text:p.text??false,summary:p.summary??true,caption:p.caption??true});
  const [draft,setDraft]=React.useState(()=>asDraft(policy)),[error,setError]=React.useState(''),[policyNotice,setPolicyNotice]=React.useState('');
  const draftRef=React.useRef(draft),dirty=React.useRef({}),seenPolicy=React.useRef(policyKey);draftRef.current=draft;
  const patch=(key,value)=>{dirty.current[key]=true;const next={...draftRef.current,[key]:value};draftRef.current=next;setDraft(next);};
  React.useEffect(()=>{
   if(seenPolicy.current===policyKey)return;seenPolicy.current=policyKey;
   const incoming=asDraft(policy),next={...draftRef.current};
   for(const key of Object.keys(incoming))if(!dirty.current[key])next[key]=incoming[key];
   if(Object.keys(dirty.current).length)setPolicyNotice('服务端范围已变化：未修改字段已同步，本地已修改字段保留。请核对后再保存。');
   draftRef.current=next;setDraft(next);
  },[policyKey]);
  async function saveScope(){
   const submitted=structuredClone(draftRef.current),value=await model.setEditPolicy({mode:'descriptions',...submitted});
   for(const key of Object.keys(submitted))if(JSON.stringify(draftRef.current[key])===JSON.stringify(submitted[key]))delete dirty.current[key];
   if(value?.edit_policy)seenPolicy.current=JSON.stringify(value.edit_policy);
   setPolicyNotice('');return value;
  }
  const run=async fn=>{setError('');try{return await fn();}catch(e){setError(e.message);}};
  const disabled=!!(state.busy||state.editingBlocked||state.controlPending);
  const check=(label,value,set)=>h('label',null,h('input',{'aria-label':label,type:'checkbox',checked:value,disabled,onChange:e=>set(e.target.checked)}),label);
  let scene=null,sceneError='';try{if(state.draft)scene=studioSceneSummary(state.draft.doc.layout);}catch(e){sceneError=e.message;}
  const names=new Map((state.draft?.doc.layout.items??[]).map(i=>[i.id,i.name||i.id]));
  const status={current:'描述已核对当前构图',stale:'描述可能未跟随构图',unchecked:'描述尚未核对'}[state.descriptionsStatus??'unchecked'];
  const relations={'bbox-overlap':'投影框重叠','left-of':'位于左侧','above':'位于上方','nearer-than':'体块更靠前'};
  return h('section',{className:'mps-scene-panel','aria-label':'空间关系与描述范围'},h('h3',null,'空间关系 / 描述保护'),h('p',{role:'status',className:state.descriptionsStatus==='stale'?'mps-dirty':''},status),
   h('p',{className:'mps-muted'},'重编不等于描述已更新。关系来自投影框与构图体块，并非精确遮挡或真实3D重建。'),
   state.page?.editing_only||state.page?.task?.editing_only?h('div',{className:'mps-message'},h('p',null,'当前页仅文字：服务端禁止生成；不会新建任务或增加额度。'),h('button',{type:'button',disabled,onClick:()=>{if(state.page.task){if(globalThis.confirm?.('结束仅文字模式并继续当前任务？仅恢复既有预算内的生成授权，不追加额度；描述范围仍保持。'))return run(()=>model.continueTask());}else if(globalThis.confirm?.('结束仅文字模式并恢复完整编辑范围？不会新建任务或自动生成。'))return run(()=>model.setEditPolicy({mode:'full'}));}},state.page.task?'结束仅文字模式，保存并继续':'结束仅文字模式（不生成）')):null,
   h('button',{type:'button',disabled,onClick:()=>run(()=>model.confirmDescriptions())},'确认描述适用于当前构图'),
   h('p',null,policy.mode==='descriptions'?`服务端：只改描述 · ${policy.item_ids===null?'全部对象':(policy.item_ids??[]).join(', ')} · text ${policy.text?'开放':'禁止'}`:'服务端：完整修改范围'),
   h('p',{'aria-label':'待保存描述对象范围'},draft.item_ids===null?'待保存范围：全部对象':`待保存范围：${draft.item_ids.join(', ')||'无对象'}`),
   h('div',{className:'mps-button-row'},h('button',{type:'button',disabled:disabled||!state.selected.length,onClick:()=>{const ids=model.getSnapshot().selected;if(ids.length)patch('item_ids',[...ids]);}},'采用当前选区'),h('button',{type:'button',disabled,onClick:()=>{if(draft.item_ids===null||globalThis.confirm?.('将描述权限扩大到全部对象？保存后才生效。'))patch('item_ids',null);}},'允许全部对象')),
   check('允许修改画面文字 text',draft.text,value=>patch('text',value)),check('允许总述 caption',draft.summary,value=>patch('summary',value)),check('允许 Caption 正文',draft.caption,value=>patch('caption',value)),
   h('p',{className:'mps-muted'},'默认沿用已保存的稳定 ID；仅“采用当前选区”会重新绑定，改变选区不会改变待保存范围。对象锁仍优先。'),
   policyNotice?h('p',{role:'alert',className:'mps-message'},policyNotice):null,
   h('div',{className:'mps-button-row'},h('button',{type:'button',disabled,onClick:()=>run(saveScope)},'保存描述-only范围'),
    h('button',{type:'button',disabled,onClick:()=>{if(globalThis.confirm?.('允许 Agent 完整修改当前页？将解除描述-only范围；不增加生成预算。'))return run(()=>model.setEditPolicy({mode:'full'}));}},'恢复完整修改范围')),
   h('details',null,h('summary',null,`当前空间摘要 · ${scene?.items.length??0} 项`),sceneError?h('p',{role:'alert'},sceneError):null,
    h('ul',null,(scene?.items??[]).map(i=>h('li',{key:i.id},`${names.get(i.id)} · ${i.position.horizontal}/${i.position.vertical} · ${(i.size.width*100).toFixed(0)}% × ${(i.size.height*100).toFixed(0)}%${!i.visible?' · 出画/不可见':i.partial?' · 部分裁切':''}`))),
    h('ul',null,(scene?.relations??[]).slice(0,20).map((r,n)=>h('li',{key:n},`${names.get(r.a)} — ${relations[r.type]??r.type} — ${names.get(r.b)}`))),
    scene?.relations.length>20?h('p',{className:'mps-muted'},'界面仅显示前20条关系；完整有界摘要由 Agent 按需读取。'):null,
    h('ul',null,(scene?.warnings??[]).map((w,n)=>h('li',{key:n},`${w.code}${w.item_id?` · ${names.get(w.item_id)}`:''}`)))),
   error?h('p',{role:'alert',className:'mps-message'},error):null);
 };
}
