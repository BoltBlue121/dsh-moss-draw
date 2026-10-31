import { createBridge, createWorkbenchModel } from './model.mjs';
import { createWorkbenchView } from './view.mjs';
import { createStudioModel } from './studio-model.mjs';
import { createStudioView } from './studio-view.mjs';
import { createSessionModelRegistry } from './session-models.mjs';
import { createWorkspaceView } from './workspace-view.mjs';
import { createStudioNavigator } from './studio-navigation.mjs';
import { WORKBENCH_QUERY_REMOTE } from '../src/workbench-query-contract.mjs';

export const inject = ['sidebarRightTabs','sidebarRight','slots','remote','remote.commands','sessions'];
export const TAB_ID = '@dsh-external/dsh-moss-draw/workbench';
export function apply(ctx, React) {
 let query;
 // Mount a read-only namespace through the official Client Remote contract.
 // Optional only for old hosts/test fixtures: never fall back to logged commands.
 if(typeof ctx.remote.$mount==='function'){
  ctx.remote.$mount(WORKBENCH_QUERY_REMOTE);
  ctx.inject(['remote.mossWorkbench'],c=>{query=(...args)=>c.remote.mossWorkbench.read(...args);c.effect(()=>()=>{query=undefined;},'art-workbench: release query');});
 }
 const bridgeFactory=options=>createBridge({...options,query:(...args)=>{if(!query)throw Error('WORKBENCH_QUERY_UNAVAILABLE');return query(...args);}});
 const registry=createSessionModelRegistry({sessions:ctx.sessions,remote:ctx.remote,createBridge:bridgeFactory,createRegion:createWorkbenchModel,createStudio:bridge=>createStudioModel(bridge,{autoSave:true,localCompile:true})});
 ctx.effect(()=>()=>registry.dispose(),'art-workbench: session models');
 ctx.effect(()=>{if(!ctx.sidebarRight?.mounted)return()=>{};const navigation=createStudioNavigator({sidebar:ctx.sidebarRight,getModel:id=>registry.get(id).studio,readTasks:id=>bridgeFactory({remote:ctx.remote,sessionId:id,session:ctx.sessions.binding(id)?.session}).query('studioTaskState'),storage:globalThis.localStorage});navigation.start();return()=>navigation.dispose();},'art-workbench: task presentation');
 const Regions=createWorkbenchView(React),Studio=createStudioView(React),Body=createWorkspaceView(React,{Studio,Regions});
 const props=(sessionId,surface='main')=>({getModels:()=>registry.get(sessionId),makeModel:()=>registry.get(sessionId).region,surface,openSidebar:()=>ctx.sidebarRight.openTab('art-workbench')});
 ctx.effect(()=>ctx.sidebarRightTabs.register({id:TAB_ID,kind:'art-workbench',title:()=> 'AI画画工作台',keepMounted:true,guide:[{id:'workbench',title:()=> 'AI画画工作台',description:()=> 'Layout/Caption编辑、区域执行与3D',order:30}]}),'art-workbench: tab');
 ctx.effect(()=>ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:TAB_ID,inject:sessionId=>props(sessionId,'sidebar')},Body)),'art-workbench: sidebar body');
 ctx.effect(()=>ctx.slots.inject('conversation.view',()=>ctx.slots.register({name:'conversation.view',id:'moss-workbench',order:35,label:()=> 'MOSS工作台',inject:props},Body)),'art-workbench: main body');
}
