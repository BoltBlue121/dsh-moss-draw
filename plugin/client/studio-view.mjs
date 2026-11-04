import {T2I_MODELS} from '../src/catalog.mjs';
import { studioPoint, studioProposalChanges, studioProposalStatus } from './studio-model.mjs';
import { createStudioCameraView, createStudioBodyInspector } from './studio-camera-view.mjs';
import { createStudioReferenceView } from './studio-reference-view.mjs';
import { createStudioArchiveView } from './studio-archive-view.mjs';
import { createStudioDiffView } from './studio-diff-view.mjs';
import { createStudioDocPreview } from './studio-preview.mjs';
import { createStudioTaskView } from './studio-task-view.mjs';
import { useStudioPanelTools } from './studio-panel-view.mjs';
import { renderStudioAnnotation, useStudioAnnotationTools } from './studio-annotation-view.mjs';
import { createStudioScenePanel } from './studio-scene-panel.mjs';
import { createStudioSeriesView } from './studio-series-view.mjs';
import { proposalGhosts } from './studio-proposal.mjs';
import { studioSnapDelta } from './studio-snap.mjs';
import { studioCameraMoved, studioBody, STUDIO_CAMERA_DEFAULTS, STUDIO_CUBE_EDGES } from '../src/studio-camera.mjs';
import { hasStudioRig, projectStudioComposition } from '../src/studio-composition.mjs';
import { emptyStudioDoc, upgradeStudioDoc } from '../src/studio-domain.mjs';
import { applyStudioPanelOp } from '../src/studio-panel-ops.mjs';
import { STUDIO_FRAME_TEMPLATES, studioSizeForMegapixels } from '../src/studio-page-assist.mjs';
import { estimateStudioLayoutBodies, alignStudioGroupDepth } from '../src/studio-body.mjs';
import { returnStudioItemsToView } from './studio-director-ops.mjs';
import { studioItemRing, studioShapeCameraBlocked } from '../src/studio-shape-render.mjs';
import {prefixedStudioPrompt,STUDIO_QUICK_REQUESTS,studioAssistStats,studioAssistRequest} from './studio-preferences.mjs';

