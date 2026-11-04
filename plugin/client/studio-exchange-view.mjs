import {encodeStudioExchange,readStudioExchange,studioAnnotationMarkdown,studioMossCompatibility,STUDIO_EXCHANGE_MAX_BYTES} from '../src/studio-exchange.mjs';

export function createStudioExchangeView(React){
  const h=React.createElement;
  return function Exchange({model,state}){
    const [importText,setImportText]=React.useState(''),[title,setTitle]=React.useState(''),[dimensions,setDimensions]=React.useState(''),
      [fallback,setFallback]=React.useState(''),[message,notify]=React.useState(''),[candidate,setCandidate]=React.useState(null);
    const doc=state.draft?.doc,id=state.page?.page_id,series=state.seriesId;
    const live=React.useRef(null);live.current={model,id,series};
    const available=!!doc&&!state.busy&&!state.editingBlocked;
    React.useEffect(()=>{setCandidate(null);setImportText('');setFallback('');setTitle('');setDimensions('');notify('');},[id,series,model]);
    const act=fn=>async()=>{try{await fn();}catch(e){notify(String(e?.message??e));}};
    const button=(label,fn,disabled=false)=>h('button',{type:'button',disabled,onClick:act(fn)},label);
    const receipt=()=>({model,id,series});
    const still=s=>s.model===live.current.model&&s.id===live.current.id&&s.series===live.current.series;
    async function fileChange(e){
      const f=e.target.files?.[0],mark=receipt();e.target.value='';if(!f)return;
      setCandidate(null);
      try{if(f.size>STUDIO_EXCHANGE_MAX_BYTES)throw Error('文件超过 2 MiB');
        const text=await f.text();if(still(mark)){setImportText(text);notify('已读取本地文件，请检查导入预览。');}
      }catch(err){if(still(mark))notify(String(err.message??err));}
    }
    const payload=kind=>kind==='full'?encodeStudioExchange(doc,state.draft.title):kind==='markdown'?studioAnnotationMarkdown(doc):studioMossCompatibility(doc);
    function save(kind) {
      const data=payload(kind),link=document.createElement('a'),url=URL.createObjectURL(new Blob([data],{type:'application/json;charset=utf-8'}));
      link.href=url;link.download=(state.draft.title||'layout').replace(/[\\/:*?"<>|]/g,'_')+(kind==='full'?'.moss-studio.json':'.moss.json');
      try{link.click();notify(kind==='full'?'已交给浏览器下载完整工作稿。':'已交给浏览器下载有损兼容副本。请一并记录源画布宽高。');}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
    }
    async function copy(kind){
      const text=payload(kind),mark=receipt();
      try{await globalThis.navigator.clipboard.writeText(text);if(still(mark)){setFallback('');notify('已复制。');}}
      catch{if(still(mark)){setFallback(text);notify('剪贴板不可用，请选择下方文本手工复制。');}}
    }
    function inspect(){
      const m=/^(\d{1,4})\s*[x×]\s*(\d{1,4})$/i.exec(dimensions.trim());
      const parsed=readStudioExchange(importText,{width:m?Number(m[1]):null,height:m?Number(m[2]):null});
      setCandidate({...parsed,mark:receipt()});setTitle(parsed.title||'导入工作稿');
      notify(parsed.kind==='studio'?'完整工作稿可无损导入。':'已按指定源尺寸转换模型框，查看下方损失说明。');
    }
    async function importNew(){
      if(!candidate||!still(candidate.mark)||!title.trim())throw Error('请重新预览待导入工作稿');
      await model.createPage({series_id:series,title:title.trim(),doc:candidate.doc},{keepDraft:true});
    }
    return h('details',{className:'mps-exchange'},h('summary',null,'工作稿交换与注释'),
      h('p',null,'完整工作稿保留画布、角色和姿态。Moeblack .moss.json 仅保存编译后的描述与框，不含画布宽高、笔画和历史。'),
      h('div',null,button('下载完整工作稿',()=>save('full'),!available),button('下载 MOSS 兼容副本',()=>save('moss'),!available||doc?.kind!=='layout'),
        button('复制注释 Markdown',()=>copy('markdown'),!available),button('复制模型 JSON',()=>copy('moss'),!available||doc?.kind!=='layout'),
        button('发送注释图和说明到本会话',async()=>{const mark=receipt(),r=await model.sendAnnotationToSession();if(still(mark))notify(`DSH 已接纳本页 r${r.revision} 的图文消息，PNG ${r.bytes} 字节，SHA-256 ${r.sha256}。`);},!available||state.dirty||state.conflict||state.mergeBlocked||doc?.kind!=='layout')),
      fallback?h('textarea',{readOnly:true,value:fallback,'aria-label':'可手工复制的注释'}):null,
      h('input',{type:'file',accept:'.json,application/json','aria-label':'读取工作稿或 MOSS JSON',onChange:fileChange}),
      h('textarea',{'aria-label':'待导入的 JSON',value:importText,onChange:e=>{setCandidate(null);setImportText(e.target.value);}}),
      h('label',null,'兼容文件原始画布 宽×高',h('input',{value:dimensions,placeholder:'例如 1024x1536',onChange:e=>{setDimensions(e.target.value);setCandidate(null);}})),
      button('检查导入预览',inspect,!importText.trim()||!available),
      candidate?h('div',null,h('p',null,`${candidate.doc.layout.items.length} 个对象 · ${candidate.doc.layout.width} × ${candidate.doc.layout.height}`),
        ...candidate.losses.map(loss=>h('p',{key:loss},loss)),h('input',{'aria-label':'导入的新页名称',value:title,maxLength:200,onChange:e=>setTitle(e.target.value)}),
        button('创建独立新页',importNew,!available||!title.trim())):null,
      message?h('p',{role:'status'},message):null);
  };
}
