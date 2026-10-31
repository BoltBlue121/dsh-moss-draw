import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const model = () => import('../client/model.mjs');
const id='8ed3944e-9d08-4df0-8e19-697c88cae6fd';
const doc=()=>({document_id:id,revision:3,title:'Layout',canvas:{width:1000,height:600,reference:'base'},references:['base','person'],regions:[{id:'one',box:[100,100,300,500],reference_index:1,prompt:'Person',style:'none',lora_strength:0,locked:false}],prompt:'Scene',qwen_full_prompt:'',camera:{orbit:0,pitch:0,roll:0,distance:5,fov:50,pan_x:0,pan_y:0,pan_z:0},proposals:[]});
function environment(){const calls=[];let revision=3;return {calls,session:{prompt:async(...args)=>{calls.push({prompt:args});return {ok:true};}},remote:{commands:{execute:async(session,line,attachments,signal)=>{const request=JSON.parse(line.slice('/art-workbench '.length));calls.push({session,request,attachments,signal});let value;if(request.action==='state')value={documents:[{document_id:id,title:'Layout',revision}],runs:[]};else if(request.action==='get')value={...doc(),revision};else if(request.action==='asset')value={data_url:'data:image/png;base64,aGVsbG8=',width:1,height:1};else {if(request.expected_revision!==revision)return {commandId:'c',result:{kind:'error',text:'WORKBENCH_CONFLICT'}};revision++;value={...doc(),revision};}return {commandId:'c',result:{kind:'success',text:JSON.stringify(value)}};}}}};}

test('official command bridge encodes bounded actions and rejects arbitrary fields/unsafe image URLs',async()=>{
 const {createBridge}=await model(),e=environment(),bridge=createBridge({remote:e.remote,sessionId:'session-one',session:e.session});
 const controller=new AbortController();await bridge.request('get',{document_id:id},controller.signal);
 assert.deepEqual(e.calls[0].request,{action:'get',document_id:id});assert.deepEqual(e.calls[0].attachments,[]);assert.equal(e.calls[0].signal,controller.signal);
 await assert.rejects(bridge.request('execute',{command:'pwsh'}),/ACTION/);
 await assert.rejects(bridge.request('asset',{path:'/fixture/credentials.png'}),/FIELD/);
 e.remote.commands.execute=async()=>({result:{kind:'success',text:JSON.stringify({data_url:'file:///secret.png'})}});
 await assert.rejects(bridge.request('asset',{document_id:id,reference_index:0}),/ASSET/);
});

test('live Remote envelope is unwrapped and transport errors preserve the actual diagnostic',async()=>{
 const {createBridge}=await model();let response={ok:true,value:{commandId:'live',result:{kind:'success',text:'{"documents":[],"runs":[]}'}}};
 const bridge=createBridge({remote:{commands:{execute:async()=>response}},sessionId:'session-live',session:{}});
 assert.deepEqual(await bridge.request('state'),{documents:[],runs:[]});
 response={ok:false,error:{code:'session/not-found',message:'The exact session is unavailable'}};
 await assert.rejects(bridge.request('state'),/session\/not-found.*The exact session is unavailable/);
 response={ok:true,value:{commandId:'denied',result:{kind:'error',text:'WORKBENCH_CONFLICT'}}};
 await assert.rejects(bridge.request('state'),/WORKBENCH_CONFLICT/);
});

test('undefined and failed official command results are explicit, never successful empty state',async()=>{
 const {createBridge}=await model(),e=environment();e.remote.commands.execute=async()=>undefined;
 const bridge=createBridge({remote:e.remote,sessionId:'session-one',session:e.session});
 await assert.rejects(bridge.request('state'),/UNAVAILABLE/);
 e.remote.commands.execute=async()=>({commandId:'x',result:{kind:'error',text:'WORKBENCH_CONFLICT'}});
 await assert.rejects(bridge.request('get',{document_id:id}),/WORKBENCH_CONFLICT/);
});

