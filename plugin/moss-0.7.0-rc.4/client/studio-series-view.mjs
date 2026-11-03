export function createStudioSeriesView(React){
 const h=React.createElement;
 return function StudioSeriesView({model,state}){
  const source=state.seriesProfile?.series_id===state.seriesId?state.seriesProfile:null;
  const cached=model.getSeriesFormDraft?.(state.seriesId);
  const [form,setForm]=React.useState(()=>cached??(source?structuredClone(source):null)),[dirty,setDirty]=React.useState(!!cached),[error,setError]=React.useState('');
  const [bindings,setBindings]=React.useState(()=>Object.fromEntries((state.draft?.doc.shared?.bindings??[]).map(b=>[b.item_id,b.character_id]))),[captionIds,setCaptionIds]=React.useState(()=>state.draft?.doc.shared?.caption_cast_ids??[]),[bindingsDirty,setBindingsDirty]=React.useState(false);
  const bindingVersion=React.useRef(0);
  React.useEffect(()=>{if(!bindingsDirty){setBindings(Object.fromEntries((state.draft?.doc.shared?.bindings??[]).map(b=>[b.item_id,b.character_id])));setCaptionIds(state.draft?.doc.shared?.caption_cast_ids??[]);}},[state.draft?.doc.shared,bindingsDirty]);
  React.useEffect(()=>{if(!dirty&&source)setForm(structuredClone(source));},[source,dirty]);
  const current=form?.series_id===state.seriesId?form:source;
  const formRef=React.useRef(current);formRef.current=current;
  const disabled=!!(state.busy||state.editingBlocked||state.controlPending),snapshot=state.draft?.doc.shared;
  const characters=(state.draft?.doc.layout.items??[]).filter(i=>i.label==='character');
  const dangling=Object.entries(bindings).some(([item,id])=>id&&(!characters.some(i=>i.id===item)||!current?.cast.some(c=>c.character_id===id)))||captionIds.some(id=>!current?.cast.some(c=>c.character_id===id));
  const patch=value=>{const next={...formRef.current,...value};formRef.current=next;model.setSeriesFormDraft?.(state.seriesId,next);setForm(next);setDirty(true);};
  const run=async fn=>{setError('');try{return await fn();}catch(e){setError(e.message);}};
  const reload=()=>{if(!dirty||globalThis.confirm?.('放弃尚未保存的系列设定表单并读取源版本？'))return run(async()=>{const value=await model.loadSeriesProfile();model.setSeriesFormDraft?.(state.seriesId,null);setForm(structuredClone(value));setDirty(false);});};
  const field=(label,control)=>h('label',{className:'mps-field'},h('span',null,label),control);
  return h('section',{className:'mps-series-profile','aria-label':'系列画风与角色卡'},h('h3',null,'系列画风 / 角色卡'),h('p',{className:'mps-muted'},'源更新不会自动改写页面或增加生成额度。'),
   h('button',{type:'button',disabled:disabled||!state.seriesId,onClick:reload},'读取系列设定'),
   snapshot?h('p',null,`页面快照 r${snapshot.revision}${source&&source.revision>snapshot.revision?' · 源有新版本，可显式应用':''}`):h('p',{className:'mps-muted'},'本页尚未应用系列快照。'),
   current?h('div',null,h('p',null,`源版本 r${current.revision}${dirty?' · 表单未保存':''}`),
    field('系列画风',h('textarea',{'aria-label':'系列画风',value:current.style,maxLength:12000,disabled,onChange:e=>patch({style:e.target.value})})),
    current.cast.map((card,index)=>h('fieldset',{key:card.character_id,disabled,className:'mps-cast-card'},h('legend',null,`角色 ${index+1}`),h('small',null,`ID: ${card.character_id}`),
     field('角色名',h('input',{'aria-label':`角色名 ${card.character_id}`,value:card.name,maxLength:200,onChange:e=>patch({cast:current.cast.map(c=>c.character_id===card.character_id?{...c,name:e.target.value}:c)})})),
     field('角色描述',h('textarea',{'aria-label':`角色描述 ${card.character_id}`,value:card.description,maxLength:12000,onChange:e=>patch({cast:current.cast.map(c=>c.character_id===card.character_id?{...c,description:e.target.value}:c)})})),
     h('button',{type:'button',onClick:()=>patch({cast:current.cast.filter(c=>c.character_id!==card.character_id)})},'删除角色卡'))),
    h('div',{className:'mps-button-row'},h('button',{type:'button',disabled:disabled||current.cast.length>=32,onClick:()=>patch({cast:[...current.cast,{character_id:globalThis.crypto.randomUUID(),name:'新角色',description:''}]})},'新增角色卡'),
     h('button',{type:'button',disabled:disabled||!dirty,onClick:()=>run(async()=>{const submitted=structuredClone(current);const value=await model.updateSeriesProfile({style:submitted.style,cast:submitted.cast,expected_revision:submitted.revision});const later=JSON.stringify(formRef.current)!==JSON.stringify(submitted);const next=later?{...formRef.current,revision:value.revision}:structuredClone(value);formRef.current=next;model.setSeriesFormDraft?.(state.seriesId,later?next:null);setForm(next);setDirty(later);})},'保存系列源')),
    dirty?h('p',{className:'mps-muted'},'请先保存系列源，再显式应用到页面。'):null,
    h('h4',null,'页面绑定（按稳定 ID）'),
    characters.map(item=>field(item.name||item.id,h('select',{key:item.id,'aria-label':`角色卡绑定 ${item.id}`,disabled:disabled||dirty||item.locked,value:bindings[item.id]??'',onChange:e=>{bindingVersion.current++;setBindingsDirty(true);setBindings({...bindings,[item.id]:e.target.value});}},h('option',{value:''},'不绑定'),current.cast.map(c=>h('option',{key:c.character_id,value:c.character_id},c.name||c.character_id))))),
    h('h4',null,'Caption 明确引用角色'),current.cast.map(c=>h('label',{key:c.character_id},h('input',{type:'checkbox','aria-label':`Caption 角色 ${c.character_id}`,checked:captionIds.includes(c.character_id),disabled:disabled||dirty,onChange:e=>{bindingVersion.current++;setBindingsDirty(true);setCaptionIds(e.target.checked?[...captionIds,c.character_id]:captionIds.filter(id=>id!==c.character_id));}}),c.name||c.character_id)),
    dangling?h('p',{role:'alert'},'已选绑定包含已删除的角色卡或对象。请清空/重新选择绑定后再应用。'):null,
    h('button',{type:'button',disabled,onClick:()=>{bindingVersion.current++;setBindingsDirty(true);setBindings({});setCaptionIds([]);}},'清空本地绑定选择'),
    h('button',{type:'button',disabled:disabled||dirty||dangling||!state.draft||current.revision<1,onClick:()=>run(async()=>{const version=bindingVersion.current;const result=await model.applySeriesProfile({bindings:Object.entries(bindings).filter(([,id])=>id).map(([item_id,character_id])=>({item_id,character_id})),caption_cast_ids:[...captionIds]});if(version===bindingVersion.current)setBindingsDirty(false);return result;})},'应用此版本到当前页'),
    h('p',{className:'mps-muted'},'应用先保存当前稿并取得人工租约，再以 CAS 写入快照；锁定项的有效描述不可暗改。角色卡不是生成身份一致性的保证。')):h('p',{className:'mps-muted'},'读取后可新建版本化画风和角色卡；不会后台轮询。'),
   error?h('p',{role:'alert',className:'mps-message'},error):null);
 };
}