// Uses the host's React instance. Model lifetime and session registry belong to entry.
export function createStudioView(React) {
 const h=React.createElement,Director=createStudioCameraView(React),BodyInspector=createStudioBodyInspector(React),ReferencePanel=createStudioReferenceView(React),ArchivePanel=createStudioArchiveView(React),ChangeDiff=createStudioDiffView(React),DocPreview=createStudioDocPreview(React),TaskPanel=createStudioTaskView(React),ScenePanel=createStudioScenePanel(React),SeriesPanel=createStudioSeriesView(React);
 const button=(text,onClick,disabled=false,extra={})=>h('button',{type:'button',onClick,disabled,...extra},text);
 const options=values=>values.map(([value,label])=>h('option',{key:value,value},label));
 const field=(label,control)=>h('label',{className:'mps-field'},h('span',null,label),React.cloneElement?React.cloneElement(control,{'aria-label':control.props['aria-label']??label}):control);
 const boxOf=(a,b)=>[Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];
 const inspectValue=value=>value===undefined?'（无）':JSON.stringify(value,null,2);
 const typeLabels={object:'物体',character:'角色',text:'文字'};

 return function StudioView({model,sessionId,surface='main',visible=true,presentation}) {
  const [state,setState]=React.useState(()=>model.getSnapshot());
  const [notice,setNotice]=React.useState('');
  const [seriesTitle,setSeriesTitle]=React.useState('');
  const [pageTitle,setPageTitle]=React.useState('');
  const [request,setRequest]=React.useState('');
  const [promptMode,setPromptMode]=React.useState('queue');
  const [drawer,setDrawer]=React.useState(false),[director,setDirector]=React.useState(false),[sideMode,setSideMode]=React.useState('properties');
  const [previewBox,setPreviewBox]=React.useState(null);
  const [ratio,setRatio]=React.useState('1'),[mp,setMp]=React.useState(1),[coordinateMode,setCoordinateMode]=React.useState('xywh');
  const [inlineEdit,setInlineEdit]=React.useState(null);
  const [ratioPair,setRatioPair]=React.useState([3,2]),[newMeta,setNewMeta]=React.useState(''),[newColor,setNewColor]=React.useState('#7891ad');
  const [accepted,setAccepted]=React.useState({}),[ghostProposal,setGhostProposal]=React.useState(null);
  const [snapGuides,setSnapGuides]=React.useState({x:[],y:[]});
  const [freeCam,setFreeCam]=React.useState(false),[wire,setWire]=React.useState(false),[assist,setAssist]=React.useState({fill:true,camera:true,unify:false,check:true,onlySelection:false});
  const [renaming,setRenaming]=React.useState(null),[renameText,setRenameText]=React.useState('');
  const svgRef=React.useRef(null),stageRef=React.useRef(null),gesture=React.useRef(null),wheelRef=React.useRef(null),layerDrag=React.useRef(null),directorShell=React.useRef(null),acked=React.useRef(new Set());
  React.useEffect(()=>{const request=state.page?.task?.presentation;if(!visible||state.busy||!request||request.status!=='queued'||acked.current.has(request.request_id)||presentation?.page_id&&presentation.page_id!==state.page.page_id)return;let stopped=false;const timer=setTimeout(()=>{if(stopped)return;acked.current.add(request.request_id);model.acknowledgePresentation(request.request_id,surface).catch(e=>{acked.current.delete(request.request_id);setNotice(e.message);});},0);return()=>{stopped=true;clearTimeout(timer);};},[visible,state.busy,state.page?.page_id,state.page?.task?.presentation?.request_id,state.page?.task?.presentation?.status,model,surface,presentation]);
  React.useEffect(()=>{
   const unsubscribe=model.subscribe(()=>setState(model.getSnapshot()));
   setState(model.getSnapshot());
   model.refresh().catch(()=>{});
   return ()=>{unsubscribe();if(gesture.current){gesture.current=null;model.endGesture(true);}};
  },[model,sessionId]);
  React.useEffect(()=>{if(director)directorShell.current?.querySelector?.('.mps-director')?.focus?.();else svgRef.current?.focus?.();},[director]);
  React.useEffect(()=>{if(!drawer||state.preferences?.autoCompile===false||!state.draft||state.busy||state.error||state.gestureActive||state.compiled&&!state.compileStale)return;const timer=setTimeout(()=>model.compile().catch(error=>setNotice(error.message)),700);return()=>clearTimeout(timer);},[drawer,state.preferences?.autoCompile,state.draft?.doc,state.busy,state.error,state.gestureActive,state.compiled,state.compileStale,model]);
  React.useEffect(()=>{const el=svgRef.current,fn=e=>wheelRef.current?.(e);el?.addEventListener?.('wheel',fn,{passive:false});return()=>el?.removeEventListener?.('wheel',fn);},[director,state.page?.page_id,state.draft?.doc.kind,model]);
  function run(action){setNotice('');try{const result=action();if(result?.catch)result.catch(error=>setNotice(String(error.message??error)));return result;}catch(error){setNotice(String(error.message??error));}}
  function confirmSwitch(){return !state.dirty||globalThis.confirm?.('当前页有未保存修改。保留此页的本地草稿并切换？（草稿仅在本次插件会话内保留）')===true;}
  function openPage(id){if(state.busy||state.editingBlocked)return;return run(async()=>{if(state.autoSave&&state.dirty&&!state.conflict)await model.flushSave();else if(!confirmSwitch())return;await model.open(id,{keepDraft:true});});}
  function createPage(kind,duplicate=false){
   if(!state.seriesId){setNotice('请先新建或选择系列。');return;}
   if(!confirmSwitch())return;
   run(()=>model.createPage({series_id:state.seriesId,title:duplicate?`${state.draft.title} 副本`.slice(0,200):pageTitle.trim()||'未命名页',kind, ...(duplicate?{doc:state.draft.doc}:{})},{keepDraft:true}).then(()=>setPageTitle('')));
  }
  const draft=state.draft,layout=draft?.doc.layout;
  async function createTemplatePage(preset,gutter){
   if(!state.seriesId||!confirmSwitch())return;
   const base=upgradeStudioDoc(emptyStudioDoc('layout'));
   if(layout){base.layout.width=layout.width;base.layout.height=layout.height;}
   const fresh=applyStudioPanelOp(base,{op:'template',preset,gutter_px:gutter}).doc;
   return model.createPage({series_id:state.seriesId,title:STUDIO_FRAME_TEMPLATES[preset],doc:fresh},{keepDraft:true});
  }
  const originalRef=!!state.reference?.url&&!!state.referenceAppearance?.original;
  const visualWire=!!state.reference?.url&&!!state.referenceAppearance?.wireframe;
  const openTabs=state.pages.filter(page=>page.series_id===state.seriesId&&!(state.closedPageTabs??[]).includes(page.page_id));
  function navKeys(event){
   if(state.busy||state.editingBlocked||event.isComposing||event.nativeEvent?.isComposing||event.keyCode===229||event.altKey||event.ctrlKey||event.metaKey)return;
   const id=event.target?.dataset?.pageTab,here=openTabs.findIndex(p=>p.page_id===id);
   if(here<0||!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;
   event.preventDefault();event.stopPropagation();
   const i=event.key==='Home'?0:event.key==='End'?openTabs.length-1:(here+(event.key==='ArrowLeft'?-1:1)+openTabs.length)%openTabs.length;
   event.currentTarget?.querySelectorAll?.('[data-page-tab]')?.[i]?.focus?.();
   openPage(openTabs[i].page_id);
  }
  const panelOrder=new Map((layout?.items??[]).filter(it=>it.role==='panel'&&!it.hidden).map((it,i)=>[it.id,i+1]));
  const itemName=value=>value.role==='panel'?`${panelOrder.has(value.id)?`第 ${panelOrder.get(value.id)} 格`:'隐藏分镜'}${value.name?` · ${value.name}`:''}`:value.name||typeLabels[value.label];
  const selected=layout?.items.filter(item=>state.selected.includes(item.id))??[];
  const item=selected.length===1?selected[0]:null;
  const editingDisabled=!draft||state.editingBlocked;
  const cameraMoved=!!layout&&studioCameraMoved(layout);
  // The one shared camera/shape refusal; no bbox stand-in anywhere in the main SVG.
  const shapeCameraBlocked=!!draft&&studioShapeCameraBlocked(draft.doc);
  const annotationCancel=React.useRef(null),flat=visible&&!originalRef&&!freeCam&&!director&&!cameraMoved&&!gesture.current&&!state.gestureActive;
  const panelTools=useStudioPanelTools(React,{model,state,flat,svgRef,point:pointer,notice:setNotice,onTemplatePage:createTemplatePage,onBegin:()=>annotationCancel.current?.()});
  const annotations=useStudioAnnotationTools(React,{model,state,flat,svgRef,point:pointer,notice:setNotice,onBegin:panelTools.cancel});
  annotationCancel.current=annotations.cancel;
  function selectionHasRig(){
   const fresh=model.getSnapshot();
   return fresh.draft.doc.layout.items.some(it=>(it.rig||it.attachment)&&fresh.selected.includes(it.id));
  }
  function moveSelected(dx,dy,individual=false,grabId=null){
   if(selectionHasRig())throw Error('请在镜头调度中移动关节人偶或调整道具关节偏移。');
   return cameraMoved?model.moveVisualSelection(dx,dy,{individual,grabId}):model.moveSelection(dx,dy,{individual});
  }
  const cameraGesture=mode=>mode==='rotate'||mode==='pan';
  function enterDirector(){setFreeCam(false);setDirector(true);}
  function mainWheel(event){if(!freeCam||model.getSnapshot().editingBlocked)return;event.preventDefault();event.stopPropagation();run(()=>{const c={...STUDIO_CAMERA_DEFAULTS,...model.getSnapshot().draft.doc.layout.camera},delta=event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?400:1),clamp=(n,a,b)=>Math.max(a,Math.min(b,n));if(!Number.isFinite(delta))return;model.patchCamera(event.altKey?{enabled:true,fov:clamp(c.fov+delta*.03,10,120)}:{enabled:true,distance:clamp(c.distance*Math.exp(clamp(delta*.001,-1,1)),.2,5)});});}
  wheelRef.current=mainWheel;
  function pointer(event){return studioPoint(event,svgRef.current.getBoundingClientRect(),model.getSnapshot().draft.doc.layout);}
  function capture(event,mode,id,handle){
   if((!cameraGesture(mode)&&event.button!==0)||state.editingBlocked)return;
   event.preventDefault();event.stopPropagation();svgRef.current.focus?.();
   const start=pointer(event),snapshot=model.getSnapshot();gesture.current={mode,id,handle,start,last:start,append:event.shiftKey,individual:!!event.altKey,pointerId:event.pointerId,origin:structuredClone(snapshot.draft.doc.layout),ids:[...snapshot.selected],applied:[0,0],moved:false};setSnapGuides({x:[],y:[]});
   svgRef.current.setPointerCapture?.(event.pointerId);
   if(mode==='move'||mode==='resize'||cameraGesture(mode))model.beginGesture();
   else setPreviewBox({box:[...start,...start],mode});
  }
  function itemDown(event,value){
   if(freeCam){capture(event,event.shiftKey||event.button===1||event.button===2?'pan':'rotate');return;}
   if(event.button!==0||state.editingBlocked)return;
   event.stopPropagation();
   if(state.tool==='draw'&&!cameraMoved){capture(event,'draw');return;}
   if(!state.selected.includes(value.id)||event.shiftKey||event.altKey)model.select(value.id,event.shiftKey,event.altKey);
   // Legacy polygons retain their readonly transform contract; editable panels use shared geometry.
   if(Object.hasOwn(value,'shape') && (value.role!=='panel'||cameraMoved))return;
   if(value.rig||value.attachment||selectionHasRig())return;
   if(!value.locked&&!event.shiftKey)capture(event,'move',value.id);
  }
  function movePointer(event){
   const action=gesture.current;if(!action)return;
   run(()=>{const point=pointer(event),dx=point[0]-action.last[0],dy=point[1]-action.last[1];
    if(action.mode==='move'){
      const totalX=point[0]-action.start[0],totalY=point[1]-action.start[1];if(!action.moved&&Math.hypot(totalX,totalY)*state.zoom<3)return;
      if(cameraMoved)moveSelected(dx,dy,action.individual,action.id);
      else{const axis=event.shiftKey?(Math.abs(totalX)>=Math.abs(totalY)?'x':'y'):null,snap=studioSnapDelta(action.origin,action.ids,totalX,totalY,{zoom:state.zoom,disabled:!!event.altKey,axis});model.moveSelection(snap.dx-action.applied[0],snap.dy-action.applied[1]);action.applied=[snap.dx,snap.dy];setSnapGuides(snap.guides);}
      action.moved=true;
     }
    else if(action.mode==='resize')model.resizeItem(action.id,action.handle,point[0]-action.start[0],point[1]-action.start[1],{origin:action.origin.items.find(i=>i.id===action.id).bbox,aspect:!!event.shiftKey});
    else if(cameraGesture(action.mode)){const c={...STUDIO_CAMERA_DEFAULTS,...model.getSnapshot().draft.doc.layout.camera};model.patchCamera(action.mode==='pan'?{enabled:true,pan_x:Math.max(-100,Math.min(100,c.pan_x-dx/layout.width)),pan_y:Math.max(-100,Math.min(100,c.pan_y-dy/layout.height))}:{enabled:true,orbit:((c.orbit+dx*state.zoom*.3+180)%360+360)%360-180,pitch:Math.max(-85,Math.min(85,c.pitch-dy*state.zoom*.3))});}
    else setPreviewBox({box:boxOf(action.start,point),mode:action.mode});
    action.last=point;
   });
  }
  function endPointer(event,cancel=false){
   const action=gesture.current;if(!action)return;gesture.current=null;
   run(()=>{
    if(action.mode==='move'||action.mode==='resize'||cameraGesture(action.mode))model.endGesture(cancel);
    else if(!cancel){const box=boxOf(action.start,pointer(event));
     if(action.mode==='draw'&&box[2]-box[0]>=2&&box[3]-box[1]>=2){const pageId=state.page?.page_id,created=model.addItem(state.drawLabel,box);model.setTool('select');Promise.resolve(created).then(id=>{const now=model.getSnapshot();if(now.page?.page_id===pageId){const added=now.draft.doc.layout.items.find(it=>it.id===id);if(added)openInline(added,event);}}).catch(e=>setNotice(e.message));}
     else if(action.mode==='select')model.selectBox(box,action.append);
    }
   });setPreviewBox(null);setSnapGuides({x:[],y:[]});if(action.pointerId!==undefined)svgRef.current?.releasePointerCapture?.(action.pointerId);
  }
  function keyDown(event){
   if(event.isComposing||event.nativeEvent?.isComposing||event.keyCode===229||event.target?.closest?.('input,textarea,select,[contenteditable="true"]'))return;
   if(annotations.keyDown(event)||panelTools.keyDown(event))return;
   if(!draft)return;
   if(event.key.toLowerCase()==='escape'){event.preventDefault();event.stopPropagation();run(()=>{if(gesture.current)endPointer(event,true);else if(director)setDirector(false);else if(freeCam)setFreeCam(false);else model.clearSelection();});return;}
   if(state.editingBlocked||event.altKey)return;
   const command=event.ctrlKey||event.metaKey,key=event.key.toLowerCase();let action;
   if(command&&key==='s')action=()=>model.save();
   else if(command&&key==='n')action=()=>createPage('layout');
   else if(command&&key==='w'&&state.page&&model.closePageTab)action=()=>model.closePageTab(state.page.page_id);
   else if(command&&key==='z')action=()=>event.shiftKey?model.redo():model.undo();
   else if(command&&key==='y')action=()=>model.redo();
   else if(command&&key==='a')action=()=>model.selectAll();
   else if(command&&key==='d')action=()=>model.copySelection();
   else if(command&&key==='g')action=()=>event.shiftKey?model.ungroupSelection():model.groupSelection();
   else if(!command&&(key==='delete'||key==='backspace'))action=()=>model.deleteSelection();
   else if(!command&&key==='v')action=()=>model.setTool('select');
   else if(!command&&key==='r')action=()=>model.setTool('draw');
   else if(command&&event.shiftKey&&key==='enter')action=()=>model.sendToAgent(studioAssistRequest(assist),promptMode);
   else if(!command&&key==='f')action=()=>director?setDirector(false):enterDirector();
   else if(!command&&event.shiftKey&&(event.code==='Backquote'||key==='~'||key==='`'))action=()=>{setFreeCam(!freeCam);if(!freeCam)model.patchCamera({enabled:true});};
   else if(!command&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){const n=event.shiftKey?10:1;action=()=>moveSelected(event.key==='ArrowLeft'?-n:event.key==='ArrowRight'?n:0,event.key==='ArrowUp'?-n:event.key==='ArrowDown'?n:0);}
   if(action){event.preventDefault();event.stopPropagation();run(action);}
  }
  async function copyText(text){if(!globalThis.navigator?.clipboard?.writeText)throw Error('无法访问剪贴板，请选择预览文本手动复制。');await globalThis.navigator.clipboard.writeText(text);setNotice('已复制。');}
  function numberInput(label,value,onChange,disabled=false,extra={}){return field(label,h('input',{type:'number',value,disabled,onChange:event=>{if(event.target.value==='')return;run(()=>onChange(Number(event.target.value)));},...extra}));}
  function editItem(patch){run(()=>model.patchItem(item.id,patch));}
  function openInline(value,event){
   if(!value||value.locked||state.editingBlocked||originalRef)return;
   const stage=stageRef.current,rect=stage?.getBoundingClientRect?.(),w=Math.max(100,Math.min(310,(rect?.width??320)-16));
   setInlineEdit({pageId:state.page.page_id,id:value.id,initial:value.caption,value:value.caption,width:w,
    left:(stage?.scrollLeft??0)+Math.max(4,Math.min((event?.clientX??rect?.left??0)-(rect?.left??0),(rect?.width??320)-w-8)),
    top:(stage?.scrollTop??0)+Math.max(4,Math.min((event?.clientY??rect?.top??0)-(rect?.top??0),(rect?.height??200)-145))});
  }
  function renderInline(){
   const popup=inlineEdit;if(!popup||originalRef||director||popup.pageId!==state.page?.page_id||draft?.doc.kind!=='layout')return null;
   const save=()=>run(async()=>{
    const now=model.getSnapshot(),target=now.draft?.doc.layout.items.find(i=>i.id===popup.id);
    if(now.page?.page_id!==popup.pageId||!target||target.locked||target.caption!==popup.initial)throw Error('原描述已改变或图层已锁定，请保留输入并重新核对。');
    if(popup.value!==popup.initial)await model.patchItem(popup.id,{caption:popup.value});
    setInlineEdit(null);svgRef.current?.focus?.();
   });
   return h('div',{role:'dialog','aria-label':'就地编辑图层描述',className:'mps-inspector',
    style:{position:'absolute',zIndex:2,top:popup.top,left:popup.left,width:popup.width,boxSizing:'border-box',padding:8,background:'var(--mps-surface, Canvas)'}},
    h('textarea',{autoFocus:true,'aria-label':'就地描述',maxLength:12000,value:popup.value,
     onChange:e=>setInlineEdit({...popup,value:e.target.value}),onKeyDown:e=>{
      if(e.isComposing||e.nativeEvent?.isComposing||e.keyCode===229)return;
      if(e.key==='Escape'){e.stopPropagation();e.preventDefault();setInlineEdit(null);svgRef.current?.focus?.();}
      if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.stopPropagation();e.preventDefault();save();}
     }}),button('应用描述',save),button('取消编辑',()=>{setInlineEdit(null);svgRef.current?.focus?.();}));
  }
  function resizeOptions(){
   const effective=ratio==='custom'?ratioPair[0]/ratioPair[1]:Number(ratio);
   let size,message;
   try{size=studioSizeForMegapixels(effective,mp);message=`${size[0]} × ${size[1]} · ${(size[0]*size[1]/1000000).toFixed(3)} MP`;}
   catch(error){message=error.message;}
   return h('details',null,h('summary',null,'按比例与百万像素换幅'),h('div',{className:'mps-button-row'},
    field('画幅比例',h('select',{value:ratio,onChange:e=>setRatio(e.target.value)},options([['1','1:1'],['1.5','3:2'],[String(2/3),'2:3'],[String(16/9),'16:9'],[String(9/16),'9:16'],['custom','自定义']]))),
    ratio==='custom'?numberInput('比例宽',ratioPair[0],v=>setRatioPair([v,ratioPair[1]]),false,{min:.001,step:'any'}):null,
    ratio==='custom'?numberInput('比例高',ratioPair[1],v=>setRatioPair([ratioPair[0],v]),false,{min:.001,step:'any'}):null,
    numberInput('百万像素',mp,setMp,false,{min:.001,max:16.778,step:'any'}),h('small',{role:'status'},message),
    button('应用等比换幅',()=>run(()=>model.fitSize(...size)),editingDisabled||!size)));
  }
  function coordinateInputs(value){
   const box=value.bbox,locked=value.locked||!!value.rig||!!value.attachment||Object.hasOwn(value,'shape');
   if(coordinateMode==='yxyx'){
    const indices=[1,0,3,2],labels=['上 y_min','左 x_min','下 y_max','右 x_max'];
    return indices.map((j,i)=>{const offset=(j%2?layout.height:layout.width)/2;
     return numberInput(labels[i],box[j]-offset,v=>{const next=[...box];next[j]=v+offset;return model.patchItem(value.id,{bbox:next});},locked,{step:'any',key:labels[i]});
    });
   }
   return [
    numberInput('X',box[0],v=>model.patchItem(value.id,{bbox:[v,box[1],v+box[2]-box[0],box[3]]}),locked),
    numberInput('Y',box[1],v=>model.patchItem(value.id,{bbox:[box[0],v,box[2],v+box[3]-box[1]]}),locked),
    numberInput('宽',box[2]-box[0],v=>model.patchItem(value.id,{bbox:[box[0],box[1],box[0]+v,box[3]]}),locked,{min:1}),
    numberInput('高',box[3]-box[1],v=>model.patchItem(value.id,{bbox:[box[0],box[1],box[2],box[1]+v]}),locked,{min:1})];
  }
  function appendCaption(fragment){
   if(!item||item.locked)return;
   const parts=item.caption.split(/[.;。；]\s*/u).map(v=>v.trim().toLowerCase());
   if(!parts.includes(fragment.toLowerCase()))editItem({caption:[item.caption.trim(),fragment].filter(Boolean).join('. ')});
  }
  function renderStage(){
   if(!draft)return h('div',{className:'mps-empty'},h('h2',null,'从空白提示词页开始'),h('p',null,'在左栏新建系列和页面。Layout 可直接画框，Caption 可直接写文字；无需参考图，也不会自动生成。'));
   if(draft.doc.kind==='caption')return h('div',{className:'mps-caption-paper'},h('h2',null,'Caption'),h('small',null,`${draft.doc.caption.caption.length} 字符 · ${draft.doc.caption.caption.trim().split(/\s+/u).filter(Boolean).length} 词`),h('p',{className:'mps-muted'},'原文提示词 · 切换 Layout 会保留这里的内容'),h('textarea',{'aria-label':'Caption 正文',value:draft.doc.caption.caption,maxLength:12000,placeholder:'在这里写下完整提示词…',onChange:event=>run(()=>model.setCaption(event.target.value))}));
   if(director)return h('div',{className:'mps-director-shell',ref:directorShell,role:'dialog','aria-modal':true,'aria-label':'全屏镜头调度'},h(Director,{model,state,fullscreen:true,onExit:()=>setDirector(false)}));
   let projection;try{projection=cameraMoved||hasStudioRig(layout)?projectStudioComposition(layout):null;}catch(error){return h('div',{role:'alert'},h('p',null,`投影暂不可用：${error.message}`),button('停用相机，编辑原框',()=>run(()=>model.patchCamera({enabled:false}))));}
   const colors={object:'#64b5f6',character:'#b69cff',text:'#f6ce71'};
   const children=[h('rect',{key:'paper',x:0,y:0,width:layout.width,height:layout.height,fill:'#fcfcfd'})];
   if(state.reference?.url)children.push(h('image',{key:'reference',href:state.reference.url,opacity:originalRef?1:state.referenceAppearance?.opacity??1,x:0,y:0,width:layout.width,height:layout.height,preserveAspectRatio:state.referenceFit==='stretch'?'none':state.referenceFit==='cover'?'xMidYMid slice':'xMidYMid meet',pointerEvents:'none'}));
   if(originalRef)return h('svg',{className:'mps-canvas',ref:svgRef,width:layout.width*state.zoom,height:layout.height*state.zoom,viewBox:`0 0 ${layout.width} ${layout.height}`,role:'img',tabIndex:0,'aria-label':'Layout 原参考图对照'},children);
   const visualItems=projection?layout.items.map(item=>{
    if(item.label!=='character')return item;
    const view=projection.items[item.id];
    return view.visible?{...item,bbox:view.bbox}:{...item,hidden:true};
   }):layout.items;
   const annotationLayout=projection?{...layout,items:visualItems}:layout;
   const painted=projection?projection.order.map(id=>layout.items.find(i=>i.id===id)):layout.items;
   painted.filter(value=>!value.hidden&&(!projection||projection.items[value.id]?.visible)&&!(shapeCameraBlocked&&value.role!=='panel'&&Object.hasOwn(value,'shape'))).forEach(value=>{
    const [x,y,r,b]=projection?projection.items[value.id].bbox:value.bbox,chosen=state.selected.includes(value.id),color=colors[value.label]??colors.object;
    // A moved camera projects boxes, not rings, so polygons are drawn only in canvas coordinates.
    const ring=(!cameraMoved||value.role==='panel')&&Object.hasOwn(value,'shape')?studioItemRing(value):null;
    const annotation=renderStudioAnnotation(React,annotationLayout,value);
    const rig=projection?.rigs?.joints.get(value.id)??projection?.rigs?.props.get(value.id);
    children.push(h('g',{key:value.id,onPointerDown:event=>itemDown(event,value),onDoubleClick:event=>{event.stopPropagation();model.select(value.id,false,true);openInline(value,event);},'data-item-id':value.id},
     (annotation?h('g',{fillOpacity:visualWire?0:1},annotation):null)??(ring?h('polygon',{'data-shape-polygon':value.id,points:ring.map(point=>point.join(',')).join(' '),fill:color,fillOpacity:visualWire?0:chosen?0.25:0.12,stroke:chosen?'#344bf2':color,strokeWidth:(chosen?2:1)/state.zoom},h('title',null,value.role==='panel'?'拖动平移分镜；选中后可编辑顶点。':'形状对象仅可选中；拖动/缩放暂不支持')):h('rect',{x,y,width:r-x,height:b-y,fill:color,fillOpacity:visualWire?0:chosen?0.25:0.12,stroke:chosen?'#344bf2':color,strokeWidth:(chosen?2:1)/state.zoom,strokeDasharray:value.locked?`${5/state.zoom} ${3/state.zoom}`:undefined})),
     ring?h('rect',{'data-shape-bbox':value.id,x,y,width:r-x,height:b-y,fill:'none',stroke:color,strokeWidth:1/state.zoom,strokeDasharray:`${5/state.zoom} ${3/state.zoom}`,pointerEvents:'none'}):null,
     rig?h('g',{'data-rig-overlay':value.id,pointerEvents:'none',stroke:color,strokeWidth:2/state.zoom,fill:'none'},
      ...(rig.surfaces??[]).map(part=>h('polygon',{key:'surface-'+part.part,'data-rig-body-part':part.part,
        points:part.ring.map(p=>p.join(',')).join(' '),fill:chosen?'#427e77':'#595767',strokeWidth:1/state.zoom})),
      ...rig.segments.map(([[x1,y1],[x2,y2]],i)=>h('line',{key:i,x1,y1,x2,y2})),
      rig.points?.head?h('circle',{cx:rig.points.head[0],cy:rig.points.head[1],r:rig.headRadius}):null):null,
     !annotation?h('text',{x:x+6/state.zoom,y:y+18/state.zoom,fontSize:12/state.zoom,fill:'#24314e',pointerEvents:'none'},`${value.locked?'🔒 ':''}${itemName(value)}${value.label==='text'&&value.text?`: ${value.text.slice(0,32)}`:''}`):null,
     h('title',null,value.caption||'尚未填写描述')));
   });
   if(item&&!item.hidden&&!item.locked&&!freeCam&&!item.rig&&!item.attachment&&!Object.hasOwn(item,'shape')&&(!cameraMoved||studioBody(item,layout).anchor!=='world')){const [l,t,r,b]=item.bbox,mx=(l+r)/2,my=(t+b)/2,size=8/state.zoom;
    for(const [handle,x,y] of [['nw',l,t],['n',mx,t],['ne',r,t],['e',r,my],['se',r,b],['s',mx,b],['sw',l,b],['w',l,my]])children.push(h('rect',{key:`handle-${handle}`,className:`mps-handle mps-handle-${handle}`,'data-handle':handle,'aria-label':`调整 ${handle}`,x:x-size/2,y:y-size/2,width:size,height:size,fill:'#fff',stroke:'#344bf2',strokeWidth:1/state.zoom,onPointerDown:event=>capture(event,'resize',item.id,handle)}));
   }
   if(previewBox){const [x,y,r,b]=previewBox.box;children.push(h('rect',{key:'gesture',x,y,width:r-x,height:b-y,fill:'#4d61fa',fillOpacity:0.1,stroke:'#344bf2',strokeWidth:1/state.zoom,strokeDasharray:`${4/state.zoom} ${3/state.zoom}`,pointerEvents:'none'}));}
   for(const x of snapGuides.x)children.push(h('line',{key:`snap-x-${x}`,'data-snap-guide':'x',x1:x,x2:x,y1:0,y2:layout.height,stroke:'#f66c9a',strokeWidth:1/state.zoom,pointerEvents:'none'}));
   for(const y of snapGuides.y)children.push(h('line',{key:`snap-y-${y}`,'data-snap-guide':'y',x1:0,x2:layout.width,y1:y,y2:y,stroke:'#f66c9a',strokeWidth:1/state.zoom,pointerEvents:'none'}));
   const chosenProposal=(state.page?.proposals??[]).find(p=>p.proposal_id===ghostProposal&&p.status==='pending');
   if(chosenProposal){const preview=state.dirty?{ghosts:[],error:'本地草稿已改动，暂不叠加提案；请撤销修改，或保存后重新读取提案。'}:proposalGhosts(chosenProposal);children.push(h('text',{key:'ghost-legend',x:8,y:18,fontSize:13,fill:'#8a4528',pointerEvents:'none'},preview.error||'完整提案虚影：红=原框/删除，绿=新框；不代表已采纳'));
    for(const ghost of preview.ghosts)for(const side of ['before','after']){const box=ghost[side];if(!box)continue;const [x,y,r,b]=box;children.push(h('rect',{key:`ghost:${ghost.id}:${side}`,'data-proposal-ghost':ghost.kind,x,y,width:r-x,height:b-y,fill:'none',stroke:side==='before'?'#d64f49':'#159357',strokeWidth:2/state.zoom,strokeDasharray:`${6/state.zoom} ${4/state.zoom}`,pointerEvents:'none'}));}
   }
   if(selected.length>1){const bounds=selected.filter(i=>!i.hidden&&(!projection||projection.items[i.id]?.visible)).map(i=>projection?projection.items[i.id].bbox:i.bbox);if(bounds.length){const l=Math.min(...bounds.map(b=>b[0])),t=Math.min(...bounds.map(b=>b[1])),r=Math.max(...bounds.map(b=>b[2])),b=Math.max(...bounds.map(b=>b[3]));children.push(h('rect',{key:'group-outline','data-group-outline':true,x:l,y:t,width:r-l,height:b-t,fill:'none',stroke:'#344bf2',strokeWidth:1/state.zoom,strokeDasharray:`${6/state.zoom} ${4/state.zoom}`,pointerEvents:'none'}));}}
   if(wire){const p=projection??projectStudioComposition(layout);for(const value of layout.items){if(shapeCameraBlocked&&value.role!=='panel'&&Object.hasOwn(value,'shape'))continue;const v=p.items[value.id];if(value.hidden||!v?.visible||!v.corners||v.anchor!=='world')continue;for(const [idx,[a,b]] of STUDIO_CUBE_EDGES.entries()){const x=v.corners[a],y=v.corners[b];if(x&&y)children.push(h('line',{key:`wire-${value.id}-${idx}`,'data-main-cube-edge':value.id,x1:x.x,y1:x.y,x2:y.x,y2:y.y,stroke:'#9172da',strokeWidth:1/state.zoom,pointerEvents:'none'}));}}if(p.horizon)children.push(h('line',{key:'horizon','data-main-horizon':true,x1:p.horizon.a.x,y1:p.horizon.a.y,x2:p.horizon.b.x,y2:p.horizon.b.y,stroke:'#c99526',pointerEvents:'none'}));if(p.vp)children.push(h('circle',{key:'vp',cx:p.vp.x,cy:p.vp.y,r:5/state.zoom,fill:'none',stroke:'#c99526',pointerEvents:'none'}));}
   children.push(panelTools.overlay(),annotations.overlay());
   return h('svg',{ref:svgRef,className:`mps-canvas ${freeCam?'mps-free-camera':state.tool==='draw'?'mps-draw-mode':''}`,width:layout.width*state.zoom,height:layout.height*state.zoom,viewBox:`0 0 ${layout.width} ${layout.height}`,tabIndex:0,role:'img','aria-label':'Layout 编辑画布',onContextMenu:event=>{if(freeCam)event.preventDefault();},onPointerDown:event=>!panelTools.active&&!annotations.active&&capture(event,freeCam?(event.shiftKey||event.button===1||event.button===2?'pan':'rotate'):cameraMoved?'select':state.tool),onPointerMove:movePointer,onPointerUp:event=>endPointer(event),onPointerCancel:event=>endPointer(event,true),onLostPointerCapture:event=>{if(gesture.current?.mode==='move'||gesture.current?.mode==='resize'||cameraGesture(gesture.current?.mode))endPointer(event);else{gesture.current=null;setPreviewBox(null);}}},children);
  }
  function renderInspector(){
   if(!draft)return h('p',{className:'mps-muted'},'打开页面后编辑属性。');
   const eraseTag=(key,index)=>run(()=>model.patchSummary({[key]:(layout.summary[key]??[]).filter((_,i)=>i!==index)}));
   const quickTags=item?.label==='character'?['three-quarter view','full body','looking over the shoulder']:item?.label==='text'?['clear lettering','speech balloon','caption box']:['foreground detail','wide shot','side view'];
   return h(React.Fragment??'div',null,
    h('h3',null,item?'项目属性':selected.length>1?`已选 ${selected.length} 个图层`:'画面总述'),
    item?h('div',{className:'mps-inspector'},Object.hasOwn(item,'shape')?h('p',{className:'mps-muted'},item.role==='panel'?'分镜可拖动平移。用「编辑分镜顶点」调整轮廓、旋转、缩放或恢复矩形。':'形状对象：仅可选中；拖动/缩放手柄和 X/Y/宽/高 数值框暂不可用，模型只接收 bbox。'):null,
     item.rig||item.attachment?h('div',null,h('p',{className:'mps-muted'},'关节人偶由骨架定位，挂接道具随关节和偏移移动。'),button('在镜头调度编辑人偶与道具',enterDirector)):null,
     field('名称',h('input',{value:item.name??'',maxLength:200,disabled:item.locked,onChange:e=>editItem({name:e.target.value})})),
     field('类别',h('select',{value:item.label,disabled:item.locked,onChange:e=>editItem({label:e.target.value,...(e.target.value==='text'&&item.text===undefined?{text:''}:{})})},options([['object','物体 object'],['character','角色 character'],['text','文字 text']]))),
     field('描述 caption',h('textarea',{value:item.caption,maxLength:12000,disabled:item.locked,onChange:e=>editItem({caption:e.target.value})})),
     h('details',null,h('summary',null,'描述短语 / 就地编辑'),h('div',{className:'mps-button-row'},...quickTags.map(tag=>button(tag,()=>appendCaption(tag),item.locked,{key:tag})),button('就地编辑描述',()=>openInline(item),item.locked))),
     item.label==='text'?field('画面文字 text',h('textarea',{value:item.text??'',maxLength:12000,disabled:item.locked,onChange:e=>editItem({text:e.target.value})})):null,
     field('坐标格式',h('select',{value:coordinateMode,onChange:e=>setCoordinateMode(e.target.value)},options([['xywh','左上原点 · X/Y/宽/高'],['yxyx','画布中心 · yxyx']]))),
     h('div',{className:'mps-grid-two'},...coordinateInputs(item)),
     field('景深层',h('select',{value:item.depth??'auto',disabled:item.locked,onChange:e=>editItem({depth:e.target.value})},options([['auto','自动'],['fg','前景'],['mg','中景'],['bg','背景']]))),
     field('组',h('input',{value:item.group??'',disabled:true})),
     h('details',null,h('summary',null,'基准体块参数'),h(BodyInspector,{model,state,item})),
     h('div',{className:'mps-button-row'},button('拉回画面',()=>run(()=>model.updateLayout(l=>returnStudioItemsToView(l,state.selected))),item.locked),button('组远近对齐',()=>run(()=>model.updateLayout(l=>alignStudioGroupDepth(l,state.selected))),item.locked||!item.group)),
     h('div',{className:'mps-button-row'},button(item.hidden?'显示图层':'隐藏图层',()=>run(()=>model.setItemFlag(item.id,'hidden',!item.hidden)),item.locked),button(item.locked?'解锁图层':'锁定图层',()=>run(()=>model.setItemFlag(item.id,'locked',!item.locked)))))
    :h('div',null,
     field('画面总述 caption',h('textarea',{value:layout.summary.caption,maxLength:12000,onChange:e=>run(()=>model.patchSummary({caption:e.target.value}))})),
     field('画面类型',h('select',{value:layout.summary.canvas??'single',onChange:e=>run(()=>model.patchSummary({canvas:e.target.value}))},options([['single','单画面'],['multi_panel','多格画面'],['collage','拼贴']]))),
     h('details',null,h('summary',null,'添加风格标签与配色'),h('div',{className:'mps-button-row'},
      ...['ink drawing','cinematic lighting','flat color'].map(tag=>button(tag,()=>run(()=>model.patchSummary({meta:[...new Set([...(layout.summary.meta??[]),tag])]})),false,{key:tag})),
      h('input',{'aria-label':'自定义风格标签',value:newMeta,maxLength:200,onChange:e=>setNewMeta(e.target.value)}),
      button('追加风格标签',()=>{const tag=newMeta.trim();if(tag)run(()=>model.patchSummary({meta:[...new Set([...(layout.summary.meta??[]),tag])]}));setNewMeta('');},!newMeta.trim()),
      ...(layout.summary.meta??[]).map((tag,i)=>button('× '+tag,()=>eraseTag('meta',i),false,{key:'meta'+i,'aria-label':'移除风格标签 '+tag})),
      h('input',{type:'color','aria-label':'自定义配色',value:newColor,onChange:e=>setNewColor(e.target.value)}),
      button('追加颜色',()=>run(()=>model.patchSummary({palette:[...new Set([...(layout.summary.palette??[]),newColor])]}))),
      ...(layout.summary.palette??[]).map((color,i)=>button('× '+color,()=>eraseTag('palette',i),false,{key:'color'+i,'aria-label':'移除颜色 '+color})),
      ...[['夜雨',['#243351','#4b7499','#efb878']],['晴昼',['#415d48','#b5c89b','#f1d3a7']]].map(([label,colors])=>button(label,()=>run(()=>model.patchSummary({palette:[...new Set([...(layout.summary.palette??[]),...colors])]})),false,{key:label})))),
     field('Meta（每行一项）',h('textarea',{value:(layout.summary.meta??[]).join('\n'),onChange:e=>run(()=>model.patchSummary({meta:e.target.value.split('\n').filter(Boolean)}))})),
     field('Palette（每行一项）',h('textarea',{value:(layout.summary.palette??[]).join('\n'),onChange:e=>run(()=>model.patchSummary({palette:e.target.value.split('\n').filter(Boolean)}))}))),
    h('details',{className:'mps-camera-note'},h('summary',null,'镜头与编译选项'),h('p',null,'3D机位改变编译副本的框、可见性和层序，不反写基准框。透视文字是指导，不保证像素服从。'),
      ...[['camera','镜头文字',true],['depth','前后景与遮挡文字',false],['perspective','透视文字（镜头文字优先）',false]].map(([key,label,fallback])=>h('label',{key},h('input',{type:'checkbox',checked:layout.prompt_options?.[key]??fallback,disabled:key==='perspective'&&!!layout.camera?.enabled&&layout.prompt_options?.camera!==false,onChange:e=>run(()=>model.patchPromptOptions({[key]:e.target.checked}))}),label))),
    h(ScenePanel,{key:state.page.page_id,model,state}),
    h('section',{className:'mps-agent'},h('h3',null,'让当前 DSH 会话协助'),h('p',{className:'mps-muted'},'发送当前页、revision、选中框与机位摘要。Agent 按需读页；不会发送完整历史或自动启动 GPU。'),
     h('div',{className:'mps-button-row'},STUDIO_QUICK_REQUESTS.map(([label,text])=>button(label,()=>label==='按视角改描述'?run(()=>model.requestDescriptionUpdate({onlySelection:assist.onlySelection,text:state.page.edit_policy?.mode==='descriptions'&&!!state.page.edit_policy.text,request:request||text,mode:promptMode})):setRequest(text),state.busy||state.controlPending,{key:label}))),
     h('details',null,h('summary',null,'补全选项 · Ctrl+Shift+Enter'),h('p',null,(()=>{const s=studioAssistStats(draft.doc,state.selected,assist.onlySelection);return `空描述 ${s.empty} · 过短 ${s.short} · 缺文字 ${s.missingText}`;})()),...Object.entries({fill:'补全描述',camera:'依据机位',unify:'统一风格',check:'检查矛盾',onlySelection:'仅选中框'}).map(([key,label])=>h('label',{key},h('input',{type:'checkbox',checked:assist[key],onChange:e=>setAssist({...assist,[key]:e.target.checked})}),label)),button('使用补全需求',()=>setRequest(studioAssistRequest(assist)))),
     h('textarea',{'aria-label':'Agent 修改需求',value:request,maxLength:2000,placeholder:'例如：把杯子移到画面右下角，并保留文字',onChange:e=>setRequest(e.target.value)}),
     field('会话发送方式',h('select',{value:promptMode,onChange:e=>setPromptMode(e.target.value)},options([['queue','排队 queue'],['steer','引导当前任务 steer']]))),
     button(state.dirty?'先保存，再发送需求':'发送修改需求',()=>run(()=>model.sendToAgent(request,promptMode).then(()=>setRequest(''))),state.busy||state.dirty||!request.trim())),
    renderProposals(),renderHistory());
  }
  function renderProposals(){
   return h('section',{className:'mps-proposals'},h('h3',null,'当前页提案'),
    button(state.dirty?'保留草稿并读取最新':'读取最新页 / 提案',()=>run(()=>model.reload()),state.busy),
    state.dirty?button('放弃本地并重载',()=>{if(globalThis.confirm?.('确定放弃当前页的本地修改并读取最新保存版本？此操作不能撤销。'))run(()=>model.reload({discard:true}));},state.busy):null,
    ...(state.page?.proposals??[]).map(proposal=>{
     const changes=studioProposalChanges(proposal,{separateOrder:!!state.proposalOrder}),pending=proposal.status==='pending',keys=pending?(accepted[proposal.proposal_id]??changes.map(c=>c.key)):(proposal.accepted??[]);
     return h('article',{key:proposal.proposal_id,className:'mps-proposal'},h('strong',null,proposal.summary||'未命名提案'),h('small',null,` ${studioProposalStatus(proposal)} · 基于 r${proposal.base_revision}`),
      changes.map(change=>h(ChangeDiff,{key:change.key,change,selected:keys.includes(change.key)||keys.includes('layout.items')&&(change.key==='layout.order'||change.key.startsWith('item:')),pending,onSelect:checked=>setAccepted({...accepted,[proposal.proposal_id]:checked?[...keys,change.key]:keys.filter(k=>k!==change.key)})})),
       pending&&draft.doc.kind==='layout'?button(ghostProposal===proposal.proposal_id?'隐藏提案虚影':state.dirty?'本地稿已改，暂不叠加提案':'预览完整提案虚影',()=>{setGhostProposal(ghostProposal===proposal.proposal_id?null:proposal.proposal_id);setDirector(false);},state.dirty&&ghostProposal!==proposal.proposal_id):null,
      pending?h('div',null,h('div',{className:'mps-button-row'},button('全选',()=>setAccepted({...accepted,[proposal.proposal_id]:changes.map(c=>c.key)})),button('全不选',()=>setAccepted({...accepted,[proposal.proposal_id]:[]}))),h('p',{className:'mps-muted'},'采纳选中项后，此提案一次关闭；未选部分不会应用。'),h('div',{className:'mps-button-row'},button('采纳选中项',()=>run(()=>model.resolve(proposal.proposal_id,keys,false)),state.busy||state.dirty||!keys.length),button('拒绝提案',()=>run(()=>model.resolve(proposal.proposal_id,[],true)),state.busy||state.dirty))):null);
    }),!state.page?.proposals.length?h('p',{className:'mps-muted'},'暂无提案。'):null);
  }
  function renderRestorePrompt(){
   const prompt=state.restorePrompt;if(!prompt)return null;
   const diff=prompt.diff,ids=diff.removed_shape_item_ids??[],shown=ids.slice(0,20).join(', '),rest=ids.length>20?` 等 ${ids.length} 个`:'';
   return h('div',{className:'mps-restore-ack',role:'alert'},
    h('h4',null,'恢复需要确认精确的文档格式或形状差异'),
    h('p',null,`历史快照 ${diff.snapshot_id}（v${diff.snapshot_schema_version}） → 最终写入 v${diff.result_schema_version} · 当前 r${diff.expected_revision} · 目标 r${prompt.revision}`),
    h('p',null,diff.result_schema_version===2?'恢复旧内容但保持 v2 格式；原历史 revision 不会被修改。':'恢复旧内容；原历史 revision 不会被修改。'),
    ids.length?h('p',null,`受影响形状 ID（${ids.length}）：${shown}${rest}`):h('p',null,'没有同 id 的形状字段丢失。'),
    diff.removed_rich_item_ids?.length?h('p',null,`以下图层将失去分镜、人偶、挂接、气泡或笔画数据（${diff.removed_rich_item_ids.length}）：${diff.removed_rich_item_ids.join('、')}`):null,
    h('p',{className:'mps-muted'},'此确认只代表 UI 通道对本次差异的回显，不构成新的真人授权；切页或 revision 变化后需要重新确认。'),
    h('div',{className:'mps-button-row'},button('确认恢复差异',()=>run(()=>model.confirmRestore()),state.busy),
     button('取消恢复',()=>model.cancelRestore())));
  }
  function renderHistory(){return h('details',{className:'mps-history'},h('summary',null,'保存历史 / 恢复 revision'),button('读取历史',()=>run(()=>model.history()),state.busy),
   !state.historyPreviewAvailable?h('small',{className:'mps-muted'},'当前Host不提供只读快照预览；恢复仍需明确确认，不以恢复冒充预览。'):null,
   state.history.map(row=>h('div',{key:row.revision,className:'mps-history-row'},h('span',null,`r${row.revision} · ${row.operation}`),button('预览',()=>run(()=>model.previewRevision(row.revision)),state.busy||!state.historyPreviewAvailable),button('恢复',()=>{if(globalThis.confirm?.(`恢复 r${row.revision}？这会创建新的 revision，并使待处理提案过期。`))run(()=>model.restore(row.revision));},state.busy||state.dirty||row.revision===state.page.revision))),
   renderRestorePrompt(),
   state.historyPreview?h('div',null,h(DocPreview,{doc:state.historyPreview.snapshot.doc,title:`历史 r${state.historyPreview.revision} · ${state.historyPreview.snapshot.title}`}),button('关闭历史预览',()=>model.closeHistoryPreview())):null);}
  function renderCompile(){if(!drawer)return null;const compiled=state.compiled,current=compiled?.compiled&&!state.compileStale;
   return h('section',{className:'mps-compile','aria-label':'编译预览'},h('div',{className:'mps-section-title'},h('strong',null,`编译预览${state.compileStale?' · 已过期，请重新编译':''}`),button('关闭',()=>setDrawer(false))),
    h('p',{className:'mps-muted'},'纯文本编译，不是 GPU 生成，也不构成执行授权。空页/不完整框会显示实际 checks。'),
    h('div',{className:'mps-button-row'},button('重新编译',()=>run(()=>model.compile()),state.busy||!draft),h('label',null,h('input',{'aria-label':'自动重编',type:'checkbox',checked:state.preferences?.autoCompile!==false,onChange:e=>model.setPreferences({autoCompile:e.target.checked})}),'自动重编 · 700ms'),button('存入档案',()=>run(()=>model.saveArchive(draft.title).then(()=>setNotice('已保存当前稿快照到档案库。'))),state.busy||!draft||state.archiveAvailable===false)),
    field('MOSS 文生图底模',h('select',{'aria-label':'MOSS 文生图底模',value:state.preferences?.t2i_model??'',onChange:e=>run(()=>model.setPreferences({t2i_model:e.target.value}))},h('option',{value:''},'跟随生成设置'),...T2I_MODELS.map(id=>h('option',{key:id,value:id},{base:'Base',sft:'SFT',heal:'Heal'}[id])))),
    state.preferences?.t2i_model==='heal'?h('small',null,'KBlueLeaf 官方示例：16 步 / CFG 3 / shift 5 / seed 0。作者 KohakuMoss 官方采样：Euler，吸附到 1000 步训练网格，负向跳过第 22 层。默认无画风 LoRA。 ',h('a',{href:'https://huggingface.co/KBlueLeaf/MOSS-Image-heal/blob/a639943df44a4f326e95b9c43058ae7e1a0a8f34/README.md',target:'_blank',rel:'noreferrer'},'模型卡'),' · ',h('a',{href:'https://github.com/KohakuBlueleaf/KohakuMossTrainer/blob/b06ac60e54321955c24e818add5d32b2fad23ed6/docs/guides/inference.md',target:'_blank',rel:'noreferrer'},'官方采样说明')):null,
    state.preferences?.t2i_model==='heal'?button('使用 Heal 示例负面词',()=>run(()=>model.setPreferences({negative:'',negative_custom:false}))):null,
    field('提示词前缀',h('textarea',{'aria-label':'提示词前缀',maxLength:12000,value:state.preferences?.prefix??'',onChange:e=>model.setPreferences({prefix:e.target.value})})),field('负面提示词',h('textarea',{'aria-label':'负面提示词',maxLength:12000,value:state.preferences?.negative??'',onChange:e=>model.setPreferences({negative:e.target.value})})),
    compiled?h('div',null,h('p',{role:'status'},compiled.compiled?'编译成功':'未能编译'),compiled.shape_fidelity==='bbox-only'&&!state.compileStale?h('p',{className:'mps-muted','data-shape-notice':true},'形状用于预览和编辑；模型只接收 bbox，不是 hard mask 或 pose control。'):null,h('ul',{className:'mps-checks'},compiled.checks.map((check,index)=>h('li',{key:index},h('code',null,check.code),' — ',check.message,check.item_id?` (${check.item_id})`:''))),
     h('textarea',{'aria-label':'编译 prompt',readOnly:true,value:compiled.prompt??'',className:'mps-compiled-prompt'}),
     h('div',{className:'mps-button-row'},button('复制 prompt',()=>run(()=>copyText(compiled.prompt)),!current),button('复制含前缀',()=>run(()=>copyText(prefixedStudioPrompt(compiled.prefix??'',compiled.prompt??''))),!current),button('复制 negative',()=>run(()=>copyText(compiled.negative??'')),!current||!compiled.negative)),
     compiled.prefix?h('textarea',{'aria-label':'含前缀预览',readOnly:true,value:prefixedStudioPrompt(compiled.prefix,compiled.prompt??'')}):null,
     compiled.negative?h('pre',{className:'mps-code'},compiled.negative):null):h('p',null,'等待编译结果…'));
  }
  return h('div',{className:'mps-studio','data-session-id':sessionId,onBlurCapture:()=>model.finishTextEdit?.(),onKeyDown:keyDown,tabIndex:-1},
   h('fieldset',{className:'mps-edit-boundary',disabled:!!state.editingBlocked},h('header',{className:'mps-topbar'},h('label',null,h('input',{'aria-label':'自动保存',type:'checkbox',checked:!!state.autoSave,onChange:e=>model.setAutoSave(e.target.checked)}),'自动保存'),h('small',{'aria-label':'自动保存状态'},({off:'已关闭',idle:'已同步',waiting:'待保存',saving:'保存中',paused:'已暂停'})[state.saveStatus]??''),h('strong',null,'提示词编辑'),draft?h('input',{'aria-label':'页面标题',value:draft.title,maxLength:200,onChange:e=>run(()=>model.patchTitle(e.target.value)),onKeyDown:e=>{if(!e.isComposing&&!e.nativeEvent?.isComposing&&e.keyCode!==229&&e.key==='Enter')e.target.blur();}}):null,
    h('span',{className:`mps-save-state ${state.dirty?'mps-dirty':''}`},state.busy?'处理中…':draft?`${state.dirty?'未保存':'已保存'} · r${state.page.revision}`:'未打开页面'),
    button('撤销',()=>run(()=>model.undo()),!state.undo.length),button('重做',()=>run(()=>model.redo()),!state.redo.length),button('保存',()=>run(()=>model.save()),editingDisabled||state.busy||state.mergeBlocked||!state.dirty),
    button('编译预览',()=>{setDrawer(true);run(()=>model.compile());},editingDisabled||state.busy),button(sideMode==='reference'?'返回属性':'参考图反推',()=>setSideMode(sideMode==='reference'?'properties':'reference'),!draft),button(sideMode==='archive'?'返回属性':'档案库',()=>{setSideMode(sideMode==='archive'?'properties':'archive');if(sideMode!=='archive')run(()=>model.loadArchives());},state.busy)), 
   notice||state.error?h('div',{className:`mps-message ${state.conflict?'mps-warning':''}`,role:'status'},notice||state.error):null,
   h('nav',{className:'mps-page-tabs',role:'tablist','aria-label':'页面标签',onKeyDown:navKeys},openTabs.map(page=>h('span',{key:page.page_id,className:'mps-button-row'},button(`${page.kind==='caption'?'C':'L'} · ${page.title}${model.hasDraft(page.page_id)?' ●':''}${page.pending_proposals>0?' 🔵':''}`,()=>openPage(page.page_id),false,{key:page.page_id,'aria-disabled':!!state.busy,'data-page-tab':page.page_id,role:'tab','aria-selected':page.page_id===state.page?.page_id,tabIndex:page.page_id===(openTabs.find(p=>p.page_id===state.page?.page_id)??openTabs[0])?.page_id?0:-1,'aria-current':page.page_id===state.page?.page_id?'page':undefined,title:page.pending_proposals?`${page.pending_proposals} 个待处理提案`:'双击改名',onDoubleClick:()=>!state.busy&&run(async()=>{await model.open(page.page_id,{keepDraft:true});const title=globalThis.prompt?.('页面新名称',page.title);if(title?.trim())model.patchTitle(title.trim());})}),model.closePageTab?button('×',()=>run(()=>model.closePageTab(page.page_id)),state.busy,{'aria-label':`关闭标签 ${page.title}`,title:'关闭标签，作品仍在左侧页面列表'}):null))),
   h('div',{className:'mps-columns'},
    h('aside',{className:'mps-left','aria-label':'系列页面与图层'},h('h3',null,'系列 / 页面'),
     field('系列',h('select',{value:state.seriesId,disabled:state.busy,onChange:e=>{const id=e.target.value;run(async()=>{if(state.autoSave&&state.dirty&&!state.conflict)await model.flushSave();else if(!confirmSwitch())return;await model.switchSeries(id,{keepDraft:true});});}},h('option',{value:''},'选择系列'),state.series.map(series=>h('option',{key:series.series_id,value:series.series_id},series.title)))),
     h('div',{className:'mps-inline-form'},h('input',{'aria-label':'新系列名称',value:seriesTitle,maxLength:200,placeholder:'新系列名称',onChange:e=>setSeriesTitle(e.target.value)}),button('新系列',()=>{if(confirmSwitch())run(()=>model.createSeries(seriesTitle.trim()).then(async series=>{setSeriesTitle('');await model.switchSeries(series.series_id,{keepDraft:true});}));},state.busy||!seriesTitle.trim())),
     h('div',{className:'mps-pages',role:'list'},state.pages.filter(p=>p.series_id===state.seriesId).map(page=>button(`${page.kind==='caption'?'C':'L'} · ${page.title}${model.hasDraft(page.page_id)?' ●':''}`,()=>openPage(page.page_id),state.busy,{key:page.page_id,className:`mps-page ${page.page_id===state.page?.page_id?'mps-active':''}`,'aria-current':page.page_id===state.page?.page_id?'page':undefined}))),
     h('div',{className:'mps-button-row'},button('系列改名',()=>{const current=state.series.find(s=>s.series_id===state.seriesId);const title=globalThis.prompt?.('系列新名称',current?.title??'');if(title?.trim())run(()=>model.renameSeries(title));},state.busy||!state.seriesId||!state.pageManagement),button('删除系列',()=>{if(globalThis.confirm?.('删除此系列及全部页面？历史保留在数据库，但列表不再显示。未保存草稿会阻止删除。'))run(()=>model.deleteSeries());},state.busy||!state.seriesId||!state.pageManagement)),
      state.pageManagement===false?h('small',{className:'mps-muted'},'当前Host为基础接口：相机预览、保存仍可用；高级分页删除待新版后端加载。'):null,
      h('div',{className:'mps-button-row'},button('上一页列表',()=>run(()=>model.loadPages(state.seriesId,Math.max(0,(state.pageOffset??0)-100))),state.busy||!(state.pageOffset>0)),h('small',null,`${state.pageTotal??state.pages.length} 页`),button('下一页列表',()=>run(()=>model.loadPages(state.seriesId,state.nextOffset)),state.busy||state.nextOffset==null)),
      h('input',{'aria-label':'新页面名称',value:pageTitle,maxLength:200,placeholder:'新页面名称（可选）',onChange:e=>setPageTitle(e.target.value)}),
     h('div',{className:'mps-button-row'},button('+ Layout',()=>createPage('layout'),state.busy||!state.seriesId),button('+ Caption',()=>createPage('caption'),state.busy||!state.seriesId),button('复制页面',()=>createPage(draft.doc.kind,true),state.busy||!draft),button('删除当前页',()=>{if(globalThis.confirm?.('删除当前页？未保存修改会阻止删除，历史不会物理清除。'))run(()=>model.deletePage());},state.busy||!draft||state.dirty||!state.pageManagement)), 
     h('details',null,h('summary',null,'系列画风 / 角色卡'),h(SeriesPanel,{key:`${state.seriesId}:${state.page?.page_id??''}`,model,state})),
      h('h3',null,'图层'),
     h('div',{className:'mps-button-row'},...['object','character','text'].map(label=>button(`+ ${typeLabels[label]}`,()=>run(()=>model.addItem(label)),!draft,{key:label}))),
     h('div',{className:'mps-button-row'},button('全选',()=>model.selectAll(),!draft),button('复制',()=>run(()=>model.copySelection()),!selected.length),button('删除',()=>run(()=>model.deleteSelection()),!selected.length)),
     h('div',{className:'mps-button-row'},button('成组',()=>run(()=>model.groupSelection()),selected.length<2),button('解组',()=>run(()=>model.ungroupSelection()),!selected.length),button('后移',()=>run(()=>model.orderSelection('backward')),!selected.length),button('前移',()=>run(()=>model.orderSelection('forward')),!selected.length),button('置底',()=>run(()=>model.orderSelection('back')),!selected.length),button('置顶',()=>run(()=>model.orderSelection('front')),!selected.length)),
     h('ul',{className:'mps-layers'},[...(layout?.items??[])].reverse().map(value=>h('li',{key:value.id,className:state.selected.includes(value.id)?'mps-selected':'',draggable:!value.locked,onDragStart:e=>{layerDrag.current=value.id;e.dataTransfer?.setData('text/plain',value.id);},onDragOver:e=>e.preventDefault(),onDrop:e=>{e.preventDefault();const id=layerDrag.current;layerDrag.current=null;if(id)run(()=>model.moveLayerTo(id,value.id));},onDragEnd:()=>{layerDrag.current=null;}},renaming===value.id?h('input',{'aria-label':'图层新名称',autoFocus:true,value:renameText,maxLength:200,onChange:e=>setRenameText(e.target.value),onBlur:()=>{run(()=>model.patchItem(value.id,{name:renameText}));setRenaming(null);},onKeyDown:e=>{if(e.isComposing||e.nativeEvent?.isComposing||e.keyCode===229)return;if(e.key==='Enter')e.target.blur();if(e.key==='Escape'){setRenaming(null);e.stopPropagation();}}}):button(value.role==='panel'?itemName(value):`${typeLabels[value.label]} · ${value.name||value.id.slice(0,8)}`,e=>model.select(value.id,e.shiftKey,e.altKey),false,{className:'mps-layer-name',onDoubleClick:()=>{if(!value.locked){setRenameText(value.name??'');setRenaming(value.id);}}}),value.group?button(`组 ${[...new Set(layout.items.map(i=>i.group).filter(Boolean))].indexOf(value.group)+1}`,()=>model.select(value.id),false,{className:'mps-group-badge'}):null,value.depth?h('small',null,value.depth):null,button(value.hidden?'显示':'隐藏',()=>run(()=>model.setItemFlag(value.id,'hidden',!value.hidden)),value.locked,{'aria-label':`${value.hidden?'显示':'隐藏'} ${value.name||value.id}`}),button(value.locked?'解锁':'锁定',()=>run(()=>model.setItemFlag(value.id,'locked',!value.locked)),false,{'aria-label':`${value.locked?'解锁':'锁定'} ${value.name||value.id}`})))),
     h('p',{className:'mps-muted'},'Shift 多选 · Alt 选组内单项 · V 选择 / R 画框 · Delete 删除。快捷键仅在工作台内且非文本输入时响应。')),
    h('main',{className:'mps-center'},
     h('div',{className:'mps-canvas-toolbar'},
      field('编辑模式',h('select',{value:draft?.doc.kind??'layout',disabled:!draft,onChange:e=>run(()=>model.setKind(e.target.value))},options([['layout','Layout 布局'],['caption','Caption 文本']]))),
      button(director?'返回画布':'镜头调度',()=>director?setDirector(false):enterDirector(),editingDisabled||draft?.doc.kind!=='layout'),
       button(freeCam?'退出自由镜头':'自由镜头 Shift+`',()=>{setFreeCam(!freeCam);if(!freeCam)run(()=>model.patchCamera({enabled:true}));},editingDisabled||draft?.doc.kind!=='layout',{'aria-pressed':freeCam}),h('label',null,h('input',{'aria-label':'主画布线框',type:'checkbox',checked:wire,onChange:e=>setWire(e.target.checked)}),'线框 / 地平线'),button('拉回选中',()=>run(()=>model.updateLayout(l=>returnStudioItemsToView(l,state.selected))),!selected.length||editingDisabled),
       button('选择 V',()=>{panelTools.cancel();annotations.cancel();model.setTool('select');},!draft,{'aria-pressed':!panelTools.active&&!annotations.active&&state.tool==='select'}),button('矩形 R',()=>{panelTools.cancel();annotations.cancel();model.setTool('draw');},!draft||cameraMoved,{'aria-pressed':!panelTools.active&&!annotations.active&&state.tool==='draw'}),
      field('新框类型',h('select',{value:state.drawLabel,onChange:e=>model.setDrawLabel(e.target.value)},options([['object','物体'],['character','角色'],['text','文字']]))),
      button('−',()=>model.setZoom(state.zoom/1.2),!draft,{'aria-label':'缩小'}),h('span',null,`${Math.round(state.zoom*100)}%`),button('+',()=>model.setZoom(state.zoom*1.2),!draft,{'aria-label':'放大'}),button('适应',()=>{const rect=stageRef.current?.getBoundingClientRect();if(rect)model.fit(rect.width,rect.height);},!draft)),
     panelTools.toolbar(),annotations.toolbar(),
     draft?h('div',{className:'mps-sizebar'},numberInput('宽',layout.width,v=>model.fitSize(v,layout.height),false,{min:16,max:4096,step:16}),numberInput('高',layout.height,v=>model.fitSize(layout.width,v),false,{min:16,max:4096,step:16}),field('分辨率',h('select',{'aria-label':'分辨率预设',value:`${layout.width}x${layout.height}`,onChange:e=>{const [w,h]=e.target.value.split('x').map(Number);run(()=>model.fitSize(w,h));}},h('option',{value:`${layout.width}x${layout.height}`},`${layout.width} × ${layout.height}`),...[[1024,1024],[1024,1536],[1536,1024],[1280,768],[1920,1088],[1088,1920],[768,768]].map(([w,height])=>h('option',{key:`${w}x${height}`,value:`${w}x${height}`},`${w} × ${height}`)))),button('横竖交换（等比适配）',()=>run(()=>model.fitSize(layout.height,layout.width))),button('查看总述',()=>model.clearSelection())):null,
     draft?resizeOptions():null,
     h('div',{className:'mps-stage',ref:stageRef},shapeCameraBlocked?h('p',{role:'alert','data-shape-camera-alert':true,className:'mps-message'},'移动相机后无法投影形状：请重置镜头或移除形状。受影响的形状不显示矩形替身；屏幕分镜和其它矩形仍可见。'):null,renderStage(),renderInline()),renderCompile()),
    h('aside',{className:'mps-right','aria-label':'属性与Agent提案'},h(TaskPanel,{model,state}),sideMode==='reference'?h(ReferencePanel,{model,state}):sideMode==='archive'?h(ArchivePanel,{model,state}):renderInspector()))));
 };
}
