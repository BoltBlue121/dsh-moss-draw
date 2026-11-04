import {createStudioExchangeView} from './studio-exchange-view.mjs';

// Native-session handoff happens only on the explicit send button; local preview is private.
export function createStudioReferenceView(React){
 const h=React.createElement,Exchange=createStudioExchangeView(React);
 const button=(label,action,disabled=false)=>h('button',{type:'button',onClick:action,disabled},label);
 const statuses={not_started:'等待Agent启动 / 尚未开始',queued:'排队中',running:'分析中',succeeded:'分析完成，可审查提案',degraded:'降级完成（部分结果，请看警告）',failed:'分析失败',not_ready:'分析环境未就绪',cancelled:'分析已取消',unknown:'结果未知；请核对原请求，不重发'};
 const message=value=>typeof value==='string'?value:[value?.code,value?.message].filter(Boolean).join(': ');
 return function ReferencePanel({model,state}){
  const [mode,setMode]=React.useState('layout'),[detail,setDetail]=React.useState('medium'),[request,setRequest]=React.useState(''),[notice,setNotice]=React.useState(''),[labels,setLabels]=React.useState(true),[onlySelected,setOnlySelected]=React.useState(false);
  const run=async fn=>{setNotice('');try{return await fn();}catch(e){setNotice(String(e.message??e));}};
  // Analysis errors belong to the model's intended page, not a late component-local notice.
  const analysisAction=async fn=>{setNotice('');try{return await fn();}catch{}};
  const load=file=>file&&run(()=>model.loadReference(file));
  const reference=state.reference,options=state.referenceAnalysisOptions??{method:'agent',detail:'balanced',request},gbc=options.method==='gbc',analysis=state.referenceAnalysis,capability=state.analysisCapability;
  const blocked=state.busy||state.analysisSending||state.mergeBlocked||state.conflict||state.page?.proposals?.some(p=>p.status==='pending');
  const warnings=analysis?.warnings?.length?analysis.warnings:analysis?.summary?.warnings??[];
  async function download(){const blob=await model.exportAnnotation({labels,selectedOnly:onlySelected});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`${(reference?.name||'layout').replace(/\.[^.]+$/,'')}-标注.png`;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);setNotice('标注 PNG 已交给浏览器下载；它是当前画布坐标，不是生成图。');}
  return h('section',{className:'mps-reference','aria-label':'参考图反推',onDragOver:e=>{e.preventDefault();},onDrop:e=>{e.preventDefault();e.stopPropagation();if(!state.busy)load(e.dataTransfer?.files?.[0]);},onPaste:e=>{const file=[...(e.clipboardData?.items??[])].find(x=>x.kind==='file'&&x.type.startsWith('image/'))?.getAsFile();if(file){e.preventDefault();e.stopPropagation();if(!state.busy)load(file);}}},
   h('h3',null,'参考图 / 反推定位'),
   h('input',{type:'file',accept:'image/png,image/jpeg,image/webp','aria-label':'选择参考图',disabled:state.busy||!state.page,onChange:e=>{const file=e.target.files?.[0];e.target.value='';load(file);}}),
   button('从本会话叠入最近图片',()=>run(()=>model.loadLatestSessionImage()),state.busy||!state.page),
   h('p',{className:'mps-muted'},'可选择、拖入或粘贴 PNG/JPEG/WebP。选择方式、导入与预览只在本机；只有明确发送按钮才发送图片。预览最长2048px，透明区铺白；参考图暂存在本次窗口，切页保留，重开需重新选择。'),
   h('label',{className:'mps-field'},h('span',null,'分析方式'),h('select',{'aria-label':'参考图分析方式',value:options.method,disabled:!state.page,onChange:e=>model.setReferenceAnalysisOptions({method:e.target.value})},h('option',{value:'agent'},'原生 Agent 反推'),h('option',{value:'gbc'},'GBC 结构化分析（对象/部件/关系）'))),
   !reference&&state.draft?.doc?.kind==='layout'?button('导出画布标注 PNG',()=>run(download),state.busy):null,
   reference?h('div',null,h('img',{src:reference.url,alt:`本地参考：${reference.name}`,className:'mps-reference-thumb'}),h('p',null,`${reference.name} · ${reference.width}×${reference.height}（源 ${reference.sourceWidth}×${reference.sourceHeight}）`),
    reference.source?h('p',null,`本会话消息事件 #${reference.source.eventSeq} · ${reference.source.attachmentId}`):null,
    h('label',null,'参考图不透明度',h('input',{type:'range',min:0,max:1,step:.05,value:state.referenceAppearance?.opacity??1,onChange:e=>model.setReferenceAppearance({opacity:Number(e.target.value)})})),
    h('label',null,h('input',{type:'checkbox',checked:!!state.referenceAppearance?.wireframe,onChange:e=>model.setReferenceAppearance({wireframe:e.target.checked})}),'线框对照'),
    h('label',null,h('input',{type:'checkbox',checked:!!state.referenceAppearance?.original,onChange:e=>model.setReferenceAppearance({original:e.target.checked})}),'仅看原图'),
    h('label',{className:'mps-field'},h('span',null,'图片到当前画布'),h('select',{'aria-label':'参考图适配',value:state.referenceFit,onChange:e=>model.setReferenceFit(e.target.value)},h('option',{value:'contain'},'留边 contain'),h('option',{value:'cover'},'裁切 cover'),h('option',{value:'stretch'},'拉伸 stretch'))),
    h('p',{className:'mps-muted'},'定位框与左侧图层/画布是同一份 Doc，可直接画框、拖动和缩放。适配图片不会擅自移动已有框。'),
    h('div',{className:'mps-button-row'},button('适配画布到参考图',()=>run(()=>{if(globalThis.confirm?.('画布尺寸调整为参考图附近16倍数；未锁定框等比例缩放，保持Caption分支。')){const w=Math.max(16,Math.round(reference.width/16)*16),hh=Math.max(16,Math.round(reference.height/16)*16);model.setSize(w,hh,true);}}),state.busy),button('移除本地参考',()=>model.clearReference(),state.busy)),
    h('label',null,h('input',{type:'checkbox',checked:labels,onChange:e=>setLabels(e.target.checked)}),'导出编号与名称'),h('label',null,h('input',{type:'checkbox',checked:onlySelected,onChange:e=>setOnlySelected(e.target.checked)}),'仅导出选中图层'),button('导出标注 PNG',()=>run(download),state.busy||onlySelected&&!state.selected.length),
    h('hr'),
    gbc?h('label',{className:'mps-field'},h('span',null,'GBC细节'),h('select',{'aria-label':'GBC分析细节',value:options.detail,onChange:e=>model.setReferenceAnalysisOptions({detail:e.target.value})},h('option',{value:'quick'},'快速 quick'),h('option',{value:'balanced'},'均衡 balanced'),h('option',{value:'detailed'},'详细 detailed'))):h('div',null,
     h('label',{className:'mps-field'},h('span',null,'反推内容'),h('select',{'aria-label':'反推内容',value:mode,onChange:e=>setMode(e.target.value)},h('option',{value:'layout'},'Layout 定位与描述'),h('option',{value:'caption'},'Caption 描述'))),
     h('label',{className:'mps-field'},h('span',null,'细节'),h('select',{'aria-label':'反推细节',value:detail,onChange:e=>setDetail(e.target.value)},h('option',{value:'short'},'简短'),h('option',{value:'medium'},'适中'),h('option',{value:'long'},'详细')))),
    h('textarea',{'aria-label':'参考图补充要求',value:options.request,maxLength:1200,placeholder:'例如：只定位杯子与标题，不补画遮挡部分',onChange:e=>{setRequest(e.target.value);model.setReferenceAnalysisOptions?.({request:e.target.value});}}),
    gbc?button('发送参考图做GBC分析',()=>analysisAction(()=>model.analyzeReference()),blocked):button('交给当前Agent反推',()=>run(async()=>{await model.reverseReference({mode,detail,request:options.request});setNotice('图片与需求已送入当前原生会话。等待Agent提案后读取最新页审查；没有授权生图。');}),blocked),
    h('p',{className:'mps-muted'},gbc?'显式发送可启动已配置的模型分析（含detector/embedder计算）；不生成新图片、不自动采纳、不自动恢复人工/暂停任务。GBC不是分割蒙版或精确3D。':'使用当前会话模型，不另设视觉API。结果是提案，不自动采纳；看不清的内容应由Agent注明。')):h('p',null,'未选择图片；空白Layout仍可编辑。'),
   gbc?h('div',{'aria-label':'GBC分析状态'},
    h('p',null,capability?.configured?'配置已提供；模型是否就绪尚未验证（unchecked）':capability?'GBC未配置；不会自动改用Agent反推。':'GBC配置状态未查询。'),
    button('刷新GBC配置状态',()=>analysisAction(()=>model.refreshReferenceAnalysis({capabilityOnly:true})),!state.page||state.analysisReading||state.analysisSending),
    analysis?h('div',null,
     h('p',{role:'status'},state.analysisSending?'正在准备/交接参考图…':statuses[analysis.status]??'状态不可用'),
     h('p',{className:'mps-muted'},`${analysis.reference_name} · revision ${analysis.base_revision} · ${analysis.detail} / ${analysis.fit}`),
     h('p',{className:'mps-muted'},`request_key: ${analysis.request_key}${analysis.analysis_id?` · analysis_id: ${analysis.analysis_id}`:''}`),
     button('刷新分析状态',()=>analysisAction(()=>model.refreshReferenceAnalysis()),state.analysisReading||state.analysisSending),
     analysis.summary?.caption?h('p',null,analysis.summary.caption):null,
     analysis.summary?.counts?h('p',null,Object.entries(analysis.summary.counts).filter(([,n])=>Number.isSafeInteger(n)).map(([key,n])=>`${key}: ${n}`).join(' · ')):null,
     warnings.map((warning,i)=>h('p',{key:`warning-${i}`,role:'status'},message(warning))),
     analysis.error?h('p',{role:'alert'},message(analysis.error)):null,
     analysis.versions?h('p',{className:'mps-muted'},`版本: ${JSON.stringify(analysis.versions)}`):null,
     analysis.source?h('p',{className:'mps-muted'},`实际分析源: ${analysis.source.width}×${analysis.source.height} ${analysis.source.mime} · SHA256 ${analysis.source.sha256}`):null,
     ['succeeded','degraded'].includes(analysis.status)?h('p',null,'结果只用于待审提案；若页revision已变化，需重新核对，不能覆盖当前稿。请读取最新页审查提案。'):null):null,
    state.analysisError?h('p',{role:'alert'},state.analysisError):null):null,
   h(Exchange,{model,state}),notice?h('p',{role:'status'},notice):null);
 };
}
