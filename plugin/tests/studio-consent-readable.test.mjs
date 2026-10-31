import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {studioConsentQuestion} from '../src/studio-consent-domain.mjs';
const original=JSON.parse(await readFile(new URL('./fixtures/consent-study-long.json',import.meta.url),'utf8'));
// A replacement request uses an explicit brief goal, never silently edits the old request.
const sample=()=>{const x=structuredClone(original);x.operations.generation.intent=x.operations.generation.intent.split('。')[0];return x;};
const short=q=>{assert.ok([...q].length<=300,`Human confirmation was ${[...q].length} characters`);assert.ok(q.split('\n').length<=7);assert.doesNotMatch(q,/确认 [0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f-]{20,}|"(?:before|after|field)"|sha256|seed314159265358979|bbox|layout\.summary/);};
test('the actual study-room proposal produces a readable request instead of its 5465-character audit dump',()=>{
 const x=sample(),q=studioConsentQuestion(x);short(q);assert.match(q,/人物图层.*不变/);assert.match(q,/Moss.*1次/);assert.match(q,/2\/2.*留档/);assert.match(q,/不重试/);assert.match(q,/交回AI/);assert.doesNotMatch(q,/完整选中变更|实际选中变更|新任务目标|50步CFG3/);assert.match(q,/同意吗？$/);
});
test('accept-only remains explicit about no generation despite an old budget or long prompt',()=>{
 const x=sample();x.operations.generation={mode:'none',runs:0,backend:null,intent:''};x.operations.continue_generation=false;const q=studioConsentQuestion(x);short(q);assert.match(q,/本次不生成/);assert.match(q,/额度不变/);assert.doesNotMatch(q,/继续生成/);
});
test('a misleading background summary cannot hide selected character movement or camera changes',()=>{
 const x=sample();x.proposal.summary='只改背景，人物和机位绝对没变';x.after_doc.layout.items.find(i=>i.label==='character').bbox[0]+=16;x.after_doc.layout.camera={enabled:true,orbit:20};const q=studioConsentQuestion(x);short(q);assert.match(q,/人物.*位置/);assert.match(q,/机位/);assert.doesNotMatch(q,/人物图层.*不变|机位不变/);
});
test('selected perspective and prompt-output options are disclosed rather than called unchanged',()=>{for(const field of ['perspective','prompt_options']){const x=sample();x.after_doc=structuredClone(x.before_doc);x.after_doc.layout[field]=field==='perspective'?{enabled:true,mode:2}:{camera:true,depth:true};const q=studioConsentQuestion(x);short(q);assert.match(q,field==='perspective'?/透视/:/输出选项/);assert.doesNotMatch(q,/无稿件变化|输出机位不变/);}});
test('character depth and description changes are both disclosed',()=>{const x=sample();x.after_doc=structuredClone(x.before_doc);const i=x.after_doc.layout.items.find(i=>i.label==='character');i.caption='Different outfit';i.depth='bg';const q=studioConsentQuestion(x);short(q);assert.match(q,/人物描述/);assert.match(q,/人物前后层次/);});
test('hiding a character is never described as merely moving it',()=>{const x=sample();x.after_doc=structuredClone(x.before_doc);x.after_doc.layout.items.find(i=>i.label==='character').hidden=true;const q=studioConsentQuestion(x);short(q);assert.match(q,/隐藏1个人物图层/);assert.doesNotMatch(q,/调整1个人物位置/);});
test('a later sentence cannot hide additional task instructions behind a short first sentence',()=>{const x=sample();x.operations.generation.intent='整理场景背景。删掉右侧人物，改为鸟瞰镜头。';assert.throws(()=>studioConsentQuestion(x),/单句|简短目标/);x.operations.generation.intent='完整参数'.repeat(30);assert.throws(()=>studioConsentQuestion(x),/80|简短目标/);});
test('adding an allowance is not phrased as permission to generate unless continuation was approved',()=>{
 const x=sample();x.task={control:'auto',stage:'planning',max_runs:2,claimed_runs:1};x.operations.proposal=null;x.operations.resume=false;x.operations.generation={mode:'add_to_active',runs:1,backend:'moss',intent:''};x.operations.continue_generation=false;x.after_doc=x.before_doc;x.after_max=3;x.remaining=0;const q=studioConsentQuestion(x);short(q);assert.match(q,/增加1次Moss额度/);assert.match(q,/总3次.*已用1次/);assert.match(q,/本次不生成/);
});
