import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {readGuide,GUIDE_TOPICS} from '../src/guide.mjs';
import {PERSONA} from '../src/preset.mjs';
import {registerTools} from '../src/tools.mjs';
// The real DeepSeek sessions showed the agent using only t2i plus one caption
// string: camera, body, layers, text layers, multi-panel canvases, shared series
// snapshots, revisions and reference replication were never touched. These tests
// pin the discoverability fixes, not a model's behaviour.
test('quick guide routes to the capability and craft pages and keeps design ownership with the agent',async()=>{
 const quick=(await readGuide({topic:'quick'})).text;
 for(const topic of ['promptcraft','studio']) assert.ok(quick.includes(topic),topic);
 assert.match(quick,/你负责设计|设计权/);
 assert.match(quick,/第一版直接出图|直接出图给人看/);
 assert.match(quick,/不必先把整页设计完/);
 assert.ok(!/请用户(提供|给出|决定)/.test(quick),'the agent must not push the design back to the user');
 assert.match(PERSONA,/设计权在你/);
 assert.match(PERSONA,/最简稿件直接出图/);
});
test('studio page fits one default read and names every workbench capability it used to skip',async()=>{
 const studio=(await readGuide({topic:'studio'})).text;
 assert.ok(studio.length<6000,`studio page is ${studio.length} chars, a default read returns 6000`);
 assert.equal((await readGuide({topic:'studio'})).next_offset,null);
 for(const word of ['相机','体块','图层','hidden','locked','文字层','multi_panel','collage','shared','修订','参考图','regions','系列'])
  assert.ok(studio.includes(word),word);
});
test('prompt craft page covers aesthetics, complex composition and replication with honest evidence',async()=>{
 const page=(await readGuide({topic:'promptcraft'})).text;
 assert.ok(page.length<6000);
 for(const word of ['主体占比','主光','色彩','前中后三层','主次','纵深','人数','复刻','原文上局部替换','UNKNOWN'])
  assert.ok(page.includes(word),word);
 assert.ok(page.includes('至少两版')||page.includes('不是规律'),'the replication claim keeps its measured-evidence framing');
 assert.ok(!/一定|必然|保证成功/.test(page),'craft advice must not promise success');
});
test('index advertises the new pages so the agent can find them without guessing',async()=>{
 const index=(await readGuide({topic:'index'})).text;
 for(const word of ['promptcraft','能力地图']) assert.ok(index.includes(word),word);
 assert.ok(index.length<4000);
});
// A page that readGuide serves but the art_guide schema enum omits is unreachable:
// validate() rejects the topic with MOSS_INPUT and the SDK advertises the stale enum.
test('art_guide tool advertises and accepts every topic the guide serves',async()=>{
 const defs=new Map();
 registerTools({tools:{register:d=>defs.set(d.name,d)}},{sdk:{tools:{defineTool:x=>x}},getService:()=>({}),readGuide,config:{workspaceRoot:'.',dataRoot:'.'},attachments:{}});
 const tool=defs.get('art_guide');
 assert.deepEqual(tool.parameters.topic.enum,[...GUIDE_TOPICS]);
 for(const topic of ['promptcraft','studio']){
  const page=await tool.execute({topic},{signal:new AbortController().signal});
  assert.equal(page.topic,topic);assert.ok(page.text.length>500,topic);
 }
 for(const topic of GUIDE_TOPICS) await readGuide({topic,limit:1});
});
// A content boundary used to be restated in five places and drifted (moss-modes.md
// said "唯一硬边界" and dropped one clause). The duplication itself is the regression:
// no guide page, README or tool description may carry one, so there is exactly one
// place to look when the owner edits the preset.
const boundaryPhrases=/成年(虚构|人)|可辨认|真人肖像|露骨/;
test('no guide, README or tool description carries a content boundary',async()=>{
 for(const topic of GUIDE_TOPICS){
  const {text}=await readGuide({topic,limit:9000});
  assert.ok(!boundaryPhrases.test(text),`guide topic ${topic} carries a content boundary`);
 }
 const readme=await readFile(new URL('../README.md',import.meta.url),'utf8');
 assert.ok(!boundaryPhrases.test(readme),'README carries a content boundary');
 const defs=new Map();
 registerTools({tools:{register:d=>defs.set(d.name,d)}},{sdk:{tools:{defineTool:x=>x}},getService:()=>({}),readGuide,config:{workspaceRoot:'.',dataRoot:'.'},attachments:{}});
 for(const [name,definition] of defs) assert.ok(!boundaryPhrases.test(definition.description??''),`${name} description carries a content boundary`);
 assert.ok(!PERSONA.includes('唯一硬边界')&&!PERSONA.includes('硬边界只有三条'),'no boundary scaffolding is left in the persona');
});