test('mount/refresh performs state reads only and editing retains CAS revision on conflict',async()=>{
 const {createBridge,createWorkbenchModel}=await model(),e=environment();
 const state=createWorkbenchModel(createBridge({remote:e.remote,sessionId:'session-one',session:e.session}));
 await state.refresh();assert.deepEqual(e.calls.map(x=>x.request.action),['state']);
 await state.open(id);state.patch({prompt:'Human editing'});
 assert.equal(state.getSnapshot().draft.prompt,'Human editing');assert.equal(state.getSnapshot().document.revision,3);
 e.remote.commands.execute=async()=>({result:{kind:'error',text:'WORKBENCH_CONFLICT: changed elsewhere'}});
 await assert.rejects(state.save(),/WORKBENCH_CONFLICT/);
 assert.equal(state.getSnapshot().draft.prompt,'Human editing');assert.equal(state.getSnapshot().document.revision,3);
 assert.equal(state.getSnapshot().conflict,true);
});

test('typing during an in-flight save keeps later local edits instead of overwriting them with the response',async()=>{
 const {createWorkbenchModel}=await model();let resolveSave;
 const state=createWorkbenchModel({request:async(action,fields)=>action==='get'?doc():await new Promise(resolve=>{resolveSave=()=>resolve({...doc(),revision:4,...fields.patch});})});
 await state.open(id);state.patch({prompt:'Save this'});const pending=state.save();state.patch({prompt:'Typed after clicking save'});resolveSave();await pending;
 assert.equal(state.getSnapshot().document.prompt,'Save this');assert.equal(state.getSnapshot().draft.prompt,'Typed after clicking save');assert.equal(state.getSnapshot().dirty,true);assert.equal(state.getSnapshot().document.revision,4);
});

for(const action of ['propose','resolve','restore'])test(`${action} response preserves edits typed while the mutation was pending`,async()=>{
 const {createWorkbenchModel}=await model();let settle;
 const state=createWorkbenchModel({request:async(name)=>name==='get'?doc():await new Promise(resolve=>{settle=()=>resolve({...doc(),revision:4,prompt:'Server changed prompt'});})});
 await state.open(id);
 const pending=action==='propose'?state.propose({prompt:'Proposal'},'test'):action==='resolve'?state.resolve('proposal-one',['prompt']):state.restore(1);
 state.patch({prompt:'Typed while pending',regions:[{...doc().regions[0],box:[110,100,310,500]}]});settle();await pending;
 assert.equal(state.getSnapshot().document.revision,4);assert.equal(state.getSnapshot().document.prompt,'Server changed prompt');
 assert.equal(state.getSnapshot().draft.prompt,'Typed while pending');assert.deepEqual(state.getSnapshot().draft.regions[0].box,[110,100,310,500]);
 assert.equal(state.getSnapshot().dirty,true);assert.equal(state.getSnapshot().conflict,true);
});

test('materialized plan authorization is bound to its document/revision and invalidates on edits or switching',async()=>{
 const {createWorkbenchModel}=await model(),otherId='f9ad5c47-6495-4082-a85a-f7dde7a4a62e',prompts=[];
 let revision=3;
 const state=createWorkbenchModel({request:async(action,fields)=>action==='materialize'?{run_id:'plan-a',status:'draft'}:{...doc(),document_id:fields.document_id,revision},prompt:async(...args)=>{prompts.push(args);return {ok:true};}});
 await state.open(id);await state.materialize();
 assert.deepEqual(state.getSnapshot().lastPlan,{document_id:id,revision:3,run:{run_id:'plan-a',status:'draft'}});
 await state.authorizePlan();assert.ok(prompts[0][0].includes(id));assert.ok(prompts[0][0].includes('plan-a'));
 state.patch({prompt:'Changed after materialize'});assert.equal(state.getSnapshot().lastPlan,null);await assert.rejects(state.authorizePlan(),/WORKBENCH_PLAN_STALE/);
 await state.open(id);await state.materialize();await state.open(otherId);assert.equal(state.getSnapshot().lastPlan,null);await assert.rejects(state.authorizePlan(),/WORKBENCH_PLAN_STALE/);
 await state.open(id);await state.materialize();revision=4;await state.open(id);assert.equal(state.getSnapshot().lastPlan,null);await assert.rejects(state.authorizePlan(),/WORKBENCH_PLAN_STALE/);
 assert.equal(prompts.length,1,'invalid plans never send authorization messages');
});

test('switching documents clears prior history and selection even when region ids coincide',async()=>{
 const {createWorkbenchModel}=await model(),otherId='f9ad5c47-6495-4082-a85a-f7dde7a4a62e';
 const state=createWorkbenchModel({request:async(action,fields)=>action==='history'?{revisions:[{revision:1,operation:'create'}]}:{...doc(),document_id:fields.document_id}});
 await state.open(id);state.select('one');await state.history();assert.equal(state.getSnapshot().history.length,1);
 await state.open(otherId);assert.deepEqual(state.getSnapshot().history,[]);assert.deepEqual(state.getSnapshot().selected,[]);
});

