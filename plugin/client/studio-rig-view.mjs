import { STUDIO_RIG_BUILDS, STUDIO_RIG_JOINTS, STUDIO_RIG_PRESETS, STUDIO_RIG_VIEWS, applyStudioRigOp, projectStudioRigs } from '../src/studio-rig.mjs';

const viewNames={camera:'出图机位',perspective:'透视观察',front:'正视',side:'侧视',top:'俯视'};
const buildNames={standard:'均衡',slender:'纤细',broad:'宽肩'};
const poseNames={rest:'站立',carry:'持伞',stride:'迈步',sit:'坐姿',reach:'伸手'};
const jointNames={hips:'骨盆',spine:'腰',chest:'胸',neck:'颈',head:'头',shoulder:'肩',elbow:'肘',wrist:'腕',hip:'髋',knee:'膝',ankle:'踝',toe:'脚尖'};
function jointLabel(j){
 if(!j)return '';
 const suffix=j.slice(-1);
 return suffix==='L'||suffix==='R'?(suffix==='L'?'左':'右')+jointNames[j.slice(0,-1)]:jointNames[j];
}
function canvasPoint(svg,event,layout){
 const matrix=svg?.getScreenCTM?.();
 if(matrix&&svg.createSVGPoint){
  const p=svg.createSVGPoint();p.x=event.clientX;p.y=event.clientY;
  const q=p.matrixTransform(matrix.inverse());return [q.x,q.y];
 }
 const rect=svg?.getBoundingClientRect?.();
 if(!rect?.width||!rect.height)return null;
 const scale=Math.min(rect.width/layout.width,rect.height/layout.height);
 return [(event.clientX-rect.left-(rect.width-layout.width*scale)/2)/scale,
  (event.clientY-rect.top-(rect.height-layout.height*scale)/2)/scale];
}
export function createStudioRigView(React){
 const h=React.createElement;
 return function StudioRigView({model,state}){
  const [view,setView]=React.useState('camera'),[figureId,setFigure]=React.useState(''),[propId,setProp]=React.useState('');
  const [joint,setJoint]=React.useState('wristR'),[notice,setNotice]=React.useState(''),[preview,setPreview]=React.useState(null);
  const svg=React.useRef(null),gesture=React.useRef(null);
  const doc=state.draft?.doc,layout=doc?.layout,visible=layout?.items.filter(i=>!i.hidden)??[];
  const figures=visible.filter(i=>i.label==='character'&&!i.shape),props=visible.filter(i=>i.label==='object'&&!i.shape&&!i.role&&!i.sketch&&!i.bubble);
  const figure=figures.find(i=>i.id===figureId)??figures.find(i=>state.selected?.includes(i.id))??figures[0];
  const prop=props.find(i=>i.id===propId)??props.find(i=>state.selected?.includes(i.id))??props[0];
  const bound=prop?.attachment?.holder_id===figure?.id;
  const frozen=state.editingBlocked||state.busy||state.controlPending||state.conflict;
  const figureBlocked=frozen||figure?.locked,propBlocked=figureBlocked||prop?.locked;
  const live=!!preview&&gesture.current?.guard.doc===doc;
  const rendered=live?preview:layout;
  let picture,error;
  if(rendered?.items.some(i=>i.rig)){
   try{picture=projectStudioRigs(rendered,view);}catch(e){error=e.message;}
  }
  React.useEffect(()=>()=>{gesture.current=null;},[state.page?.page_id]);
  const stop=event=>{event.preventDefault?.();event.stopPropagation?.();};
  function submit(target,op,fields={},guard){
   if(!target)return;
   try{
    const pending=model.applyRigOp({op,id:target.id,...fields},guard??model.capturePanelGuard());
    Promise.resolve(pending).then(()=>setNotice(''),e=>setNotice(e.message));
   }catch(e){setNotice(e.message);}
  }
  const button=(label,fn,disabled=false)=>h('button',{type:'button',onClick:fn,disabled},label);
  const select=(label,value,entries,onChange,disabled=false)=>h('label',null,label,
   h('select',{'aria-label':label,value,onChange:e=>onChange(e.target.value),disabled},
    ...entries.map(([id,name])=>h('option',{key:id,value:id},name))));
  function start(event,name){
   if(gesture.current||event.button!==0||figureBlocked||!figure?.rig||!picture?.joints.has(figure.id))return;
   stop(event);setJoint(name);
   if(name==='hips')return;
   const start=canvasPoint(svg.current,event,layout);if(!start)return;
   gesture.current={figure,view,joint:name,pointer:event.pointerId,start,guard:model.capturePanelGuard(),command:null};
   svg.current?.setPointerCapture?.(event.pointerId);
  }
  function move(event){
   const g=gesture.current;
   if(!g||event.pointerId!==g.pointer)return;
   stop(event);
   const target=canvasPoint(svg.current,event,g.guard.doc.layout);
   if(!target||g.guard.doc!==doc||frozen){cancel();return;}
   if(!g.command&&Math.hypot(target[0]-g.start[0],target[1]-g.start[1])<1)return;
   const command={op:'drag',id:g.figure.id,joint:g.joint,view:g.view,target};
   try{const next=applyStudioRigOp(g.guard.doc.layout,command);g.command=command;setPreview(next);setNotice('');}
   catch(e){g.command=null;setPreview(null);setNotice(e.message);}
  }
  function cancel(event){
   if(event?.pointerId!==undefined&&gesture.current?.pointer!==event.pointerId)return;
   gesture.current=null;setPreview(null);
  }
  function end(event){
   const g=gesture.current;if(!g||event.pointerId!==g.pointer)return;
   move(event);const command=gesture.current?.command;
   cancel();svg.current?.releasePointerCapture?.(event.pointerId);
   if(command)submit(g.figure,'drag',{joint:command.joint,view:command.view,target:command.target},g.guard);
  }
  function segments(group,color,key){
   return group.segments.map(([[x1,y1],[x2,y2]],i)=>h('line',{key:key+i,x1,y1,x2,y2,stroke:color,strokeWidth:2,vectorEffect:'non-scaling-stroke'}));
  }
  const sketch=[];
  for(const [id,shape] of picture?.joints??[]){
   const selected=figure?.id===id,c=selected?'#7ce2cd':'#aaa8ba';
   for(const part of shape.surfaces)sketch.push(h('polygon',{key:id+'surface-'+part.part,points:part.ring.map(p=>p.join(',')).join(' '),
    fill:selected?'#427e77':'#595767',stroke:c,strokeWidth:1,vectorEffect:'non-scaling-stroke','data-rig-body-part':part.part}));
   sketch.push(...segments(shape,c,id));
   if(shape.points.head)sketch.push(h('circle',{key:id+'head-ring',cx:shape.points.head[0],cy:shape.points.head[1],r:shape.headRadius,fill:'none',stroke:c}));
   if(selected)for(const [name,p] of Object.entries(shape.points))if(p){
    sketch.push(h('circle',{key:id+'-'+name,cx:p[0],cy:p[1],r:Math.max(4,layout.width*.009),
     fill:name===joint?'#ffcb70':c,'data-rig-joint':name,'aria-label':jointLabel(name),onPointerDown:e=>start(e,name)},h('title',null,jointLabel(name))));
   }
  }
  for(const [id,shape] of picture?.props??[])sketch.push(...segments(shape,'#ffb65c','prop-'+id));
  const field=(label,value,min,max,step,change,disabled)=>h('label',{key:label},label,h('input',{type:'number','aria-label':label,value,min,max,step,disabled,onChange:e=>{
   const n=e.target.valueAsNumber;if(Number.isFinite(n)&&n>=min&&n<=max)change(n);
  }}));
  function axesFields(vector,labels,min,max,step,onChange,disabled){
   return labels.map((label,i)=>field(label,Math.round(vector[i]*1000)/1000,min,max,step,n=>{
    const next=[...vector];next[i]=n;onChange(next);
   },disabled));
  }
  function upgrade(){
   try{Promise.resolve(model.enablePanelEditing()).catch(e=>setNotice(e.message));}catch(e){setNotice(e.message);}
  }
  return h('details',{className:'mps-rig-panel'},h('summary',null,'关节人偶与道具'),
   h('p',null,'拖动关节或输入局部旋转角度。切换观察视图只影响本窗口；生图使用当前后端可接受的构图信息。'),
   notice||error?h('p',{role:'alert'},notice||error):null,
   !doc||doc.kind!=='layout'?h('p',null,'打开 Layout 页面以编辑人偶。'):
   doc.schema_version!==2?button('启用富布局编辑',upgrade,frozen):
   !figures.length?h('p',null,'先在画布添加角色框。'):
   h('div',null,
    select('角色',figure.id,figures.map(i=>[i.id,i.name||i.id]),id=>{cancel();setFigure(id);}),
    !figure.rig?button('创建关节人偶',()=>submit(figure,'enable',{build:'standard'}),figureBlocked):
    h('div',null,
     select('观察视图',view,STUDIO_RIG_VIEWS.map(id=>[id,viewNames[id]]),v=>{cancel();setView(v);}),
     h('svg',{ref:svg,viewBox:`0 0 ${layout.width} ${layout.height}`,style:{width:'100%',height:'260px',background:'#212733',touchAction:'none'},role:'img',
      'aria-label':'关节人偶与挂接道具预览',tabIndex:0,onPointerMove:move,onPointerUp:end,onPointerCancel:cancel,onLostPointerCapture:cancel,
      onKeyDown:e=>{if(e.key==='Escape'&&gesture.current){stop(e);cancel();}}},...sketch),
     select('体型',figure.rig.build,STUDIO_RIG_BUILDS.map(id=>[id,buildNames[id]]),build=>submit(figure,'build',{build}),figureBlocked),
     h('div',{className:'mps-button-row'},...STUDIO_RIG_PRESETS.map(p=>h('button',{key:p,type:'button',disabled:figureBlocked,onClick:()=>submit(figure,'pose',{preset:p})},poseNames[p])),
      button('镜像姿态与道具',()=>submit(figure,'mirror'),figureBlocked)),
     select('编辑关节',joint,STUDIO_RIG_JOINTS.map(j=>[j,jointLabel(j)]),setJoint,figureBlocked),
     h('div',null,...axesFields(figure.rig.pose[joint]??[0,0,0],['局部 X°','局部 Y°','局部 Z°'],-180,180,1,
      angles=>submit(figure,'rotate',{joint,angles}),figureBlocked)),
     h('label',null,h('input',{type:'checkbox',checked:figure.rig.linked,disabled:figureBlocked,onChange:e=>submit(figure,'link',{enabled:e.target.checked})}),'联动到构图预览'),
     button('将出图机位投影写入框',()=>submit(figure,'bake'),figureBlocked),
     props.length?h('fieldset',null,h('legend',null,'道具挂接'),
      select('道具',prop.id,props.map(i=>[i.id,i.name||i.id]),setProp),
      button('挂在所选关节',()=>submit(prop,'attach',{holder_id:figure.id,joint,offset:bound?prop.attachment.offset:[0,0,0]}),propBlocked),
      bound?h('div',null,h('small',null,'当前挂接于'+jointLabel(prop.attachment.joint)),
       ...axesFields(prop.attachment.offset,['道具局部 X','道具局部 Y','道具局部 Z'],-2,2,.01,offset=>submit(prop,'offset',{offset}),propBlocked),
       button('解除道具挂接',()=>submit(prop,'detach'),propBlocked)):null):h('small',null,'添加物体框后可以挂到手腕等关节。'))));
 };
}
