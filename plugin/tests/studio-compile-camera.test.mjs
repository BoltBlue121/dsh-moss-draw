import test from 'node:test';import assert from 'node:assert/strict';
import {compileStudioDoc,emptyStudioDoc} from '../src/studio-domain.mjs';
const doc=()=>{const d=emptyStudioDoc();d.layout.summary.caption='Two blocks in a clean room.';d.layout.items=[{id:'one',label:'object',caption:'Blue cube',bbox:[256,256,512,512],body:{z:1,thickness:0,yaw:0,anchor:'world'}},{id:'title',label:'text',caption:'A title',text:'HELLO',bbox:[32,32,480,128],body:{z:1,thickness:0,yaw:0,anchor:'screen'}}];d.layout.prompt_options={depth:false,camera:false,perspective:false};return d;};
test('moved Studio camera compiles projected geometry without rewriting editor bounds or screen anchors',()=>{
 const d=doc(),before=structuredClone(d);d.layout.camera={enabled:true,distance:2};const saved=structuredClone(d),r=compileStudioDoc(d);assert.equal(r.compiled,true,JSON.stringify(r.checks));const out=JSON.parse(r.prompt);assert.deepEqual(out.items[0].bbox,[-128,-128,0,0]);assert.deepEqual(out.items[1].bbox,[-480,-480,-384,-32]);assert.deepEqual(d,saved);assert.deepEqual(d.layout.items,before.layout.items);
});
test('moved camera view rounds clipped pixel boxes before official coordinate conversion',()=>{
 const d=doc();d.layout.items=d.layout.items.slice(0,1);d.layout.items[0].bbox=[512,512,700,700];d.layout.camera={enabled:true,distance:1.5};const r=compileStudioDoc(d);assert.equal(r.compiled,true);assert.deepEqual(JSON.parse(r.prompt).items[0].bbox,[0,0,125,125]);
});
test('camera off and enabled base camera preserve exact coordinate compilation and item order',()=>{
 const d=doc(),plain=compileStudioDoc(d);d.layout.camera={enabled:false,orbit:40,distance:3};assert.equal(compileStudioDoc(d).prompt,plain.prompt);d.layout.camera={enabled:true};assert.equal(compileStudioDoc(d).prompt,plain.prompt);
});
test('moved camera excludes world items outside the view but keeps literal screen text',()=>{
 const d=doc();d.layout.camera={enabled:true,pan_x:3};const r=compileStudioDoc(d);assert.equal(r.compiled,true,JSON.stringify(r.checks));const out=JSON.parse(r.prompt);assert.equal(out.items.length,1);assert.equal(out.items[0].text,'HELLO');assert.equal(d.layout.items.length,2);
});
test('camera prompt is optional and appended only in compiled copy',()=>{
 const d=doc();d.layout.camera={enabled:true,orbit:15};d.layout.prompt_options.camera=true;const r=compileStudioDoc(d);assert.equal(r.compiled,true,JSON.stringify(r.checks));assert.match(JSON.parse(r.prompt).summary.caption,/camera/i);assert.equal(d.layout.summary.caption,'Two blocks in a clean room.');d.layout.prompt_options.camera=false;assert.equal(JSON.parse(compileStudioDoc(d).prompt).summary.caption,d.layout.summary.caption);
});
test('perspective settings supply optional lens guidance without pretending to warp boxes',()=>{
 const d=doc();d.layout.perspective={enabled:true,mode:2,horizon_y:400,vp1_x:-300,vp2_x:1600};d.layout.prompt_options.perspective=true;const r=compileStudioDoc(d);assert.equal(r.compiled,true,JSON.stringify(r.checks));assert.match(JSON.parse(r.prompt).summary.caption,/two.point|2.point/i);assert.deepEqual(JSON.parse(r.prompt).items[0].bbox,[-256,-256,0,0]);
});
test('original camera-text precedence is explicit and perspective resumes when camera text is off',()=>{
 const d=doc();d.layout.camera={enabled:true,orbit:5};d.layout.perspective={enabled:true,mode:2};d.layout.prompt_options={camera:true,perspective:true,depth:false};
 let text=JSON.parse(compileStudioDoc(d).prompt).summary.caption;assert.match(text,/Camera/i);assert.doesNotMatch(text,/two-point/);
 d.layout.prompt_options.camera=false;text=JSON.parse(compileStudioDoc(d).prompt).summary.caption;assert.match(text,/two-point/);
});
test('explicit depth option appends foreground relation only to compiler copy',()=>{
 const d=doc();d.layout.items[0].depth='fg';d.layout.prompt_options.depth=true;const r=compileStudioDoc(d);assert.equal(r.compiled,true);assert.match(JSON.parse(r.prompt).items[0].caption,/foreground/i);assert.equal(d.layout.items[0].caption,'Blue cube');
});