test('typing during materialize prevents delayed draft response from arming execution',async()=>{
 const {createWorkbenchModel}=await model();let settle;
 const state=createWorkbenchModel({request:async(action)=>action==='get'?doc():await new Promise(resolve=>{settle=()=>resolve({run_id:'old-plan',status:'draft'});}),prompt:async()=>{throw Error('must not authorize');}});
 await state.open(id);const pending=state.materialize();state.patch({title:'Changed while freezing'});settle();await pending;
 assert.equal(state.getSnapshot().lastPlan,null);assert.equal(state.getSnapshot().dirty,true);await assert.rejects(state.authorizePlan(),/WORKBENCH_PLAN_STALE/);
});

test('canvas coordinate mapping, pointer resize and keyboard move preserve bounds and locks',async()=>{
 const {canvasPoint,moveRegion,resizeRegion,nudgeRegions}=await model();
 assert.deepEqual(canvasPoint({clientX:350,clientY:220},{left:100,top:100,width:500,height:300},{width:1000,height:600}),[500,240]);
 const d=doc(),r=d.regions[0];assert.deepEqual(moveRegion(r,20,-10,d.canvas).box,[120,90,320,490]);
 assert.deepEqual(resizeRegion(r,40,20,d.canvas).box,[100,100,340,520]);
 assert.deepEqual(nudgeRegions(d.regions,['one'],'ArrowRight',true,d.canvas)[0].box,[110,100,310,500]);
 assert.deepEqual(moveRegion({...r,locked:true},100,0,d.canvas).box,r.box);
 assert.throws(()=>moveRegion(r,-200,0,d.canvas),/BOUNDS/);assert.deepEqual(r.box,[100,100,300,500]);
});

test('clipped/outside projection never becomes accepted 2D layout; valid projection is a proposal only',async()=>{
 const {projectionPatch}=await model(),d=doc();
 assert.throws(()=>projectionPatch(d,{valid:false,regions:[{id:'one',visible:true,clipped:true,box:null}]},d.camera),/PROJECTION/);
 assert.throws(()=>projectionPatch(d,{valid:true,regions:[{id:'one',visible:true,clipped:false,box:[-1,0,30,40]}]},d.camera),/BOUNDS/);
 const patch=projectionPatch(d,{valid:true,regions:[{id:'one',visible:true,clipped:false,box:[110.2,105.2,320.2,490.2]}]},d.camera);
 assert.deepEqual(patch.regions[0].box,[110,105,320,490]);assert.deepEqual(d.regions[0].box,[100,100,300,500]);
});

test('preview bodies omit absent optional body and remain projectable from native 2D rectangles',async()=>{
 const {previewRegions}=await model(),{projectLayout,DEFAULT_CAMERA}=await import('../src/workbench-camera.mjs');
 const d=doc(),regions=previewRegions(d.regions,{});assert.equal(Object.hasOwn(regions[0],'body'),false);assert.equal(projectLayout(regions,DEFAULT_CAMERA,d.canvas).valid,true);
});

test('accepted camera projection persists original world bodies and does not project its own 2D boxes twice',async()=>{
 const {previewRegions,projectionPatch}=await model(),{projectLayout}=await import('../src/workbench-camera.mjs');
 const d=doc(),camera={...d.camera,pan_x:.25},regions=previewRegions(d.regions,{});
 const first=projectionPatch(d,projectLayout(regions,camera,d.canvas),camera);
 assert.ok(first.regions[0].body,'first proposal must freeze the original world geometry');
 const accepted={...d,...first,revision:4};
 const second=projectionPatch(accepted,projectLayout(previewRegions(accepted.regions,{}),camera,accepted.canvas),camera);
 assert.deepEqual(second.regions[0].box,first.regions[0].box);
 assert.deepEqual(second.regions[0].body,first.regions[0].body);
 assert.deepEqual(d.regions[0].box,[100,100,300,500]);assert.equal(Object.hasOwn(d.regions[0],'body'),false);
});

