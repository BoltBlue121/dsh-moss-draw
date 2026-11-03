export function createWorkspaceView(React,{Studio,Regions}){
 const h=React.createElement,keys=new WeakMap();let nextKey=0;
 function Surface({models,sessionId,surface,visible,presentation,openSidebar}){
  const [mode,setMode]=React.useState('studio'),lifetime=React.useRef(null);
  if(!lifetime.current)lifetime.current=new AbortController();
  React.useEffect(()=>()=>lifetime.current.abort(),[]);
   React.useEffect(()=>{if(presentation?.request_id&&visible)setMode('studio');},[presentation?.request_id,visible]);
  return h('section',{className:`moss-workspace moss-workspace-${surface}`,'data-moss-workspace':sessionId},
   h('nav',{className:'moss-workspace-nav','aria-label':'工作台模式'},
    h('button',{type:'button',onClick:()=>setMode('studio'),'aria-pressed':mode==='studio'},'提示词编辑'),
    h('button',{type:'button',onClick:()=>setMode('regions'),'aria-pressed':mode==='regions'},'区域执行 / 3D'),
    surface==='main'&&openSidebar?h('button',{type:'button',onClick:openSidebar},'在侧边栏打开'):null,
    h('span',null,'当前会话 · 原MOSS工作台功能移植')),
   mode==='studio'?h(Studio,{model:models.studio,sessionId,surface,visible,presentation}):h(Regions,{makeModel:()=>models.region,sessionId,retainModel:true,useTabInfo:()=>({tab:{signal:lifetime.current.signal}})}));
 }
 function SidebarWorkspace({getModels,sessionId,useTabInfo}){const info=useTabInfo(),models=getModels();if(!keys.has(models))keys.set(models,++nextKey);return h(Surface,{key:keys.get(models),models,sessionId,surface:'sidebar',visible:!!info.tab.visible,presentation:info.tab.navigation?.params});}
 return function Workspace({getModels,sessionId,surface='main',useTabInfo,openSidebar}){
  if(surface==='sidebar'&&useTabInfo)return h(SidebarWorkspace,{getModels,sessionId,useTabInfo});
  const models=getModels();if(!keys.has(models))keys.set(models,++nextKey);
  return h(Surface,{key:keys.get(models),models,sessionId,surface,visible:true,openSidebar});
 };
}
