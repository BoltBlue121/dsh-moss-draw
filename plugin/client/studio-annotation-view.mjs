import {studioAnnotationPrimitives,STUDIO_BUBBLE_STYLES} from '../src/studio-annotations.mjs';

import {studioPrimitiveSVG} from './studio-artwork.mjs';

const styleNames={oval:'对话',thought:'心声',narration:'旁白',shout:'咆哮'};
const coords=ps=>ps.map(p=>p.join(',')).join(' ');

export function renderStudioAnnotation(React,layout,item) {
  if(!item.bubble&&!item.sketch)return null;
  const h=React.createElement;
  return h('g',{key:item.id,'data-studio-annotation':item.id},studioAnnotationPrimitives(layout,item).map((p,i)=>{
    return studioPrimitiveSVG(React,p,i);
  }));
}

/** Tool gestures stay local until the release/confirm action. A control lease is acquired by the model at commit. */
export function useStudioAnnotationTools(React,{model,state,flat,svgRef,point,notice,onBegin}) {
  const h=React.createElement,[tool,show]=React.useState(null),current=React.useRef(null);
  const doc=state.draft?.doc,items=doc?.layout.items??[],selected=items.find(i=>state.selected?.length===1&&i.id===state.selected[0]);
  const ready=!!flat&&doc?.kind==='layout'&&doc.schema_version===2&&!state.editingBlocked&&!state.conflict&&!state.mergeBlocked
    &&state.page?.edit_policy?.mode!=='descriptions'&&!state.page?.editing_only;
  const set=next=>{current.current=next;show(next);};
  const cancel=()=>{if(current.current?.pending)return false;set(null);return true;};
  const patch=changes=>{if(current.current)set({...current.current,...changes});};
  const usable=t=>{const now=model.getSnapshot();return !!t&&ready&&t.model===model&&now.page?.page_id===t.guard.page_id&&now.page.revision===t.guard.revision&&now.draft?.doc===t.guard.doc;};
  React.useEffect(()=>{if(current.current&&!current.current.pending&&!usable(current.current))cancel();},[model,doc,ready,state.page?.revision,state.page?.page_id]);
  React.useEffect(()=>()=>{current.current=null;},[model]);
  const error=e=>notice(String(e?.message??e));
  function begin(mode){
    if(!ready||current.current?.pending)return;
    try{
      const edit=mode==='edit'?selected:null;
      if(mode==='edit'&&(!edit?.bubble||edit.hidden||edit.locked))return;
      if(onBegin?.()===false)return;
      set({model,guard:model.capturePanelGuard(),mode,style:edit?.bubble.style??'oval',text:edit?.text??'',
        bbox:edit?.bbox.slice()??null,tail:edit?.bubble.tail??null,id:edit?.id,
        layer:selected?.sketch?selected.id:null,color:'#252525',width:3,
        start:null,points:[],pointer:null,pickTail:false,pending:false});
    }catch(e){error(e);}
  }
  function send(t,cmd,keepBrush=false){
    if(!usable(t)||t.pending){notice('画稿版本已改变，请重新选择工具。');cancel();return;}
    const pending={...t,pending:true,pointer:null,start:null,points:[]};set(pending);
    let promise;
    try{promise=model.applyAnnotationOp(cmd,t.guard);}catch(e){set(t);error(e);return;}
    Promise.resolve(promise).then(result=>{
      if(current.current!==pending)return;
      const now=model.getSnapshot();
      if(keepBrush&&now.page?.page_id===t.guard.page_id){
        set({...pending,guard:model.capturePanelGuard(),layer:result.created_ids[0]??t.layer,pending:false});
      }else set(null);
    },e=>{if(current.current===pending){set({...t,pending:false,start:null,pointer:null,points:[]});error(e);}});
  }
  function pos(e){
    const [x,y]=point(e),layout=doc.layout;
    return [Math.max(0,Math.min(layout.width,x)),Math.max(0,Math.min(layout.height,y))];
  }
  function box(a,b){return [Math.min(a[0],b[0]),Math.min(a[1],b[1]),Math.max(a[0],b[0]),Math.max(a[1],b[1])];}
  function down(e){
    const t=current.current;if(!usable(t)||t.pending||e.button!==0||t.pointer!==null)return;
    e.preventDefault();e.stopPropagation();const p=pos(e);
    if(t.pickTail){patch({tail:{point:p},pickTail:false});return;}
    if(t.mode==='edit')return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    patch({pointer:e.pointerId,start:p,points:[p]});
  }
  function move(e){
    const t=current.current;if(!usable(t)||t.pending||t.pointer!==e.pointerId)return;
    e.stopPropagation();const p=pos(e);
    if(t.mode==='sketch'){
      const last=t.points.at(-1);if(last&&last[0]===p[0]&&last[1]===p[1])return;
      if(t.points.length>=1024){patch({pointer:null,start:null,points:[]});notice('单笔上限 1024 点，本笔已取消。');return;}
      patch({points:[...t.points,p]});
    }else patch({bbox:box(t.start,p)});
  }
  function release(e){
    const t=current.current;if(!usable(t)||t.pending||t.pointer!==e.pointerId)return;
    e.stopPropagation();const p=pos(e);
    if(t.mode==='sketch'){
      const ps=t.points.slice(),last=ps.at(-1);
      if(!last||last[0]!==p[0]||last[1]!==p[1])ps.push(p);
      send(t,{op:'sketch_stroke',layer_id:t.layer,color:t.color,width:t.width,points:ps},true);
    }else{
      const bbox=box(t.start,p);
      patch({pointer:null,start:null,points:[],bbox:bbox[0]<bbox[2]&&bbox[1]<bbox[3]?bbox:null});
    }
  }
  function interrupted(e){if(current.current?.pointer===e.pointerId)patch({pointer:null,start:null,points:[]});}
  function commitBubble(t){
    if(!t.bbox||t.pending)return;
    const settings={style:t.style,text:t.text,tail:t.tail};
    send(t,t.mode==='edit'?{op:'bubble_edit',id:t.id,...settings}:{op:'bubble_create',bbox:t.bbox,...settings});
  }
  const button=(label,cb,disabled=false)=>h('button',{type:'button',disabled,onClick:cb},label);
  const choices=items.filter(i=>i.label==='character'&&!i.hidden);
  const live=tool&&(tool.pending||usable(tool))?tool:null;
  function toolbar(){
    const t=live;
    return h('section',{'aria-label':'对白与草图'},
      button('画气泡',()=>begin('bubble'),!ready),button('编辑选中气泡',()=>begin('edit'),!ready||!selected?.bubble||selected.hidden||selected.locked),
      button('画草图',()=>begin('sketch'),!ready),!t?null:h('fieldset',{disabled:t.pending},
        h('legend',null,t.mode==='sketch'?'草图笔':t.mode==='edit'?'编辑对白':'拖动画布圈出气泡范围'),
        t.mode==='sketch'?h('div',null,h('label',null,'笔色',h('input',{type:'color',value:t.color,onChange:e=>patch({color:e.target.value})})),
          h('label',null,'笔宽（像素）',h('input',{type:'number',min:.25,max:64,step:.25,value:t.width,onChange:e=>patch({width:Number(e.target.value)})})),
          button('清空当前草图层',()=>send(t,{op:'sketch_clear',layer_id:t.layer}),!t.layer))
        :h('div',null,h('label',null,'气泡样式',h('select',{value:t.style,onChange:e=>{const style=e.target.value;patch({style,...(['thought','narration'].includes(style)?{tail:null,pickTail:false}:{})});}},
            STUDIO_BUBBLE_STYLES.map(id=>h('option',{key:id,value:id},styleNames[id])))),
          h('label',null,'对白',h('textarea',{value:t.text,maxLength:12000,onChange:e=>patch({text:e.target.value})})),
          ['oval','shout'].includes(t.style)?h('div',null,h('label',null,'绑定说话人',h('select',{value:t.tail?.speaker_id??'',onChange:e=>patch({tail:e.target.value?{speaker_id:e.target.value,anchor:[.5,.3]}:null,pickTail:false})},
            h('option',{value:''},'无绑定'),choices.map(i=>h('option',{key:i.id,value:i.id},i.name||i.id)))),
            button(t.pickTail?'点击画布设置尾尖':'手动定位尾尖',()=>patch({pickTail:!t.pickTail})),button('清除尾巴',()=>patch({tail:null,pickTail:false}),!t.tail)):null,
          button('应用气泡',()=>commitBubble(t),!t.bbox)),button('结束工具',cancel)));
  }
  function overlay(){
    const t=live;if(!t||t.pending)return null;
    const children=[];
    if(t.mode==='sketch'&&t.points.length)children.push(h('polyline',{key:'ink',points:coords(t.points),fill:'none',stroke:t.color,strokeWidth:t.width,pointerEvents:'none'}));
    if(t.mode!=='sketch'&&t.bbox&&t.bbox[2]>t.bbox[0]&&t.bbox[3]>t.bbox[1]){
      const ghost=renderStudioAnnotation(React,doc.layout,{id:'draft',label:'text',bbox:t.bbox,text:t.text,bubble:{style:t.style,...(t.tail?{tail:t.tail}:{})}});
      children.push(h('g',{key:'draft',opacity:.7,pointerEvents:'none'},ghost));
    }
    return h('g',{key:'annotation-tool','data-annotation-tool':t.mode},
      h('rect',{x:0,y:0,width:doc.layout.width,height:doc.layout.height,fill:'transparent',style:{touchAction:'none',cursor:'crosshair'},
        onPointerDown:down,onPointerMove:move,onPointerUp:release,onPointerCancel:interrupted,onLostPointerCapture:interrupted,
        onDoubleClick:e=>e.stopPropagation()}),...children);
  }
  function keyDown(e){
    if(!live||e.isComposing||e.keyCode===229||/^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName))return false;
    if(e.key!=='Escape')return false;e.stopPropagation();e.preventDefault();cancel();return true;
  }
  return {active:!!live,cancel,keyDown,toolbar,overlay};
}
