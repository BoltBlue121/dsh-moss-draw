import test from 'node:test';
import assert from 'node:assert/strict';
import {catalog} from '../src/catalog.mjs';
import {compileGraph,normalizeInput} from '../src/core.mjs';
import {emptyStudioDoc,upgradeStudioDoc,compileStudioDoc} from '../src/studio-domain.mjs';
import {applyStudioEdit} from '../src/studio-edit.mjs';
import {encodeStudioExchange,readStudioExchange} from '../src/studio-exchange.mjs';

test('portable defaults preserve operator-provided LoRA stacks and opt into the author Heal schedule per model',()=>{
 const details=catalog();
 assert.deepEqual(details.styles.map(s=>s.id),['none']);assert.equal(details.loras.max,4);
 const input={request_id:'portable-test',prompt:'A blue cube'};
 const base=normalizeInput({...input,loras:[{file:'example-a.safetensors'},{file:'example-b.safetensors',strength:.4}]});
 assert.equal(base.cfg,3);assert.equal(base.loras.length,2);
 const heal=normalizeInput({...input,model:'heal'});
 assert.deepEqual([heal.steps,heal.cfg,heal.shift,heal.seed,heal.sampler,heal.style,heal.slg],[16,3,5,0,'euler','none','22']);
 const graph=compileGraph(heal,'aaaaaaaa-1111-4111-8111-111111111111');
 const nodes=Object.values(graph);assert.ok(nodes.some(n=>n.class_type==='ManualSigmas'));
 assert.ok(nodes.some(n=>n.class_type==='KSamplerSelect'&&n.inputs.sampler_name==='euler'));
 assert.match(details.model_sources.heal.model_card,/KBlueLeaf\/MOSS-Image-heal/);
});

test('rich public document keeps its explicit subjects through panel, balloon and full exchange',()=>{
 let doc=upgradeStudioDoc(emptyStudioDoc());doc.layout.width=doc.layout.height=128;doc.layout.summary.caption='A harbor.';
 doc.layout.items=[{id:'pilot',label:'character',caption:'A pilot.',bbox:[32,24,64,100]}];
 doc=applyStudioEdit(doc,'panel',{op:'knife',target_id:null,start:[0,40],end:[128,80],gutter_px:4}).doc;
 doc=applyStudioEdit(doc,'annotation',{op:'bubble_create',id:'voice',bbox:[3,5,54,34],text:'Hi',style:'oval',tail:{speaker_id:'pilot',anchor:[.5,.2]}}).doc;
 const reopened=readStudioExchange(encodeStudioExchange(doc,'Synthetic page')).doc;
 assert.deepEqual(reopened,doc);
 const prompt=JSON.parse(compileStudioDoc(reopened).prompt);
 assert.equal(prompt.items.filter(i=>i.label==='character').length,1);
 assert.equal(prompt.items.filter(i=>i.label==='object').length,0);
 assert.equal(prompt.items.find(i=>i.label==='text').text,'Hi');
});
