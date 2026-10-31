import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import * as entry from '../client/entry.mjs';

// Regression: declaring only remote does not grant Cordis remote.commands.
// The old plain-object fixtures bypassed this exact SDK namespace boundary.
test('native sidebar refresh can use scoped remote.commands under real Cordis injection', {skip:!process.env.MOSS_SDK_PACKAGE}, async()=>{
 const {Context,Service}=createRequire(process.env.MOSS_SDK_PACKAGE)('@deepseek-ai/cordis');
 const ctx=new Context();let seat;const calls=[];
 class Remote extends Service{constructor(c){super(c,'remote');}}
 class Commands extends Service{constructor(c){super(c,'remote.commands');}async execute(...args){calls.push(args);return {result:{kind:'success',text:'{"documents":[],"runs":[]}'}};}}
 await ctx.plugin({name:'remote-fixture-carrier',apply(c){new Remote(c);new Commands(c);}}).await();
 ctx.reflect.provide('sidebarRightTabs',{register(){return()=>{};}});
 ctx.reflect.provide('sidebarRight',{mounted:{getSnapshot:()=>undefined},openTab(){throw Error('no pending presentation');}});
 ctx.reflect.provide('slots',{inject(_name,fn){return fn();},register(def){seat=def;return()=>{};}});
 ctx.reflect.provide('sessions',{binding(){return {session:{}};}});
 try{await ctx.plugin({inject:entry.inject,apply(c){entry.apply(c,{createElement:()=>null});}}).await();
 const model=seat.inject('session-live-fixture').makeModel();await model.refresh();
 assert.equal(calls.length,1);assert.equal(calls[0][0],'session-live-fixture');assert.equal(calls[0][1],'/art-workbench {"action":"state"}');assert.deepEqual(calls[0][2],[]);assert.deepEqual(model.getSnapshot().documents,[]);
 }finally{await ctx.fiber.dispose();}
});