test('camera default full-frame numerical noise rounds into a valid explicit proposal without moving locked regions',async()=>{
 const {projectionPatch}=await model(),{projectLayout,DEFAULT_CAMERA}=await import('../src/workbench-camera.mjs');
 const d=doc();d.regions=[{...d.regions[0],box:[0,0,1000,600]}];
 const projected=projectLayout(d.regions,DEFAULT_CAMERA,d.canvas),patch=projectionPatch(d,projected,DEFAULT_CAMERA);
 assert.deepEqual(patch.regions[0].box,[0,0,1000,600]);
 d.regions[0].locked=true;
 const shifted={valid:true,regions:[{id:'one',visible:true,clipped:false,box:[100,100,300,500]}]};
 assert.deepEqual(projectionPatch(d,shifted,DEFAULT_CAMERA).regions[0].box,[0,0,1000,600]);
});

test('native sidebar injection uses the bound current Session and snapshots stale edit revision',async()=>{
 const {apply}=await import('../client/entry.mjs');let seat;const e=environment();
 const ctx={effect:fn=>fn(),sidebarRightTabs:{register:()=>()=>{}},slots:{inject:(_name,fn)=>fn(),register:def=>{seat=def;return()=>{};}},sessions:{binding:id=>{assert.equal(id,'session-one');return {session:e.session};}},remote:e.remote};
 apply(ctx,{createElement:()=>null});const state=seat.inject('session-one').makeModel();await state.open(id);await state.sendToAgent('调整镜头');
 assert.equal(e.calls.find(x=>x.prompt).prompt[1],'queue');
});

test('partial proposal diff reports exact changed groups and Agent handoff uses current native session only',async()=>{
 const {proposalChanges,createBridge,createWorkbenchModel}=await model(),d=doc(),proposed={...d,prompt:'Better scene',regions:[{...d.regions[0],box:[110,100,310,500]}]};
 const changes=proposalChanges({base:d,proposed,patch:{prompt:proposed.prompt,regions:proposed.regions}});
 assert.deepEqual(changes.map(x=>x.key),['prompt','region:one']);
 const e=environment(),state=createWorkbenchModel(createBridge({remote:e.remote,sessionId:'session-one',session:e.session}));await state.open(id);state.select('one');
 await state.sendToAgent('请调整相机，先提出修改','queue');
 const args=e.calls.find(x=>x.prompt).prompt;assert.equal(args[1],'queue');assert.ok(args[0][0].text.includes(id));assert.ok(args[0][0].text.includes('revision=3'));assert.ok(args[0][0].text.includes('one'));assert.ok(args[0][0].text.length<2000);
 assert.ok(!e.calls.some(x=>x.request?.action==='materialize'));
});

test('client public registration is keyed, effect-owned, and never triggers generation on apply',async()=>{
 const {apply,inject}=await import('../client/entry.mjs');const log=[],disposers=[];
 const ctx={effect(fn){const d=fn();if(d)disposers.push(d);return d;},sidebarRightTabs:{register(def){log.push({type:'tab',def});return()=>log.push({type:'dispose-tab'});}},slots:{inject(name,fn){log.push({type:'inject',name});return fn();},register(def,Body){log.push({type:'seat',def,Body});return()=>log.push({type:'dispose-seat'});}},sessions:{get:()=>({prompt:async()=>({ok:true})})},remote:{commands:{execute:async()=>{throw Error('must not call at registration')}}}};
 const React={createElement:()=>null};apply(ctx,React);assert.deepEqual(inject,['sidebarRightTabs','sidebarRight','slots','remote','remote.commands','sessions']);
 const tab=log.find(x=>x.type==='tab').def,seat=log.find(x=>x.type==='seat').def;
 assert.equal(tab.kind,'art-workbench');assert.equal(tab.guide[0].title(),'AI画画工作台');assert.ok(tab.guide[0].description().includes('3D'));assert.equal(seat.name,'sidebar.right.pane.tab');assert.equal(seat.key,tab.id);assert.equal(tab.keepMounted,true);
 for(const d of disposers.reverse())d();assert.ok(log.some(x=>x.type==='dispose-tab'));assert.ok(log.some(x=>x.type==='dispose-seat'));
});

test('stop waiting delegates to native current Session cancel and no worker endpoint',async()=>{
 const {createBridge}=await model(),e=environment();let cancelled=0;e.session.cancel=async()=>{cancelled++;return {ok:true};};
 await createBridge({remote:e.remote,sessionId:'session-one',session:e.session}).cancel();
 assert.equal(cancelled,1);assert.equal(e.calls.length,0);
});

