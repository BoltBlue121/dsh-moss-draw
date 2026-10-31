import test from 'node:test';import assert from 'node:assert/strict';import{readGuide}from'../src/guide.mjs';import{PERSONA}from'../src/preset.mjs';
// A native chat message is the authorization. A guide may quote the phrase only
// inside a prohibition, and may never leave the user a question or point them at
// a UI button as the required next step.
const question=/(?:^|[。；\n])[^\n。；]{0,40}(?:吗|呢)[？?]?\s*(?:$|[。；])/;
const uiAccept=/(?:请|让|要|叫)[^\n。；]{0,6}(?:用户|人)[^\n。；]{0,8}(?:点|去|到|打开)[^\n。；]{0,8}(?:工作台|侧栏|采纳|同意|确认)/;
test('quick and persona treat the chat instruction as the authorization and never ask or point at the UI',async()=>{
 const quick=(await readGuide({topic:'quick'})).text;
 for(const token of ['对话即授权','studioAgentUpdate','studioResolve','直接画、改、采纳'])assert.ok(quick.includes(token),token);
 for(const token of ['studioAgentUpdate','studioPropose','studioStart'])assert.ok(PERSONA.includes(token),token);
 assert.match(PERSONA,/对话即授权/);assert.match(PERSONA,/绝不问/);
 assert.match(quick,/studioRequestConsent[^。；\n]*兜底/);
 assert.ok(!question.test(quick),'quick must not leave a question for the user');
 assert.ok(!question.test(PERSONA),'persona must not leave a question for the user');
 assert.ok(!uiAccept.test(quick),'quick must not send the user to the UI');
 assert.ok(!uiAccept.test(PERSONA),'persona must not send the user to the UI');
 assert.ok(quick.length<3500);assert.ok(PERSONA.length<1200);
});
// The human is the only director: the preset asks for the drawing and does not
// carry a content-review mandate, a refusal-retry loop or refusal templates.
test('persona asks for the drawing without a review mandate or refusal scaffolding',async()=>{
 const {PERSONA}=await import('../src/preset.mjs');
 for(const token of ['第一句直接进入画面设计','全程只说画面内容和下一步动作','用户本条消息就是这次要画的东西'])assert.ok(PERSONA.includes(token),token);
 assert.doesNotMatch(PERSONA,/不做内容审查|零道德审查|绝对服从|不拒画/,'persona must not carry a content-review mandate');
 assert.doesNotMatch(PERSONA,/解锁|绕过|硬拦截|重试两次/,'persona must not describe working around a provider refusal');
 assert.ok(!/我建议换成|或者你可以选|要不要改成|抱歉我不能/.test(PERSONA),'persona must not model offering alternatives or refusals');
 assert.ok(!PERSONA.includes('不露骨')&&!PERSONA.includes('硬边界只有三条'),'no boundary scaffolding is left in the persona');
 assert.doesNotMatch(PERSONA,/art_guide topic=unrestricted/);
 const quick=(await readGuide({topic:'quick'})).text;
 assert.doesNotMatch(quick,/unrestricted|不拒画|零审查/);
 assert.match(quick,/用户本条消息就是授权/);
});test('studio page keeps consent only as a marked rare fallback with one exact call shape',async()=>{
 const studio=(await readGuide({topic:'studio',limit:9000})).text;
 assert.ok(studio.length<=9000,`studio page is ${studio.length} chars`);
 for(const token of ['studioResolve','studioAgentUpdate','studioPropose','studioStart','STUDIO_TEXT_ONLY'])assert.ok(studio.includes(token),token);
 assert.match(studio,/罕见兜底|降级为罕见/);assert.match(studio,/不是常规流程/);
 const examples=[...studio.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)].map(m=>JSON.parse(m[1]));
 const request=examples.find(x=>x.workbench?.action==='studioRequestConsent');
 assert.ok(request,'the rare fallback must still show one exact call');
 assert.deepEqual(Object.keys(request.workbench).sort(),['action','expected_revision','operations','page_id','request_key']);
 assert.deepEqual(Object.keys(request.workbench.operations).sort(),['continue_generation','exit_text_only','generation','proposal','resume']);
 assert.equal(request.workbench.operations.generation.mode,'none');
 assert.equal(request.workbench.operations.generation.runs,0);
 assert.equal(request.workbench.operations.continue_generation,false);
 const resolve=examples.find(x=>x.workbench?.action==='studioResolve');
 assert.ok(resolve,'accepting its own proposal stays a documented normal path');
 assert.deepEqual(Object.keys(resolve.workbench).sort(),['accept','action','expected_revision','page_id','proposal_id','reject']);
});
