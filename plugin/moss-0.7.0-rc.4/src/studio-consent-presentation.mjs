// A readable projection of frozen operations, not a second authorization payload.
export const CONSENT_PRESENTATION_VERSION=2;
export const CONSENT_QUESTION_LIMIT=300;
const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
const fail=message=>{throw Object.assign(new Error(message),{code:'STUDIO_CONSENT_PRESENTATION'});};
const safe=(value,max)=>{const s=String(value??'').replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').replace(/[<>\[\]`*_~&{}\\|【】]/g,'').replace(/\s+/g,' ').trim(),chars=[...s];return chars.length>max?chars.slice(0,max-1).join('')+'…':s;};
export function isBriefStudioConsentGoal(value){return typeof value==='string'&&!!value.trim()&&[...value].length<=80&&!/[。！？!?;；\r\n]|\.(?:\s|$)/u.test(value.trim().replace(/[。.!?！？]+$/u,''));}
const role=item=>item?.label==='character'?'人物':item?.label==='text'?'文字':'物件';
function describeChange(before,after){
 if(!before?.layout||!after?.layout)fail('Readable confirmation requires the actual before and selected after document.');
 const parts=[],a=before.layout,b=after.layout;
 if(before.kind!==after.kind)parts.push(`切为${after.kind==='layout'?'布局':'整图'}稿`);
 if(!same(a.summary,b.summary))parts.push('更新画面总述');
 if(!same(before.caption,after.caption))parts.push('修改整图描述');
 if(a.width!==b.width||a.height!==b.height)parts.push('调整画布尺寸');
 const cameraChanged=!same(a.camera,b.camera),perspectiveChanged=!same(a.perspective,b.perspective),optionsChanged=!same(a.prompt_options,b.prompt_options);
 if(cameraChanged)parts.push('修改输出机位');if(perspectiveChanged)parts.push('调整透视辅助');if(optionsChanged)parts.push('修改提示词输出选项');
 const left=new Map(a.items.map(i=>[i.id,i])),right=new Map(b.items.map(i=>[i.id,i]));
 const groups=new Map(['人物','物件','文字'].map(label=>[label,{add:[],remove:0,position:0,description:0,body:0,depth:0,hide:0,show:0,name:0,palette:0,group:0,type:0,lock:0,unlock:0}]));let characterChanged=false;
 for(const id of new Set([...left.keys(),...right.keys()])){
  const old=left.get(id),next=right.get(id);if(same(old,next))continue;
  const label=old?.label==='character'||next?.label==='character'?'人物':role(next??old),g=groups.get(label);if(label==='人物')characterChanged=true;
  if(!old){g.add.push(next);continue;}if(!next){g.remove++;continue;}
  const keys=new Set([...Object.keys(old),...Object.keys(next)]),categories=new Set();
  for(const key of keys){if(same(old[key],next[key]))continue;
   const category=key==='hidden'?(next.hidden?'hide':'show'):key==='locked'?(next.locked?'lock':'unlock'):({bbox:'position',body:'body',depth:'depth',caption:'description',tags:'description',text:'description',name:'name',palette:'palette',color:'palette',group:'group',label:'type'})[key];
   if(!category)fail('发现未支持的图层改动，不能隐去后请求批准。');categories.add(category);
  }
  for(const category of categories)g[category]++;
 }
 for(const[label,g]of groups){
  if(g.add.length===1&&label==='物件'&&g.add[0].name)parts.push(`新增物件「${safe(g.add[0].name,12)}」`);else if(g.add.length)parts.push(`新增${g.add.length}个${label}图层`);
  if(g.remove)parts.push(`删除${g.remove}个${label}图层`);
  if(g.position)parts.push(`调整${g.position}个${label}位置`);
  if(g.description)parts.push(`修改${g.description}个${label}描述`);
  if(g.body)parts.push(`调整${g.body}个${label}体块`);if(g.depth)parts.push(`调整${g.depth}个${label}前后层次`);
  if(g.hide)parts.push(`隐藏${g.hide}个${label}图层`);if(g.show)parts.push(`显示${g.show}个${label}图层`);
  if(g.name)parts.push(`更名${g.name}个${label}图层`);if(g.palette)parts.push(`修改${g.palette}个${label}图层配色`);
  if(g.group)parts.push(`修改${g.group}个${label}分组`);if(g.type)parts.push(`修改${g.type}个${label}图层类型`);
  if(g.lock)parts.push(`锁定${g.lock}个${label}图层`);if(g.unlock)parts.push(`解除${g.unlock}个${label}图层锁定`);
 }
 const commonA=[...left.keys()].filter(id=>right.has(id)),commonB=[...right.keys()].filter(id=>left.has(id));
 if(!same(commonA,commonB))parts.push('调整图层顺序');
 const protectedParts=[];
 if([...left.values()].some(i=>i.label==='character')&&!characterChanged)protectedParts.push('人物图层');
 if(!cameraChanged&&!perspectiveChanged&&!optionsChanged)protectedParts.push('输出机位');
 return {parts,preserved:protectedParts.length?protectedParts.join('与')+'不变。':''};
}
function generationLine(operations,task,afterMax){
 const g=operations.generation,backend={moss:'Moss',k2:'K2',qwen:'Qwen'}[g.backend],used=task?.claimed_runs??0,total=task?.max_runs??0,left=afterMax-(g.mode==='new_task'?0:used);
 if(g.mode==='none')return '本次不生成，额度不变。';
 if(g.mode==='new_task')return `${operations.continue_generation?`用${backend}新生成${g.runs}次，不追加。`:`新开${g.runs}次${backend}额度；本次不生成。`}旧任务${used}/${total}留档，不重试。`;
 if(g.mode==='add_to_active')return `增加${g.runs}次${backend}额度（总${afterMax}次，已用${used}次）；${operations.continue_generation?`继续生成，最多用剩余${left}次。`:'本次不生成。'}`;
 return `保留现有${backend}额度（剩余${left}次，不增加）；${operations.continue_generation?`继续生成，最多${left}次。`:'本次不生成。'}`;
}
export function formatStudioConsentQuestion({consent_id,page,task,operations,before_doc,after_doc,after_max}){
 const lines=[`关于「${safe(page.title,24)||'当前页'}」：`],p=operations.proposal;
 if(p?.reject)lines.push('拒绝当前提案，稿件不变。');
 else if(p){const{parts,preserved}=describeChange(before_doc,after_doc);lines.push(`采纳当前提案：${parts.length?parts.join('，'):'无稿件变化'}。`);if(preserved)lines.push(preserved);}
 const control=[];if(operations.resume)control.push('交回AI');else if(task?.control==='manual')control.push('仍由你编辑');
 if(operations.exit_text_only)control.push('退出仅文字模式，编辑范围不放宽');if(control.length)lines.push(control.join('；')+'。');
 lines.push(generationLine(operations,task,after_max));
 if(operations.generation.mode==='new_task'){const goal=operations.generation.intent;if(!isBriefStudioConsentGoal(goal))fail('新任务请使用不超过80字的单句简短目标；完整提示词放稿件，参数放prepare.settings，不能只显示长意图的第一句。');lines.push(`目标：${safe(goal.trim().replace(/[。.!?！？]+$/u,''),80)}。`);}
 lines.push('同意吗？');const question=lines.join('\n');
 if([...question].length>CONSENT_QUESTION_LIMIT)fail('这组操作太多，无法简短说明；请拆成较小的确认，不要省略关键权限。');
 return question;
}
export function isShortStudioConsentQuestion(value){return typeof value==='string'&&value.trim().length>0&&[...value].length<=CONSENT_QUESTION_LIMIT&&value.endsWith('\n同意吗？')&&value.split('\n').length<=7;}
// Request identity lives in the trusted tool receipt, never in user-facing prose.
