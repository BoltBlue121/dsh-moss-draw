import test from 'node:test';
import assert from 'node:assert/strict';
import { STYLES } from '../src/catalog.mjs';
const mod = await import('../src/native-edit.mjs').catch(e => { if (e.code === 'ERR_MODULE_NOT_FOUND') return {}; throw e; });
const api = () => { assert.equal(typeof mod.NATIVE_EDIT_ADAPTER?.normalize, 'function', 'native fixed adapter must exist'); return mod.NATIVE_EDIT_ADAPTER; };
const id = 'bba17a25-9c17-41f2-8614-9f57186c2c35';
const input = { request_id: 'native-1', prompt: '  Change only the cup.\n', seed: 42 };
const asset = (width = 768, height = 512) => ({ width, height, data: Buffer.from('core-trusted fixture'), mediaType: 'image/png', sha256: 'a'.repeat(64) });
const upload = i => ({ name: `moss-${id}-ref${i + 1}.png`, subfolder: '', type: 'input' });
const invalid = fn => assert.throws(fn, { code: 'INVALID_INPUT' });

test('native graph uses standard MODEL with fixed edit LoRA and truthful sampler summary', () => {
  const a = api(), p = a.normalize(input, [asset()]); const { graph: g, outputNode } = a.compile(p, id, [upload(0)]);
  assert.equal(outputNode, '12'); assert.equal(a.maxPixels, 2100000);
  assert.equal(p.backend, 'moss'); assert.equal(p.mode, 'edit'); assert.equal(p.model, 'sft'); assert.equal(p.model_variant, 'native-sft-edit');
  assert.equal(p.style, 'none'); assert.equal(p.lora_strength, 0); assert.equal(p.sampler, 'euler'); assert.equal(p.scheduler, 'sgm_uniform'); assert.equal(p.slg, null);
  assert.equal(p.reference_max_edge, 512); assert.equal(p.batch_size, 1);
  assert.equal(g['1'].inputs.unet_name, 'moss_image_sft_int8_convrot.safetensors');
  assert.deepEqual(g['2'].inputs, { clip_name: 'qwen3.5_9b_w4a8_gptq.safetensors', type: 'moss_image', device: 'default' });
  assert.equal(g['3'].inputs.vae_name, 'flux2-vae_small.safetensors');
  assert.deepEqual(g['4'].inputs, { model: ['1', 0], lora_name: 'MOSS-Image-Edit-rank64.safetensors', strength_model: 1 });
  assert(!g['5']); assert.deepEqual(g['6'].inputs, { model: ['4', 0], shift: 5 });
  assert.deepEqual(g['9'].inputs, { width: 768, height: 512, batch_size: 1 });
  assert.deepEqual(g['10'].inputs, { model: ['6', 0], positive: ['7', 0], negative: ['8', 0], latent_image: ['9', 0], seed: 42, steps: 30, cfg: 4, sampler_name: 'euler', scheduler: 'sgm_uniform', denoise: 1 });
  assert.equal(g['12'].inputs.filename_prefix, `moss_draw/${id}/native`);
  assert(!Object.values(g).some(n => ['MossImageEdit', 'MossImageEditLoader', 'MossDrawEditStyleLoader', 'ApplyMossImageEdit'].includes(n.class_type)));
});

test('positive and negative use official zero-based autogrow references with correct edit format', () => {
  const a = api(); const p = a.normalize({ ...input, negative: 'blur' }, [asset()]); const g = a.compile(p,id,[upload(0)]).graph;
  for (const key of ['7','8']) {
    assert.equal(g[key].class_type, 'TextEncodeMOSSImageEdit');
    assert.deepEqual(g[key].inputs.clip, ['2',0]); assert.deepEqual(g[key].inputs.vae, ['3',0]);
    assert.equal(g[key].inputs.edit_format, 'Moss-Image-Edit');
    assert.deepEqual(g[key].inputs['images.image_0'], ['21',0]);
    assert(!Object.hasOwn(g[key].inputs,'images.image_1'));
  }
  assert.equal(g['7'].inputs.prompt,input.prompt); assert.equal(g['8'].inputs.prompt,'blur');
});

