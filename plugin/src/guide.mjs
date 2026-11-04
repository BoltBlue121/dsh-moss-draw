import {readFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const source='Moeblack / moss-image-prompt-skill v2.0.0 @ 8de83f4 / CC-BY-NC-ND-4.0';
const sections={anime:15,structure:16,finish:17};
const references={'moss-modes':'moss-modes.md',k2:'k2.md',qwen:'qwen.md',regions:'regions.md',workbench:'workbench.md',studio:'studio.md',analysis:'analysis.md',promptcraft:'promptcraft.md',unrestricted:'unrestricted.md',loras:'loras.md',setup:'setup.md'};
// Single source for the art_guide topic enum, so a new page cannot be readable here but rejected by the tool schema.
export const GUIDE_TOPICS=Object.freeze(['quick','index',...Object.keys(sections),...Object.keys(references)]);
const index=`Moss prompt reference\n\nquick: 工具契约与提示词入口。analysis: 显式参考图GBC对象/部件/关系分析、稳定request_key、等待/状态与待审提案；不生图、不自动采纳。studio: 工作台能力地图（系列/页/修订/图层/文字层/画布/相机体块/shared/参考图）、执行顺序、同一页续画、错误分流。promptcraft: 提示词手艺——一版好看（主体占比/主光/色彩/前中后层/细节密度/镜头）、复杂构图（主次/纵深/动作线/人数）、精确复刻（在原文上局部改/成对部件/尺寸换算）、真实失败与对策、审图十项。unrestricted: 旧topic兼容，现讲授权范围、预算与错误分流，不将拒绝当重跑理由。setup: 本地/远端ComfyUI、可信工作区和只读连接诊断。workbench: 旧会话共享文档、提案/采纳、revision冲突、3D体块投影、materialize只固化draft。regions: 自主划区并绑定角色参考，预览后授权执行。moss-modes/k2/qwen: 后端参数与验证边界。loras: 自挂 LoRA 目录查询（art_context lora_catalog）、触发词与强度、注册表维护。
anime: Moeblack原文§15。structure: 原文§16通用规则（至16.3前）。finish: 原文§17的画面主次及17.1第1项（至人物模板前）。均为原样摘录分页；角色专用示例不自动载入。

来源 https://github.com/Moeblack/moss-image-prompt-skill/tree/8de83f48a372f3056a7d5d2c1677460eab6c1f67
原文与LICENSE保留在vendor/moeblack；CC-BY-NC-ND-4.0，非商业使用，禁止分发改作。

原文里的角色年龄、写实场景与快速参数只是示例，不是当前任务设定；角色/题材只由用户要求和实际画面决定。原文的机制或定量收益是作者主张，不是本机验收。LoRA触发词以工具目录为准。用户显式参数优先，不把t2i的50步基线套到编辑或区域阶段。

art_guide({topic,offset,limit})，单次最多9000字符，next_offset为null时读完。画图前读quick，按需再读其它页。`;
export async function readGuide(input={}){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['topic','offset','limit'].includes(k)))throw Error('MOSS_GUIDE_INPUT');
  const {topic='quick',offset=0,limit=6000}=input;
  if(!['quick','index',...Object.keys(sections),...Object.keys(references)].includes(topic))throw Error('MOSS_GUIDE_TOPIC');
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>9000)throw Error('MOSS_GUIDE_PAGING');
  let text;
  if(topic==='quick')text=await readFile(new URL('skills/ai-drawing/SKILL.md',root),'utf8');
  else if(Object.hasOwn(references,topic))text=await readFile(new URL('skills/ai-drawing/references/'+references[topic],root),'utf8');
  else if(topic==='index')text=index;
  else{
    const original=await readFile(new URL('vendor/moeblack/SKILL.md',root),'utf8');
    const n=sections[topic],start=original.indexOf(`## ${n}. `);
    // Return exact guidance excerpts, not the source's character-specific examples.
    // The complete licensed work remains byte-for-byte intact in vendor.
    const endMarker=topic==='structure'?'### 16.3 ':topic==='finish'?'#### 2. 第 2 块':`## ${n+1}. `;
    const end=original.indexOf(endMarker,start+1);
    if(start<0||end<0)throw Error('MOSS_GUIDE_SOURCE_VERSION');
    text=original.slice(start,end);
  }
  const end=Math.min(text.length,offset+limit);
  return {topic,source:sections[topic]?source:'AI Drawing independent interface guide',offset,text:text.slice(offset,end),next_offset:end<text.length?end:null,total_chars:text.length};
}