test('bridge model consumes actual CAS store proposals and partial acceptance responses',async t=>{
 const {createBridge,createWorkbenchModel}=await model(),{createWorkbenchStore}=await import('../src/workbench-store.mjs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'awb-client-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const store=createWorkbenchStore({dataRoot:root});
 const remote={commands:{execute:async(_id,line)=>{const {action,...args}=JSON.parse(line.slice('/art-workbench '.length));try{const value=action==='state'?{...await store.list({}),runs:[]}:await store[action](args);return {commandId:'fixture',result:{kind:'success',text:JSON.stringify(value)}};}catch(e){return {commandId:'fixture',result:{kind:'error',text:e.code+': '+e.message}};}}}};
 const client=createWorkbenchModel(createBridge({remote,sessionId:'session-fixture',session:{}})),d=doc();
 await client.create({title:d.title,canvas:d.canvas,references:d.references,regions:d.regions,prompt:d.prompt,camera:d.camera});
 client.patch({title:'Human title'});await client.save();assert.equal(client.getSnapshot().document.revision,2);
 await client.propose({prompt:'Agent prompt',regions:[{...client.getSnapshot().document.regions[0],box:[120,100,320,500]}]},'Move and prompt');
 const proposed=client.getSnapshot().document,proposal=proposed.proposals.at(-1);assert.equal(proposal.status,'pending');
 await client.resolve(proposal.proposal_id,['prompt']);const accepted=client.getSnapshot().document;
 assert.equal(accepted.prompt,'Agent prompt');assert.deepEqual(accepted.regions[0].box,[100,100,300,500]);assert.equal(accepted.title,'Human title');
 await client.propose({prompt:'Reject this prompt'},'Must remain unchanged');
 const rejectedId=client.getSnapshot().document.proposals.at(-1).proposal_id;
 await client.resolve(rejectedId,[],true);
 assert.equal(client.getSnapshot().document.proposals.at(-1).status,'rejected');assert.equal(client.getSnapshot().document.prompt,'Agent prompt');
 await client.history();assert.ok(client.getSnapshot().history.length>=4);
 await client.restore(1);assert.ok(client.getSnapshot().document.revision>accepted.revision);assert.equal(client.getSnapshot().document.prompt,'Scene');
});

for(const phase of ['initial','loading','empty','error','no-document-with-results'])test(`workbench ${phase} first-screen state renders without a document or asset bucket`,async()=>{
 const {createWorkbenchView}=await import('../client/view.mjs'),{createWorkbenchModel}=await model();let settle,calls=0;
 const state=createWorkbenchModel({request:async()=>{calls++;if(phase==='loading')return new Promise(resolve=>{settle=resolve;});if(phase==='error')throw Error('WORKBENCH_CONFLICT: unavailable');return {documents:[],runs:phase==='no-document-with-results'?[{run_id:id,status:'succeeded',artifact:{path:'must-not-render-arbitrary-path'}}]:[]};}});
 let pending;if(phase==='loading')pending=state.refresh();else if(phase!=='initial')await state.refresh().catch(()=>{});
 const before=calls,React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props??{},children}),useState:init=>[typeof init==='function'?init():init,()=>{}],useEffect:()=>{},useRef:initial=>({current:initial})};
 const tree=createWorkbenchView(React)({makeModel:()=>state,useTabInfo:()=>({tab:{signal:new AbortController().signal}}),sessionId:'session-one'});
 const serialized=JSON.stringify(tree);assert.ok(serialized.includes('data-art-workbench'));assert.ok(serialized.includes('从当前对话的需求开始'));assert.ok(serialized.includes('发送要求'));assert.ok(!serialized.includes('must-not-render-arbitrary-path'));assert.equal(calls,before);
 const visit=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(visit)];
 assert.ok(!visit(tree).some(node=>node.type==='button'&&node.children.includes('放弃本地并重新载入')),'no document means no document reload action');
 if(pending){settle({documents:[],runs:[]});await pending;}
});

