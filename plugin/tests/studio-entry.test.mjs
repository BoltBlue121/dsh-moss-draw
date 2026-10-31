import test from 'node:test';import assert from 'node:assert/strict';
import {apply} from '../client/entry.mjs';
import {createWorkspaceView} from '../client/workspace-view.mjs';

test('workspace changes its React key on Session or binding replacement',()=>{
 const View=createWorkspaceView({createElement:(type,props)=>({type,props})},{Studio:()=>null,Regions:()=>null});
 const first={},second={};const a=View({getModels:()=>first,sessionId:'a'}),b=View({getModels:()=>second,sessionId:'b'}),again=View({getModels:()=>first,sessionId:'a'});
 assert.notEqual(a.props.key,b.props.key);assert.equal(a.props.key,again.props.key);assert.equal(b.props.models,second);
});

test('main conversation and sidebar receive the same session models and never cross sessions',async()=>{
 const seats=new Map(),bindings=new Map([['s1',{}],['s2',{}]]),dispose=[];let gpu=0;
 const ctx={effect(fn){const d=fn();if(d)dispose.push(d);},slots:{inject(_name,fn){return fn();},register(def,Body){seats.set(def.name,{def,Body});return()=>{};}},sidebarRightTabs:{register(){return()=>{};}},sessions:{binding:id=>({session:bindings.get(id)})},remote:{commands:{execute:async()=>{gpu++;return {ok:true,value:{result:{kind:'success',text:'{"series":[],"pages":[]}'}}}}}}};
 apply(ctx,{createElement:()=>null});
 const main=seats.get('conversation.view');assert.ok(main,'native main conversation view is registered');assert.equal(main.def.id,'moss-workbench');
 const side=seats.get('sidebar.right.pane.tab');assert.ok(side);
 const m=main.def.inject('s1').getModels(),s=side.def.inject('s1').getModels(),other=main.def.inject('s2').getModels();
 assert.equal(m.studio,s.studio);assert.equal(m.region,s.region);assert.notEqual(m.studio,other.studio);assert.equal(gpu,0);
 bindings.set('s1',{});assert.notEqual(main.def.inject('s1').getModels().studio,m.studio,'new Session binding never inherits stale model');
 for(const d of dispose.reverse())d();assert.throws(()=>main.def.inject('s1').getModels(),/DISPOSED/);
});
