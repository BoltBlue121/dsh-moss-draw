import test from 'node:test';
import assert from 'node:assert/strict';
import {emptyStudioDoc} from '../src/studio-domain.mjs';
import {studioBody,studioCameraFrame,projectStudioLayout} from '../src/studio-camera.mjs';
import {moveStudioVisual} from '../client/studio-layout.mjs';
import {createStudioModel} from '../client/studio-model.mjs';
import {loadStudioPreferences,prefixedStudioPrompt,studioAssistStats,studioAssistRequest} from '../client/studio-preferences.mjs';
const item=(id,z=1)=>({id,label:'object',caption:'A box',bbox:[200,200,400,400],body:{z,thickness:0,yaw:0,anchor:'world'}});
async function modelFor(doc){let sent='';const m=createStudioModel({request:async()=>({page_id:'p',series_id:'s',title:'P',revision:1,proposals:[],doc}),prompt:async text=>{sent=text;}},{localCompile:true,preferenceStorage:{getItem:()=>null,setItem(){}}});await m.open('p');return{m,sent:()=>sent};}
test('projected group drag follows the grabbed member at a different depth without reordering',()=>{
 const l=emptyStudioDoc().layout;l.items=[{...item('a'),group:'g'},{...item('b',2),group:'g',bbox:[500,300,700,500]}];l.camera={enabled:true,orbit:20,distance:1.4};
 const before=projectStudioLayout(l),r=moveStudioVisual(l,['a','b'],30,12,{grabId:'b'}),after=projectStudioLayout(r);
 assert.deepEqual(r.items.map(i=>i.id),['a','b']);const center=b=>[(b[0]+b[2])/2,(b[1]+b[3])/2];const delta=center(after.items.b.raw).map((v,k)=>v-center(before.items.b.raw)[k]);assert.ok(Math.abs(delta[0]-30)<.01&&Math.abs(delta[1]-12)<.01);
});
test('moving implicit backdrop freezes its anchor and preserves physical camera frame',()=>{
 const l=emptyStudioDoc().layout;l.items=[{id:'b',label:'object',caption:'Backdrop',bbox:[0,0,1024,1024]}];l.camera={enabled:true,orbit:20,distance:2};const r=moveStudioVisual(l,['b'],300,200);assert.equal(studioBody(r.items[0],r).anchor,'backdrop');assert.deepEqual(studioCameraFrame(r),studioCameraFrame(l));
});
test('layer drop is undoable and cannot cross locked barriers',async()=>{
 const d=emptyStudioDoc();d.layout.items=[item('a'),item('b'),{...item('c'),locked:true}];const {m}=await modelFor(d);m.moveLayerTo('a','b');assert.deepEqual(m.getSnapshot().draft.doc.layout.items.map(i=>i.id),['b','a','c']);m.undo();assert.deepEqual(m.getSnapshot().draft.doc.layout.items,d.layout.items);assert.throws(()=>m.moveLayerTo('a','c'),/STUDIO_LOCKED/);assert.deepEqual(m.getSnapshot().draft.doc.layout.items,d.layout.items);m.dispose();
});
test('resize from gesture origin preserves aspect across multiple pointer updates and cancellation',async()=>{
 const d=emptyStudioDoc();d.layout.items=[{...item('a'),bbox:[100,100,300,200]}];const {m}=await modelFor(d);m.beginGesture();m.resizeItem('a','se',40,20,{origin:[100,100,300,200],aspect:true});m.resizeItem('a','se',60,30,{origin:[100,100,300,200],aspect:true});assert.deepEqual(m.getSnapshot().draft.doc.layout.items[0].bbox,[100,100,360,230]);m.endGesture(true);assert.deepEqual(m.getSnapshot().draft.doc.layout.items,d.layout.items);m.dispose();
});
test('compile preferences survive model recreation without changing Doc or server request schema',async()=>{
 const data=new Map(),storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)},d=emptyStudioDoc('caption');d.caption.caption='A scene';const {m}=await modelFor(d);m.setPreferences({prefix:'fine detail,',negative:'blur',autoCompile:false});await m.compile();assert.equal(m.getSnapshot().compiled.negative,'blur');assert.equal(m.getSnapshot().dirty,false);assert.equal(prefixedStudioPrompt(m.getSnapshot().compiled.prefix,m.getSnapshot().compiled.prompt),'fine detail, A scene');
 const {saveStudioPreferences}=await import('../client/studio-preferences.mjs');saveStudioPreferences(m.getSnapshot().preferences,storage);assert.deepEqual(loadStudioPreferences(storage),m.getSnapshot().preferences);assert.equal(loadStudioPreferences({getItem(){throw Error('blocked');}}).prefix,'');m.dispose();
});
test('agent requests include selected ids and current camera without sending a full document',async()=>{
 const d=emptyStudioDoc();d.layout.items=[item('a')];d.layout.camera={enabled:true,orbit:30};const {m,sent}=await modelFor(d);m.select('a');await m.sendToAgent('检查这项');assert.match(sent(),/selection=\["a"\]/);assert.match(sent(),/30 degree/);assert.ok(!sent().includes('bbox'));assert.match(sent(),/不等于 GPU/);m.dispose();
});
test('assist statistics scope selection and separate empty descriptions from short ones',()=>{
 const d=emptyStudioDoc();d.layout.items=[{...item('a'),caption:''},{...item('b'),label:'text',text:''}];assert.deepEqual(studioAssistStats(d,['a'],true),{empty:1,short:0,missingText:0});assert.deepEqual(studioAssistStats(d),{empty:1,short:1,missingText:1});assert.match(studioAssistRequest({onlySelection:true}),/只修改选中/);
});

test('Escape cancels an active snapped drag while Alt is still held',async()=>{
 const {createStudioView}=await import('../client/studio-view.mjs');const d=emptyStudioDoc();d.layout.items=[item('a')];const {m}=await modelFor(d);
 const React={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),useState:v=>[typeof v==='function'?v():v,()=>{}],useRef:v=>({current:v}),useEffect(){}};
 const tree=createStudioView(React)({model:m,sessionId:'s'}),nodes=[];const visit=n=>{if(n&&typeof n==='object'){nodes.push(n);n.children?.forEach(visit);}};visit(tree);
 const svg=nodes.find(n=>n.props['aria-label']==='Layout 编辑画布'),g=nodes.find(n=>n.props['data-item-id']==='a');svg.props.ref.current={getBoundingClientRect:()=>({left:0,top:0,width:1024,height:1024}),focus(){},setPointerCapture(){},releasePointerCapture(){}};
 const e={pointerId:1,button:0,clientX:250,clientY:250,preventDefault(){},stopPropagation(){}};g.props.onPointerDown(e);svg.props.onPointerMove({...e,clientX:280,altKey:true});assert.notDeepEqual(m.getSnapshot().draft.doc.layout.items[0].bbox,d.layout.items[0].bbox);tree.props.onKeyDown({...e,key:'Escape',altKey:true});assert.deepEqual(m.getSnapshot().draft.doc.layout.items,d.layout.items);assert.equal(m.getSnapshot().gestureActive,false);m.dispose();
});