test('four independently scaled references preserve order on both conditionings without concatenating batches', () => {
  const a = api(); const assets = [asset(768,512),asset(300,200),asset(1000,1500),asset(7,23)];
  const p = a.normalize(input,assets); const g = a.compile(p,id,assets.map((_,i)=>upload(i))).graph;
  assert.deepEqual(p.reference_sizes, [
    {source_width:768,source_height:512,width:512,height:336},
    {source_width:300,source_height:200,width:288,height:192},
    {source_width:1000,source_height:1500,width:336,height:512},
    {source_width:7,source_height:23,width:16,height:16},
  ]);
  for (let i=0;i<4;i++) {
    const load=String(20+i*2),scale=String(21+i*2),size=p.reference_sizes[i];
    assert.equal(g[load].class_type,'LoadImage');assert.equal(g[load].inputs.image,upload(i).name);
    assert.deepEqual(g[scale],{class_type:'ImageScale',inputs:{image:[load,0],upscale_method:'lanczos',width:size.width,height:size.height,crop:'disabled'}});
    for (const n of ['7','8']) assert.deepEqual(g[n].inputs[`images.image_${i}`],[scale,0]);
  }
  assert.equal(Object.values(g).filter(n=>n.class_type==='LoadImage').length,4);
  assert(!Object.hasOwn(g['7'].inputs,'images.image_4'));assert.equal(p.reference_count,4);
  assert(Object.isFrozen(p)); assert(Object.isFrozen(p.reference_sizes)); assert(Object.isFrozen(p.reference_sizes[0]));
});

test('style none never adds a style stack and every styled request is rejected', () => {
  // The portable package ships only style none, so there is no style node after
  // the edit adapter and no trigger; historical styles are a rejection path.
  assert.deepEqual(Object.keys(STYLES), ['none']);
  assert.equal(STYLES.none.file, null);
  const a=api();const p=a.normalize({...input,style:'none',lora_strength:0},[asset()]);const g=a.compile(p,id,[upload(0)]).graph;
  assert.equal(g['1'].inputs.unet_name,'moss_image_sft_int8_convrot.safetensors');
  assert(!g['5']);assert.deepEqual(g['6'].inputs.model,['4',0]);assert.equal(g['4'].inputs.strength_model,1);
  assert.equal(g['7'].inputs.prompt,input.prompt);
  for (const style of ['styled','unknown-style']) invalid(()=>a.normalize({...input,style,lora_strength:.6},[asset()]));
});

test('zero style strength keeps style none and the required edit adapter', () => {
  const a=api();const p=a.normalize({...input,style:'none',lora_strength:0},[asset()]);const g=a.compile(p,id,[upload(0)]).graph;
  assert(!g['5']);assert.deepEqual(g['6'].inputs.model,['4',0]);assert.equal(g['4'].inputs.strength_model,1);assert.equal(g['7'].inputs.prompt,input.prompt);
});

test('explicit canvas and supported parameters compile unchanged, default canvas never silently rounds', () => {
  const a=api();
  const p=a.normalize({...input,backend:'moss',mode:'edit',width:1024,height:768,steps:47,cfg:3.25,shift:6.5,seed:0,negative:'noise',brief:'brief',checks:['cup red'],parent_run_id:id},[asset(771,513)]);
  const g=a.compile(p,id,[upload(0)]).graph;
  assert.deepEqual(g['9'].inputs,{width:1024,height:768,batch_size:1});assert.equal(g['10'].inputs.steps,47);assert.equal(g['10'].inputs.cfg,3.25);assert.equal(g['10'].inputs.seed,0);assert.equal(g['6'].inputs.shift,6.5);
  assert.equal(p.parent_run_id,id);assert.deepEqual(p.checks,['cup red']);
  invalid(()=>a.normalize(input,[asset(771,513)]));invalid(()=>a.normalize(input,[asset(128,128)]));
  invalid(()=>a.normalize({...input,width:1024},[asset()]));
  for(const patch of [{width:2048,height:2048},{width:1025,height:768},{width:0,height:768},{width:2064,height:512}])invalid(()=>a.normalize({...input,...patch},[asset()]));
});

