import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const references={'moss-modes':'moss-modes.md',k2:'k2.md',qwen:'qwen.md',regions:'regions.md',workbench:'workbench.md',studio:'studio.md',promptcraft:'promptcraft.md'};
// Single source for the art_guide topic enum, so a new page cannot be readable here but rejected by the tool schema.
export const GUIDE_TOPICS=Object.freeze(['quick','index',...Object.keys(references)]);
const index=`Moss prompt reference\n\nquick: 工具契约与提示词入口。studio: 工作台能力地图（系列/页/修订/图层/文字层/画布/相机体块/shared/参考图）、执行顺序、同一页续画、错误分流。promptcraft: 提示词手艺——一版好看（主体占比/主光/色彩/前中后层/细节密度/镜头）、复杂构图（主次/纵深/动作线/人数）、精确复刻（在原文上局部改/成对部件/尺寸换算）、真实失败与对策、审图十项。workbench: 旧会话共享文档、提案/采纳、revision冲突、3D体块投影、materialize只固化draft。regions: 自主划区并绑定角色参考，预览后授权执行。moss-modes/k2/qwen: 后端参数与验证边界。\n\n本包只提供自身实现的接口页与参数页，不附带第三方提示词库原文。画风只由正文媒介描述决定；本包不附带画风 LoRA，需要固定画风时可用自己的 LoRA 叠加。\n\nart_guide({topic,offset,limit})，单次最多9000字符，next_offset为null时读完。画图前读quick，按需再读其它页。`;
export async function readGuide(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['topic','offset','limit'].includes(k)))throw Error('MOSS_GUIDE_INPUT');
  const {topic='quick',offset=0,limit=6000}=input;
  if(!GUIDE_TOPICS.includes(topic))throw Error('MOSS_GUIDE_TOPIC');
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>9000)throw Error('MOSS_GUIDE_PAGING');
  let text;
  if(topic==='quick')text=await readFile(new URL('skills/ai-drawing/SKILL.md',root),'utf8');
  else if(Object.hasOwn(references,topic))text=await readFile(new URL('skills/ai-drawing/references/'+references[topic],root),'utf8');
  else text=index;
  const end=Math.min(text.length,offset+limit);
  return {topic,source:'AI Drawing independent interface guide',offset,text:text.slice(offset,end),next_offset:end<text.length?end:null,total_chars:text.length};
}