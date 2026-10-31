// Native-session handoff happens only on the explicit send button; local preview is private.
export function createStudioReferenceView(React){
 const h=React.createElement;
 const button=(label,action,disabled=false)=>h('button',{type:'button',onClick:action,disabled},label);
 return function ReferencePanel({model,state}){
  const [mode,setMode]=React.useState('layout'),[detail,setDetail]=React.useState('medium'),[request,setRequest]=React.useState(''),[notice,setNotice]=React.useState(''),[labels,setLabels]=React.useState(true),[onlySelected,setOnlySelected]=React.useState(false);
  const run=async fn=>{setNotice('');try{return await fn();}catch(e){setNotice(String(e.message??e));}};
  const load=file=>file&&run(()=>model.loadReference(file));
  const reference=state.reference;
  async function download(){const blob=await model.exportAnnotation({labels,selectedOnly:onlySelected});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${(reference.name||'reference').replace(/\.[^.]+$/,'')}-标注.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);setNotice('标注 PNG 已交给浏览器下载；它是当前画布坐标，不是生成图。');}
  return h('section',{className:'mps-reference','aria-label':'参考图反推',onDragOver:e=>{e.preventDefault();},onDrop:e=>{e.preventDefault();e.stopPropagation();if(!state.busy)load(e.dataTransfer?.files?.[0]);},onPaste:e=>{const file=[...(e.clipboardData?.items??[])].find(x=>x.kind==='file'&&x.type.startsWith('image/'))?.getAsFile();if(file){e.preventDefault();e.stopPropagation();if(!state.busy)load(file);}}},
   h('h3',null,'参考图 / 反推定位'),
   h('input',{type:'file',accept:'image/png,image/jpeg,image/webp','aria-label':'选择参考图',disabled:state.busy||!state.page,onChange:e=>{const file=e.target.files?.[0];e.target.value='';load(file);}}),
   h('p',{className:'mps-muted'},'可选择、拖入或粘贴 PNG/JPEG/WebP。先在本机预览，点击“交给当前Agent反推”才发送图片。预览最长2048px，透明区铺白；参考图暂存在本次窗口，切页保留，重开需重新选择。'),
   reference?h('div',null,h('img',{src:reference.url,alt:`本地参考：${reference.name}`,className:'mps-reference-thumb'}),h('p',null,`${reference.name} · ${reference.width}×${reference.height}（源 ${reference.sourceWidth}×${reference.sourceHeight}）`),
    h('label',{className:'mps-field'},h('span',null,'图片到当前画布'),h('select',{'aria-label':'参考图适配',value:state.referenceFit,onChange:e=>model.setReferenceFit(e.target.value)},h('option',{value:'contain'},'留边 contain'),h('option',{value:'cover'},'裁切 cover'),h('option',{value:'stretch'},'拉伸 stretch'))),
    h('p',{className:'mps-muted'},'定位框与左侧图层/画布是同一份 Doc，可直接画框、拖动和缩放。适配图片不会擅自移动已有框。'),
    h('div',{className:'mps-button-row'},button('适配画布到参考图',()=>run(()=>{if(globalThis.confirm?.('画布尺寸调整为参考图附近16倍数；未锁定框等比例缩放，保持Caption分支。')){const w=Math.max(16,Math.round(reference.width/16)*16),hh=Math.max(16,Math.round(reference.height/16)*16);model.setSize(w,hh,true);}}),state.busy),button('移除本地参考',()=>model.clearReference(),state.busy)),
    h('label',null,h('input',{type:'checkbox',checked:labels,onChange:e=>setLabels(e.target.checked)}),'导出编号与名称'),h('label',null,h('input',{type:'checkbox',checked:onlySelected,onChange:e=>setOnlySelected(e.target.checked)}),'仅导出选中图层'),button('导出标注 PNG',()=>run(download),state.busy||onlySelected&&!state.selected.length),
    h('hr'),h('label',{className:'mps-field'},h('span',null,'反推内容'),h('select',{'aria-label':'反推内容',value:mode,onChange:e=>setMode(e.target.value)},h('option',{value:'layout'},'Layout 定位与描述'),h('option',{value:'caption'},'Caption 描述'))),
    h('label',{className:'mps-field'},h('span',null,'细节'),h('select',{'aria-label':'反推细节',value:detail,onChange:e=>setDetail(e.target.value)},h('option',{value:'short'},'简短'),h('option',{value:'medium'},'适中'),h('option',{value:'long'},'详细'))),
    h('textarea',{'aria-label':'参考图补充要求',value:request,maxLength:1200,placeholder:'例如：只定位杯子与标题，不补画遮挡部分',onChange:e=>setRequest(e.target.value)}),
    button('交给当前Agent反推',()=>run(async()=>{await model.reverseReference({mode,detail,request});setNotice('图片与需求已送入当前原生会话。等待Agent提案后读取最新页审查；没有授权生图。');}),state.busy||state.mergeBlocked||state.page?.proposals?.some(p=>p.status==='pending')),
    h('p',{className:'mps-muted'},'使用当前会话模型，不另设视觉API。结果是提案，不自动采纳；看不清的内容应由Agent注明。')):h('p',null,'未选择图片；空白Layout仍可编辑。'),
   notice?h('p',{role:'status'},notice):null);
 };
}