test('native normalization rejects unsupported fields, routes, arbitrary files and malformed assets', () => {
  const a=api();
  for(const key of ['path','references','graph','workflow','url','comfyUrl','shell','lora_name','edit_lora','reference_max_edge','sampler','scheduler','slg','batch_size','model_variant','reference_sizes','characters','__proto__']) {
    const raw={...input};Object.defineProperty(raw,key,{value:'bad',enumerable:true});invalid(()=>a.normalize(raw,[asset()]));
  }
  for(const patch of [{backend:'k2'},{mode:'inpaint'},{model:'base'},{style:'unknown'},{style:'__proto__'},{style:'none',lora_strength:1},{lora_strength:-1},{lora_strength:3},{steps:0},{steps:101},{cfg:NaN},{shift:0},{shift:21},{seed:-1},{seed:Number.MAX_SAFE_INTEGER+1},{seed:true},{request_id:'../x'},{prompt:' '},{checks:[3]}])invalid(()=>a.normalize({...input,...patch},[asset()]));
  for(const refs of [[],Array(5).fill(asset()),[asset(0,3)],[asset(4097,1)],[asset(2048,2048)],Array(2)])invalid(()=>a.normalize(input,refs));
});

test('compile revalidates every normalized field including reference resize provenance', () => {
  const a=api(),p=a.normalize(input,[asset()]);
  for(const patch of [{backend:'k2'},{mode:'t2i'},{model:'base'},{model_variant:'full-sft-edit'},{sampler:'heun'},{scheduler:'normal'},{slg:'22'},{batch_size:2},{reference_max_edge:1024},{reference_count:2},{shift:0},{graph:{}},{reference_sizes:[{...p.reference_sizes[0],width:496}]},{reference_sizes:[{...p.reference_sizes[0],path:'secret'}]}])invalid(()=>a.compile({...p,...patch},id,[upload(0)]));
  invalid(()=>a.compile(p,'../x',[upload(0)]));
  const jsonRoundtrip=JSON.parse(JSON.stringify(p));assert.deepEqual(a.compile(jsonRoundtrip,id,[upload(0)]),a.compile(p,id,[upload(0)]));
});

test('compile rejects wrong count, foreign run, reordered and arbitrary upload paths', () => {
  const a=api(),p=a.normalize(input,[asset(),asset()]);
  for(const uploads of [[],[upload(0)],[upload(1),upload(0)],[upload(0),{...upload(1),name:'../../private.png'}],[upload(0),{...upload(1),subfolder:'other'}],[upload(0),{...upload(1),type:'output'}],[upload(0),{...upload(1),name:'moss-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa-ref2.png'}]])invalid(()=>a.compile(p,id,uploads));
});

test('templates clone per invocation and shorter next calls remove all extra reference nodes', () => {
  const a=api();const p=a.normalize(input,[asset(),asset(),asset(),asset()]);const first=a.compile(p,id,[0,1,2,3].map(upload));first.graph['1'].inputs.unet_name='evil';
  const next=a.compile(a.normalize(input,[asset()]),id,[upload(0)]).graph;
  assert.equal(next['1'].inputs.unet_name,'moss_image_sft_int8_convrot.safetensors');assert(!next['22']);assert(!next['7'].inputs['images.image_1']);
});

test('checks reject sparse slots before persistence while dense checks roundtrip unchanged', () => {
  const a=api();const sparse=Array(3);sparse[1]='cup red';
  for(const checks of [Array(1),sparse])invalid(()=>a.normalize({...input,checks},[asset()]));
  const p=a.normalize({...input,checks:['cup red','background unchanged']},[asset()]);
  assert.deepEqual(p.checks,['cup red','background unchanged']);
  assert.deepEqual(a.compile(JSON.parse(JSON.stringify(p)),id,[upload(0)]),a.compile(p,id,[upload(0)]));
});

test('native catalog makes separate engine requirements and defaults explicit', () => {
  api();const c=mod.NATIVE_EDIT_CATALOG;assert.equal(c.id,'edit');assert.equal(c.model_variant,'native-sft-edit');assert.equal(c.defaults.style,'none');assert.equal(c.defaults.scheduler,'sgm_uniform');assert.equal(c.defaults.slg,null);assert.deepEqual(c.references,[1,4]);assert.equal(c.required_core_commit,'60aade0bb0cbc298547fceb136cd195cea67800b');
});
