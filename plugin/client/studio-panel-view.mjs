import {STUDIO_FRAME_TEMPLATES,studioPageSuggestions} from '../src/studio-page-assist.mjs';
import {studioPanelShapeDescription} from '../src/studio-shape-render.mjs';

// Gesture previews stay local until one complete command is sent to the shared model.
const names = {polygon:'多边形', lasso:'套索', knife:'分镜刀',vertex:'顶点编辑'};
const equalPoint = (a,b) => a[0]===b[0] && a[1]===b[1];

function knifeEnd(start, end, snap) {
  if (!snap) return end;
  const dx=end[0]-start[0], dy=end[1]-start[1], distance=Math.hypot(dx,dy);
  const angle=Math.round(Math.atan2(dy,dx)/(Math.PI/12))*Math.PI/12;
  return [start[0]+distance*Math.cos(angle),start[1]+distance*Math.sin(angle)];
}

export function useStudioPanelTools(React, {model,state,flat,svgRef,point,notice,onBegin,onTemplatePage}) {
  const h=React.createElement;
  const [draft,show]=React.useState(null), live=React.useRef(null), frame=React.useRef(null);
  const [preset,setPreset]=React.useState('diagonal'),[templateGap,setTemplateGap]=React.useState(4);
  const [threshold,setThreshold]=React.useState(18),[checking,setChecking]=React.useState(false);
  const doc=state.draft?.doc, isLayout=doc?.kind==='layout';
  const enabled=!!(isLayout && flat && !state.editingBlocked && !state.conflict && !state.mergeBlocked &&
    state.page?.edit_policy?.mode!=='descriptions' && !state.page?.editing_only);
  const ready=enabled && doc.schema_version===2;
  const panels=isLayout?doc.layout.items.filter(item=>item.role==='panel' && !item.hidden):[];
  const selected=panels.find(item=>!item.locked && state.selected.length===1 && state.selected[0]===item.id);
  const canCut=!!selected || !panels.length;
  function set(next) {live.current=next;show(next);}
  function samePage(tool) {
    const now=model.getSnapshot();
    return ready && tool?.model===model && tool.doc===now.draft?.doc &&
      tool.pageId===now.page?.page_id && tool.revision===now.page?.revision;
  }
  const current=draft && samePage(draft)?draft:null;
  React.useEffect(()=>{
    if (live.current && !samePage(live.current)) set(null);
  },[model,doc,state.page?.page_id,state.page?.revision,ready]);
  function clearFrame() {
    if (frame.current!==null) globalThis.cancelAnimationFrame(frame.current.id);
    frame.current=null;
  }
  React.useEffect(()=>()=>{clearFrame();live.current=null;},[model]);
  function clearTool() {clearFrame();set(null);}
  const cancel=()=>{if (live.current?.pending) return false;clearTool();return true;};
  const button=(label,click,disabled=false,props={})=>h('button',{type:'button',disabled,onClick:click,...props},label);
  const handleError=error=>notice(String(error?.message??error));

  function begin(kind) {
    if (!ready || live.current?.pending || (kind==='knife' && !canCut) || (kind==='vertex' && !selected?.shape)) return;
    try {
      clearFrame();
      const {layout}=doc, guard=model.capturePanelGuard();
      if (onBegin?.()===false) return;
      set({model,pageId:state.page.page_id,revision:state.page.revision,doc,guard,
        kind,target:kind==='knife'||kind==='vertex'?selected?.id??null:null,points:[],
        index:0,constraint:'none',scale:[100,100],
        cursor:kind==='vertex'?[...selected.shape.ring[0]]:[layout.width/2,layout.height/2],
        gutter:8,tolerance:2,snap:false,start:null,pointerId:null,pending:false,preview:null,error:''});
      svgRef.current?.focus?.();
    } catch(error) {handleError(error);}
  }

  function command(tool) {
    if(tool.kind==='vertex') return {op:'move_vertex',target_id:tool.target,index:tool.index,to:tool.cursor,constraint:tool.constraint};
    if (tool.kind==='knife') return {op:'knife',target_id:tool.target,
      start:tool.start,end:knifeEnd(tool.start,tool.cursor,tool.snap),gutter_px:tool.gutter};
    if (tool.kind==='lasso') return {op:'lasso',points:tool.points,tolerance_px:tool.tolerance};
    return {op:'polygon',points:tool.points};
  }

  function preview(tool) {
    if (tool.kind!=='vertex' && (tool.kind!=='knife'||!tool.start||equalPoint(tool.start,tool.cursor))) return {...tool,preview:null,error:''};
    try {
      const result=model.previewPanelOp(command(tool)), report=result.reports[0];
      const pieces=new Map(result.doc.layout.items.map(item=>[item.id,item]));
      if(tool.kind==='vertex') return {...tool,preview:[pieces.get(tool.target).shape.ring],error:''};
      const rings=report.pieces.map(piece=>pieces.get(piece.item_id).shape.ring);
      return {...tool,preview:rings,error:rings.length?'':'切线尚未把目标分成两片。'};
    } catch(error) {return {...tool,preview:null,error:String(error.message??error)};}
  }
  function update(tool,changes) {set(preview({...tool,...changes}));}

  function submit(tool,explicit) {
    if (!tool || tool.pending || !samePage(tool)) return;
    try {
      if (tool.kind==='knife' && (!tool.start || equalPoint(tool.start,tool.cursor))) {
        set({...tool,pointerId:null,preview:null,error:''});return;
      }
      const op=explicit??command(tool);
      const result=model.previewPanelOp(op);
      if (result.reports[0]?.status==='NO_SPLIT') {
        set({...tool,pointerId:null,start:null,preview:null,error:'未切开分镜，请调整切线。'});return;
      }
      set({...tool,pending:true,pointerId:null});
      Promise.resolve(model.applyPanelOp(op,tool.guard)).then(()=>{
        if (live.current?.guard===tool.guard) clearTool();
      },error=>{
        if (live.current?.guard===tool.guard) set({...tool,pending:false,pointerId:null});
        handleError(error);
      });
    } catch(error) {set({...tool,pending:false,pointerId:null,preview:null,error:String(error.message??error)});}
  }
  function append(tool,position) {
    if (tool.points.length && equalPoint(tool.points.at(-1),position)) return tool;
    const limit=tool.kind==='lasso'?1024:128;
    if (tool.points.length>=limit) throw Error(`最多可记录 ${limit} 个点，请撤回一点或取消重画。`);
    return {...tool,points:[...tool.points,position],cursor:position,error:''};
  }
  function record(tool,position) {
    if (!tool || tool.pending || !samePage(tool)) return;
    if (tool.kind==='vertex') submit({...tool,cursor:position});
    else if (tool.kind==='knife') {
      if (tool.start) submit({...tool,cursor:position});else update(tool,{start:position,cursor:position});
    } else {
      try {set(append(tool,position));} catch(error){handleError(error);}
    }
  }
  function down(event) {
    const tool=live.current;
    if (event.button!==0 || !samePage(tool) || tool.pending || tool.pointerId!==null) return;
    event.stopPropagation();event.preventDefault();svgRef.current?.focus?.();
    const position=point(event);
    if (tool.kind==='vertex') return;
    if (tool.kind==='polygon') {
      if (tool.points.length>=3 && Math.hypot(position[0]-tool.points[0][0],position[1]-tool.points[0][1])*state.zoom<=6) submit(tool);
      else record(tool,position);
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    set({...tool,cursor:position,start:tool.kind==='knife' && tool.start?tool.start:position,pointerId:event.pointerId,points:tool.kind==='lasso'?[position]:[],
      preview:null,error:''});
  }
  function move(event) {
    const tool=live.current;
    if (!samePage(tool)||tool.pending || (tool.pointerId!==null && tool.pointerId!==event.pointerId)) return;
    if(tool.kind==='vertex' && tool.pointerId===null) return;
    const position=point(event);
    if (tool.kind==='lasso' && tool.pointerId!==null) {
      try {set(append(tool,position));} catch(error){cancel();handleError(error);}
    } else if ((tool.kind==='vertex' || tool.kind==='knife' && tool.start) && typeof globalThis.requestAnimationFrame==='function') {
      // Multiple pointer packets in one frame need only one exact polygon cut.
      if (frame.current) {frame.current.position=position;return;}
      const queued={position,id:0};
      frame.current=queued;
      queued.id=globalThis.requestAnimationFrame(()=>{
        frame.current=null;
        const latest=live.current;
        if (samePage(latest) && !latest.pending && latest.guard===tool.guard && (latest.start || latest.kind==='vertex'))
          update(latest,{cursor:queued.position});
      });
    } else update(tool,{cursor:position});
  }
  function release(event) {
    const tool=live.current;
    if (!samePage(tool)||tool.pending || tool.pointerId===null || tool.pointerId!==event.pointerId) return;
    clearFrame();
    event.preventDefault();event.stopPropagation();
    try {
      const cursor=point(event);
      submit(tool.kind==='lasso'?append(tool,cursor):{...tool,cursor});
    } catch(error) {cancel();handleError(error);}
  }
  function interrupt(event) {
    const tool=live.current;
    if (tool && tool.pointerId!==null && tool.pointerId===event.pointerId) cancel();
  }
  function vertexDown(event,index) {
    const tool=live.current;
    if (!samePage(tool)||tool.pending||tool.pointerId!==null||event.button!==0) return;
    event.stopPropagation();event.preventDefault();svgRef.current?.focus?.();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const source=doc.layout.items.find(item=>item.id===tool.target);
    set({...tool,index,cursor:source.shape.ring[index],pointerId:event.pointerId,preview:null,error:''});
  }

  function keyDown(event) {
    if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode===229 ||
      event.target?.closest?.('input,textarea,select,[contenteditable="true"]')) return false;
    const key=event.key.toLowerCase(), tool=live.current;
    const stop=()=>{event.preventDefault();event.stopPropagation();return true;};
    if(!tool) {
      if (event.altKey||event.ctrlKey||event.metaKey||!ready || (key!=='p' && key!=='k' && key!=='l')) return false;
      if (key==='k' && !canCut) return false;
      begin({p:'polygon',k:'knife',l:'lasso'}[key]);return stop();
    }
    if (!samePage(tool)) {cancel();return false;}
    if (key==='escape') {if (!tool.pending) cancel();return stop();}
    if ((event.ctrlKey||event.metaKey) && key==='z' && !event.shiftKey && !event.altKey) {
      if (!tool.pending) update(tool,{points:tool.points.slice(0,-1),start:null});
      return stop();
    }
    if (key==='v'||key==='r'||key==='f') {cancel();return false;}
    if (event.altKey||event.ctrlKey||event.metaKey) return false;
    if (tool.pending) return false;
    // Text fields and buttons retain their native keyboard interaction.
    if (event.target?.closest?.('button') && (key==='enter'||key===' ')) return false;
    if (key==='enter') {submit(tool);return stop();}
    if (key===' ') {record(tool,tool.cursor);return stop();}
    if (key==='backspace') {update(tool,{points:tool.points.slice(0,-1),start:null});return stop();}
    const direction={arrowleft:[-1,0],arrowright:[1,0],arrowup:[0,-1],arrowdown:[0,1]}[key];
    if (direction) {
      const step=event.shiftKey?10:1;
      update(tool,{cursor:tool.cursor.map((v,i)=>v+direction[i]*step)});return stop();
    }
    return false;
  }

  function toolbar() {
    if (!isLayout) return null;
    if (doc.schema_version!==2) return button('启用分镜编辑（升级本页）',()=>{
      try {Promise.resolve(model.enablePanelEditing()).catch(handleError);} catch(error){handleError(error);}
    },!enabled,{title:'保留旧修订，启用可编辑的分镜图形'});
    const tool=current;
    const input=(label,value,change,props={})=>h('label',null,label,h('input',{type:'number','aria-label':label,disabled:tool?.pending,
      value,onChange:e=>{if(e.target.value!=='' && Number.isFinite(e.target.valueAsNumber))change(e.target.valueAsNumber);},...props}));
    function applyPage(cmd) {
      if(!ready || doc!==model.getSnapshot().draft?.doc)return;
      try {Promise.resolve(model.applyPanelOp(cmd,model.capturePanelGuard())).catch(handleError);}
      catch(error){handleError(error);}
    }
    const checks=checking?studioPageSuggestions(doc):[];
    const inspected=state.selected.length===1?panels.find(panel=>panel.id===state.selected[0]):null;
    const shape=inspected?studioPanelShapeDescription(inspected.shape.ring):null;
    return h('div',{className:'mps-panel-tools','aria-label':'分镜编辑工具'},
      shape?h('p',{'aria-label':'选中分镜轮廓'},h('strong',null,shape.badge),shape.detail?' · '+shape.detail:''):null,
      h('div',{className:'mps-button-row'},
        button('多边形 P',()=>begin('polygon'),!ready,{'aria-pressed':tool?.kind==='polygon'}),
        button('套索 L',()=>begin('lasso'),!ready,{'aria-pressed':tool?.kind==='lasso'}),
        button('分镜刀 K',()=>begin('knife'),!ready||!canCut,{'aria-pressed':tool?.kind==='knife',
          title:canCut?(selected?'切选中的分镜':'直接切分整页'):'请选择一个可见、未锁定的分镜'}),
        button('编辑分镜顶点',()=>begin('vertex'),!ready||!selected?.shape,{'aria-pressed':tool?.kind==='vertex'})),
      h('details',null,h('summary',null,'版式模板 / 顶边对齐 / 排版检查'),
        h('div',{className:'mps-button-row'},
          h('label',null,'版式',h('select',{'aria-label':'页版式模板',value:preset,onChange:e=>setPreset(e.target.value)},
            ...Object.entries(STUDIO_FRAME_TEMPLATES).map(([id,name])=>h('option',{key:id,value:id},name)))),
          input('模板格间距',templateGap,setTemplateGap,{min:0,step:'any'}),
          button('在当前页添加版式',()=>applyPage({op:'template',preset,gutter_px:templateGap}),
            !ready||!!tool||doc.layout.items.some(i=>i.role==='panel')||preset==='blank',
            {title:'保留已有角色、对白与修订。已有分镜时可另建模板页。'}),
          button('新建模板页',()=>{try{Promise.resolve(onTemplatePage(preset,templateGap)).catch(handleError);}catch(e){handleError(e);}},
            !onTemplatePage||!state.seriesId||!!tool||state.busy)),
        h('div',{className:'mps-button-row'},
          input('顶边对齐阈值（像素）',threshold,setThreshold,{min:0,max:1024,step:'any'}),
          button('并排选中格顶边对齐',()=>applyPage({op:'align_row',ids:state.selected,threshold_px:threshold}),
            !ready||!!tool||state.selected.length<2||state.selected.some(id=>!panels.some(i=>i.id===id&&!i.locked))),
          button(checking?'收起排版检查':'检查版式和文字',()=>setChecking(!checking),false,{'aria-expanded':checking})),
        checking?h('div',{'aria-label':'排版建议'},...checks.map((finding,i)=>h('div',{key:i},
          h('span',null,finding.message),finding.command?button('应用此项',()=>applyPage(finding.command),!ready||!!tool):
          button('选中图层',()=>model.select(finding.target_id,false,true),!ready||!!tool))),
          !checks.length?h('p',{role:'status'},'当前没有排版建议。'):null):null),
      tool?.kind==='vertex'?vertexControls(tool,input):tool?h('div',{'aria-label':`${names[tool.kind]}参数`},
        h('p',{className:'mps-muted'},tool.kind==='knife'
          ?`目标：${panels.find(item=>item.id===tool.target)?.name||tool.target||'整页'}。拖动预览，松手切分；也可分别点击或输入起终点。`
          :tool.kind==='polygon'?'逐点绘制，点击首点或 Enter 闭合。':'沿轮廓拖动，松手闭合。也可逐点输入。'),
        h('div',{className:'mps-button-row'},
          input('点 X',tool.cursor[0],v=>update(tool,{cursor:[v,tool.cursor[1]]}),{step:'any'}),
          input('点 Y',tool.cursor[1],v=>update(tool,{cursor:[tool.cursor[0],v]}),{step:'any'}),
          tool.kind==='knife'?input('格间距（像素）',tool.gutter,v=>update(tool,{gutter:v}),{min:0,max:1024,step:'any'}):null,
          tool.kind==='knife'?h('label',null,h('input',{type:'checkbox',disabled:tool.pending,checked:tool.snap,onChange:e=>update(tool,{snap:e.target.checked})}),'15° 吸附'):null,
          tool.kind==='lasso'?input('简化容差（像素）',tool.tolerance,v=>update(tool,{tolerance:v}),{min:0,step:'any'}):null,
          button(tool.kind==='knife'?(tool.start?'按当前终点切割':'设为起点'):'添加顶点',()=>record(tool,tool.cursor),tool.pending),
          tool.kind!=='knife'?button('撤回一点',()=>update(tool,{points:tool.points.slice(0,-1)}),tool.pending||!tool.points.length):null,
          tool.kind!=='knife'?button('闭合分镜',()=>submit(tool),tool.pending||tool.points.length<3):null,
          button('取消绘制',cancel,tool.pending)),
        h('small',{role:'status'},tool.error|| (tool.kind==='knife'?(tool.preview?.length?`将得到 ${tool.preview.length} 个分镜`:''):`已记录 ${tool.points.length} 个点`))):null);
  }

  function vertexControls(tool,input) {
    const item=doc.layout.items.find(value=>value.id===tool.target),ring=item.shape.ring;
    const [l,t,r,b]=item.bbox,pivot=[(l+r)/2,(t+b)/2];
    const apply=(op,params={})=>submit(tool,{op,target_id:item.id,...params});
    return h('div',{'aria-label':'分镜顶点与变形'},
      h('p',{className:'mps-muted'},'拖动一个顶点，预览有效轮廓后松手。也可选顶点并输入坐标。'),
      h('div',{className:'mps-button-row'},
        h('label',null,'顶点',h('select',{'aria-label':'当前顶点',value:tool.index,disabled:tool.pending,
          onChange:e=>{const index=Number(e.target.value);update(tool,{index,cursor:[...ring[index]]});}},
          ...ring.map((_,i)=>h('option',{key:i,value:i},String(i+1))))),
        input('点 X',tool.cursor[0],v=>update(tool,{cursor:[v,tool.cursor[1]]}),{step:'any'}),
        input('点 Y',tool.cursor[1],v=>update(tool,{cursor:[tool.cursor[0],v]}),{step:'any'}),
        ring.length===4?h('label',null,h('input',{type:'checkbox',checked:tool.constraint==='quad',disabled:tool.pending,
          onChange:e=>update(tool,{constraint:e.target.checked?'quad':'none'})}),'保持凸四角'):null,
        button('应用顶点',()=>submit(tool),tool.pending||!!tool.error),
        button('恢复矩形',()=>apply('reset_rect'),tool.pending),
        button('右转 90°',()=>apply('rotate',{pivot,quarter_turns:1}),tool.pending)),
      h('div',{className:'mps-button-row'},
        input('横向比例 %',tool.scale[0],v=>set({...tool,scale:[v,tool.scale[1]]}),{step:'any'}),
        input('纵向比例 %',tool.scale[1],v=>set({...tool,scale:[tool.scale[0],v]}),{step:'any'}),
        button('绕中心缩放',()=>apply('scale',{pivot,scale:tool.scale.map(value=>value/100)}),tool.pending),
        button('退出顶点编辑',cancel,tool.pending)),
      tool.error?h('small',{role:'status'},tool.error):null);
  }

  function overlay() {
    const tool=current;
    if(!tool) return null;
    const z=state.zoom, stroke='#9342ac', display={pointerEvents:'none',stroke,strokeWidth:2/z,fill:'none'};
    const pair=tool.kind==='knife' && tool.start?[tool.start,knifeEnd(tool.start,tool.cursor,tool.snap)]:[...tool.points,tool.cursor];
    const vertices=tool.kind==='vertex'?doc.layout.items.find(item=>item.id===tool.target).shape.ring:[];
    const coords=points=>points.map(p=>p.join(',')).join(' ');
    return h('g',{key:'panel-tool',className:'mps-draw-mode','data-panel-tool':tool.kind},
      h('rect',{x:0,y:0,width:doc.layout.width,height:doc.layout.height,fill:'transparent',style:{touchAction:'none',cursor:'crosshair'},
        onPointerDown:down,onPointerMove:move,onPointerUp:release,onPointerCancel:interrupt,onLostPointerCapture:interrupt,
        onDoubleClick:e=>e.stopPropagation()}),
      ...(tool.preview??[]).map((ring,i)=>h('polygon',{...display,key:i,[tool.kind==='vertex'?'data-panel-vertex-preview':'data-panel-cut-piece']:i,points:coords(ring),fill:stroke,fillOpacity:.15})),
      h('polyline',{...display,points:coords(pair),strokeDasharray:`${5/z} ${3/z}`}),
      tool.points.length?h('circle',{...display,cx:tool.points[0][0],cy:tool.points[0][1],r:4/z,fill:'#fff'}):null,
      h('circle',{...display,cx:tool.cursor[0],cy:tool.cursor[1],r:3/z,fill:stroke}),
      ...vertices.map((p,i)=>h('circle',{key:'v'+i,'data-panel-vertex':i,
        cx:i===tool.index?tool.cursor[0]:p[0],cy:i===tool.index?tool.cursor[1]:p[1],r:5/z,fill:i===tool.index?stroke:'#fff',
        stroke,strokeWidth:1.5/z,style:{touchAction:'none',cursor:'move'},onPointerDown:e=>vertexDown(e,i),
        onPointerMove:move,onPointerUp:release,onPointerCancel:interrupt,onLostPointerCapture:interrupt})));
  }
  return {active:!!current,cancel,keyDown,toolbar,overlay};
}