test('region properties replace the style selector with a none-only explanation',async()=>{
 const {createWorkbenchView}=await import('../client/view.mjs'),{createWorkbenchModel,createBridge}=await model(),e=environment();
 const state=createWorkbenchModel(createBridge({remote:e.remote,sessionId:'session-one',session:e.session}));await state.open(id);state.select('one');const callsBefore=e.calls.length;
 const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props??{},children}),useState:init=>[typeof init==='function'?init():init,()=>{}],useEffect:()=>{},useRef:initial=>({current:initial})};
 const tree=createWorkbenchView(React)({makeModel:()=>state,useTabInfo:()=>({tab:{signal:new AbortController().signal}}),sessionId:'session-one'});
 const visit=node=>!node||typeof node!=='object'?[]:[node,...(node.children??[]).flat(Infinity).flatMap(visit)];
 const nodes=visit(tree);
 const hasText=text=>nodes.some(node=>(node.children??[]).some(child=>typeof child==='string'&&child.includes(text)));
 assert.ok(hasText('区域属性'));
 assert.ok(hasText('本包不含画风 LoRA'),'the region pane explains the portable contract');
 assert.ok(hasText('style=none'),'the note names the only legal style');
 assert.ok(!nodes.some(node=>node.type==='label'&&(node.children??[]).some(child=>child==='画风')),'no style dropdown label remains');
 assert.doesNotMatch(JSON.stringify(tree),/safetensors|Civitai/i,'no model asset is named in the UI');
 assert.equal(e.calls.length,callsBefore,'rendering a region never generates');
});

test('workbench renders native canvas and safe asset placeholders without executing network or generation',async()=>{
 const {createWorkbenchView}=await import('../client/view.mjs'),{createWorkbenchModel,createBridge}=await model(),e=environment(),state=createWorkbenchModel(createBridge({remote:e.remote,sessionId:'session-one',session:e.session}));await state.open(id);const calls=e.calls.length;
 const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props??{},children}),useState:init=>[typeof init==='function'?init():init,()=>{}],useEffect:()=>{},useRef:initial=>({current:initial})};
 const tree=createWorkbenchView(React)({makeModel:()=>state,useTabInfo:()=>({tab:{signal:new AbortController().signal}}),sessionId:'session-one'});
 const serialized=JSON.stringify(tree);assert.ok(serialized.includes('data-art-workbench'));assert.ok(serialized.includes('画布'));assert.ok(serialized.includes('授权Agent执行当前计划'));assert.equal(e.calls.length,calls);
});

test('studio state on an older loaded Host gives an actionable version mismatch, not an empty success',async()=>{
 const {createBridge}=await model();const bridge=createBridge({sessionId:'s',remote:{commands:{execute:async()=>({ok:true,value:{result:{kind:'error',text:'INVALID_INPUT'}}})}}});
 await assert.rejects(bridge.request('studioState'),/WORKBENCH_HOST_RELOAD_REQUIRED.*重启/);
 await assert.rejects(bridge.request('studioCompile',{doc:{}}),/^Error: INVALID_INPUT$/);
});

test('built client loads official ModuleLoader wrapper with only shared React external',async()=>{
 const code=await fs.readFile(new URL('../client/lib/client.js',import.meta.url),'utf8');let registration;
 vm.runInNewContext(code,{crypto:globalThis.crypto,AbortController,structuredClone,window:{__ModuleLoader__:{load:value=>{registration=value;}}}});
 assert.equal(registration.id,'@dsh-external/dsh-moss-draw');const requires=[];const api=registration.factory(name=>{requires.push(name);assert.equal(name,'react');return {createElement:()=>null};});
 assert.equal(typeof api.apply,'function');assert.deepEqual(requires,['react']);
 let seat;const React={Fragment:'fragment',createElement:(type,props,...children)=>({type,props:props??{},children}),useState:init=>[typeof init==='function'?init():init,()=>{}],useEffect:()=>{},useRef:initial=>({current:initial})};
 const client=registration.factory(()=>React);
 client.apply({effect:fn=>fn(),sidebarRightTabs:{register:()=>()=>{}},slots:{inject:(_name,fn)=>fn(),register:(def,Body)=>{seat={def,Body};return()=>{};}},sessions:{binding:()=>({session:{}})},remote:{commands:{execute:async()=>{throw Error('no requests while rendering');}}}});
 const props=seat.def.inject('session-one');const shell=seat.Body({...props,useTabInfo:()=>({tab:{signal:new AbortController().signal}}),sessionId:'session-one'});const tree=shell.type(shell.props);
 assert.ok(JSON.stringify(tree).includes('提示词编辑'));assert.ok(JSON.stringify(tree).includes('区域执行 / 3D'));
});
