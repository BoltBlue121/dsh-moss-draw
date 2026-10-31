import test from 'node:test';import assert from 'node:assert/strict';
const subject=()=>import('../client/studio-camera-view.mjs').catch(()=>({}));
const fakeReact={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),useState:init=>[typeof init==='function'?init():init,()=>{}],useRef:init=>({current:init}),useEffect:()=>{}};
function nodes(tree){const result=[];const walk=n=>{if(n&&typeof n==='object'){result.push(n);n.children?.forEach(walk);}};walk(tree);return result;}
const layout=()=>({width:1024,height:1024,bbox_coord_space:'abs',bbox_format:'xyxy',summary:{caption:'Scene'},items:[{id:'a',label:'object',caption:'Cube',bbox:[256,256,512,512],body:{z:1,thickness:.4,yaw:0,anchor:'world'}}],camera:{enabled:true}});
test('director offers real camera/body controls and pure document changes without generation',async()=>{
 const {createStudioCameraView}=await subject();assert.equal(typeof createStudioCameraView,'function');let changed,patch;const state={draft:{doc:{layout:layout()}},selected:['a']};
 const model={patchCamera:p=>patch=p,patchItem:(id,p)=>changed={id,p},updateLayout:fn=>{changed=typeof fn==='function'?fn(state.draft.doc.layout):fn;},select:()=>{},beginGesture:()=>{},endGesture:()=>{}};
 const tree=createStudioCameraView(fakeReact)({model,state}),all=nodes(tree);assert.ok(all.find(n=>n.type==='svg'&&n.props['aria-label']==='3D镜头调度画布'));assert.equal(all.filter(n=>n.type==='line'&&n.props['data-cube-edge']).length,12);
 const orbit=all.find(n=>n.props['aria-label']==='相机 环绕');orbit.props.onChange({target:{value:'25'}});assert.equal(patch.orbit,25);
 const depth=all.find(n=>n.props['aria-label']==='体块 远近');depth.props.onChange({target:{value:'2'}});assert.equal(changed.p.body.z,2);
 assert.ok(all.some(n=>n.type==='button'&&n.children.includes('定为基准')));assert.ok(all.some(n=>n.type==='button'&&n.children.includes('自动取景')));
 assert.ok(!all.some(n=>n.type==='button'&&n.children.includes('生成')));
});
test('main canvas draws projected bounds and disables rectangle resizing at a moved camera',async()=>{
 const {createStudioView}=await import('../client/studio-view.mjs');const l=layout();l.camera={enabled:true,distance:2};l.items[0].body.thickness=0;
 const state={draft:{title:'Page',doc:{kind:'layout',layout:l,caption:{caption:''}}},page:{revision:1,proposals:[]},selected:['a'],series:[],pages:[],seriesId:'',undo:[],redo:[],history:[],zoom:1,tool:'select',drawLabel:'object',pageManagement:false};
 const React={...fakeReact,useEffect:()=>{}};const tree=createStudioView(React)({model:{getSnapshot:()=>state,hasDraft:()=>false},sessionId:'s'}),all=nodes(tree);
 const item=all.find(n=>n.props['data-item-id']==='a'),rect=item.children.find(n=>n.type==='rect');assert.equal(rect.props.x,384);assert.equal(rect.props.width,128);assert.equal(all.filter(n=>n.props['data-handle']).length,0);
 const deletion=all.find(n=>n.type==='button'&&n.children.includes('删除当前页'));assert.equal(deletion.props.disabled,true);
});
test('singular camera rendering keeps recovery controls instead of throwing away the editor',async()=>{
 const {createStudioView}=await import('../client/studio-view.mjs'),{createStudioCameraView}=await subject();const l=layout();l.camera={enabled:true,orbit:10};l.items[0].bbox=[400,400,624,624];l.items[0].body={z:1,thickness:0,yaw:90,anchor:'world'};
 const state={draft:{title:'P',doc:{kind:'layout',layout:l,caption:{caption:''}}},page:{revision:1,proposals:[]},selected:['a'],series:[],pages:[],undo:[],redo:[],history:[],zoom:1,tool:'select'};const model={getSnapshot:()=>state,hasDraft:()=>false};
 const tree=createStudioView({...fakeReact,useEffect:()=>{}})({model,sessionId:'s'});assert.ok(nodes(tree).some(n=>n.type==='button'&&n.children.includes('停用相机，编辑原框')));
 const director=createStudioCameraView(fakeReact)({model,state});assert.ok(nodes(director).some(n=>n.type==='button'&&n.children.includes('重置机位')));
});
test('director contains body-inference errors in the top view and keeps camera reset reachable',async()=>{
 const {createStudioCameraView}=await subject();const l=layout();l.camera={enabled:true,orbit:10};delete l.items[0].body;l.items[0].bbox=[0,0,1,Number.MIN_VALUE];
 const tree=createStudioCameraView(fakeReact)({model:{},state:{draft:{doc:{layout:l}},selected:['a']}});assert.ok(nodes(tree).some(n=>n.type==='button'&&n.children.includes('重置机位')));
});
test('director uses uniform SVG meet scaling for pointer motion inside letterboxed viewports',async()=>{
 const {createStudioCameraView}=await subject();const l=layout(),state={draft:{doc:{layout:l}},selected:['a']};let moved;
 const React={...fakeReact,useState:init=>init==='camera'?['bodies',()=>{}]:fakeReact.useState(init)};
 const model={getSnapshot:()=>state,select:()=>{},beginGesture:()=>{},endGesture:()=>{},updateLayout:fn=>{moved=fn(l);}};
 const tree=createStudioCameraView(React)({model,state}),all=nodes(tree),svg=all.find(n=>n.props['aria-label']==='3D镜头调度画布'),g=all.find(n=>n.props['data-camera-item']==='a');
 const dom={getBoundingClientRect:()=>({width:600,height:330}),setPointerCapture:()=>{}};
 g.props.onPointerDown({button:0,clientX:100,clientY:100,currentTarget:{ownerSVGElement:dom},preventDefault(){},stopPropagation(){}});
 svg.props.onPointerMove({clientX:130,clientY:130});const box=moved.items[0].bbox;assert.ok(Math.abs((box[0]-l.items[0].bbox[0])-(box[1]-l.items[0].bbox[1]))<.01);
});
test('main projected canvas Alt drag moves only the selected group member',async()=>{
 const {moveStudioVisual}=await import('../client/studio-layout.mjs');const {createStudioView}=await import('../client/studio-view.mjs');const l=layout();l.camera={enabled:true,distance:2};l.items=[{...l.items[0],id:'a',group:'g',bbox:[200,200,400,400],body:{z:1,thickness:0,yaw:0,anchor:'world'}},{...l.items[0],id:'b',group:'g',bbox:[600,200,800,400],body:{z:1,thickness:0,yaw:0,anchor:'world'}}];
 const state={draft:{title:'P',doc:{kind:'layout',layout:l,caption:{caption:''}}},page:{revision:1,proposals:[]},selected:[],series:[],pages:[],undo:[],redo:[],history:[],zoom:1,tool:'select'};
 const model={getSnapshot:()=>state,hasDraft:()=>false,select:id=>{state.selected=[id];},beginGesture(){},endGesture(){},updateLayout:fn=>{state.draft.doc.layout=fn(state.draft.doc.layout);},moveVisualSelection:(dx,dy,options)=>{state.draft.doc.layout=moveStudioVisual(state.draft.doc.layout,state.selected,dx,dy,options);}};
 const tree=createStudioView(fakeReact)({model,sessionId:'s'}),all=nodes(tree),svg=all.find(n=>n.props['aria-label']==='Layout 编辑画布'),g=all.find(n=>n.props['data-item-id']==='a');
 svg.props.ref.current={getBoundingClientRect:()=>({left:0,top:0,width:1024,height:1024}),focus(){},setPointerCapture(){},releasePointerCapture(){}};
 g.props.onPointerDown({button:0,altKey:true,clientX:200,clientY:200,preventDefault(){},stopPropagation(){}});svg.props.onPointerMove({clientX:210,clientY:200});
 assert.deepEqual(state.draft.doc.layout.items[1].bbox,[600,200,800,400]);assert.ok(Math.abs(state.draft.doc.layout.items[0].bbox[0]-220)<.01);
});
test('director releases only its own gesture on lost capture or unmount',async()=>{
 const {createStudioCameraView}=await subject();let cleanup,begins=0,ends=0;const React={...fakeReact,useEffect:fn=>cleanup=fn()};const state={draft:{doc:{layout:layout()}},selected:[]};const model={beginGesture:()=>begins++,endGesture:()=>ends++};
 const tree=createStudioCameraView(React)({model,state}),svg=nodes(tree).find(n=>n.props['aria-label']==='3D镜头调度画布');assert.equal(typeof svg.props.onLostPointerCapture,'function');
 const dom={getBoundingClientRect:()=>({width:600,height:330}),setPointerCapture:()=>{},releasePointerCapture:()=>{}};const event={button:0,clientX:0,clientY:0,currentTarget:dom,preventDefault(){},stopPropagation(){}};
 svg.props.onPointerDown(event);svg.props.onLostPointerCapture(event);cleanup();assert.equal(begins,1);assert.equal(ends,1);
 svg.props.onPointerDown(event);cleanup();assert.equal(ends,2);
});
test('camera component states unsupported follow honestly instead of exposing a fake working control',async()=>{
 const {createStudioCameraView}=await subject();assert.equal(typeof createStudioCameraView,'function');const tree=createStudioCameraView(fakeReact)({model:{},state:{draft:{doc:{layout:layout()}},selected:[]}});
 assert.match(JSON.stringify(tree),/随主体.*未|未.*随主体/);assert.ok(nodes(tree).some(n=>n.type==='svg'&&n.props['aria-label']==='体块俯视图'));
});
