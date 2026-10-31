import {createStudioDocPreview} from './studio-preview.mjs';
export function createStudioArchiveView(React){
 const h=React.createElement,DocPreview=createStudioDocPreview(React);
 const button=(label,fn,disabled=false)=>h('button',{type:'button',onClick:fn,disabled},label);
 return function ArchivePanel({model,state}){
  const [query,setQuery]=React.useState(''),[category,setCategory]=React.useState(''),[title,setTitle]=React.useState(''),[notice,setNotice]=React.useState(''),[offset,setOffset]=React.useState(0);
  const run=async fn=>{setNotice('');try{return await fn();}catch(e){setNotice(e.message);}};
  const search=at=>run(async()=>{await model.loadArchives({query,...(category?{category}:{}),offset:at,limit:20});setOffset(at);});
  const selected=state.archivePreview;
  return h('section',{className:'mps-archive','aria-label':'提示词档案'},h('h3',null,'提示词档案 · 当前会话'),
   h('p',{className:'mps-muted'},'档案保存Layout/Caption双分支和归档时提示词；不扫描其它会话。优先载入新页；载入当前页可撤销。'),
   h('input',{'aria-label':'档案搜索',placeholder:'搜索名称或分类',value:query,maxLength:200,onChange:e=>setQuery(e.target.value)}),
   h('input',{'aria-label':'档案分类',placeholder:'分类（空为全部）',value:category,maxLength:80,onChange:e=>setCategory(e.target.value)}),
   h('div',{className:'mps-button-row'},button('搜索档案',()=>search(0),state.busy),button('上一批',()=>search(Math.max(0,offset-20)),state.busy||offset===0),button('下一批',()=>search(state.archiveNext),state.busy||state.archiveNext==null)),
   state.archiveAvailable===false?h('p',{role:'status'},'当前Host未加载档案接口。参考图、文字差异与当前页保存不受影响。'):null,
   h('p',null,`${state.archiveTotal??0} 份档案`),
   h('ul',null,(state.archives??[]).map(a=>h('li',{key:a.archive_id},button(`${a.title} · ${a.category||'未分类'} · r${a.revision}`,()=>run(()=>model.previewArchive(a.archive_id)),state.busy)))),
   h('input',{'aria-label':'存档名称',placeholder:state.draft?.title||'档案名称',value:title,maxLength:200,onChange:e=>setTitle(e.target.value)}),
   button('将当前稿存为档案',()=>run(async()=>{await model.saveArchive(title.trim()||state.draft.title,category);await model.loadArchives({query,...(category?{category}:{}),offset:0,limit:20});setOffset(0);setNotice('已归档当前稿快照，不改变页面。');}),state.busy||!state.draft||state.archiveAvailable===false),
   selected?h('article',{className:'mps-archive-preview'},h('h4',null,selected.title),h('small',null,`${selected.category||'未分类'} · ${selected.doc.kind} · r${selected.revision}`),
    h(DocPreview,{doc:selected.doc,title:'档案文档预览'}),h('textarea',{'aria-label':'档案提示词',readOnly:true,value:selected.prompt||'（归档时未编译）'}),
    h('details',null,h('summary',null,'查看档案文档'),h('pre',{className:'mps-code'},JSON.stringify(selected.doc,null,2))),
    h('div',{className:'mps-button-row'},button('载入新页',()=>run(()=>model.archiveToNewPage()),state.busy||!state.seriesId),button('载入当前页',()=>{if(globalThis.confirm?.('把档案内容载入当前页？这是可撤销的本地修改；启用自动保存时会生成新revision。'))run(()=>model.applyArchive());},state.busy||!state.page),
     button('修改档案名称分类',()=>run(()=>model.renameArchive(title.trim()||selected.title,category)),state.busy),button('删除此档案',()=>{if(globalThis.confirm?.('从档案列表删除此项？不会删除已有页面。'))run(()=>model.deleteArchive());},state.busy))):null,
   notice?h('p',{role:'status'},notice):null);
 };
}
