import test from 'node:test';
import assert from 'node:assert/strict';

const module = await import('../src/backends.mjs').catch(e => {
  if (e.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw e;
});
const adapters = () => {
  assert.equal(typeof module.K2_ADAPTER?.normalize, 'function', 'K2 fixed adapter must exist');
  assert.equal(typeof module.QWEN_ADAPTER?.compile, 'function', 'Qwen fixed adapter must exist');
  return module;
};
const id = 'bba17a25-9c17-41f2-8614-9f57186c2c35';
const input = { request_id: 'backend-test', prompt: '  Keep the exact user instruction.\n', seed: 42 };
const asset = (width = 1024, height = 1536) => ({ data: Buffer.from('trusted core-decoded asset'), mediaType: 'image/png', width, height, sha256: 'a'.repeat(64) });
const upload = n => ({ name: `moss-${id}-ref${n}.png`, subfolder: '', type: 'input' });
const invalid = operation => assert.throws(operation, { code: 'INVALID_INPUT' });

// Portable K2 has no style LoRA: its template carries no LoraLoaderModelOnly
// node and KSampler reads the raw UNET loader.
test('K2 defaults compile Turbo model-only graph without style LoRA or prompt change', () => {
  const { K2_ADAPTER: a } = adapters();
  const p = a.normalize(input, []); const { graph: g, outputNode } = a.compile(p, id, []);
  assert.equal(outputNode, '9');
  assert.equal(p.backend, 'k2'); assert.equal(p.mode, 't2i');
  assert.equal(p.style, 'none'); assert.equal(p.lora_strength, 0); assert.equal(p.model, 'krea2_turbo_fp8_scaled');
  assert.equal(g['1'].inputs.unet_name, 'krea2_turbo_fp8_scaled.safetensors');
  assert.deepEqual(g['2'].inputs, { clip_name: 'qwen3vl_4b_fp8_scaled.safetensors', type: 'krea2', device: 'cpu' });
  assert.equal(g['3'].inputs.vae_name, 'qwen_image_vae.safetensors');
  assert.equal(g['4'].inputs.text, input.prompt);
  assert(!g['10'], 'the portable K2 template ships no style LoRA node');
  assert(!Object.values(g).some(n => n.class_type === 'LoraLoaderModelOnly'));
  assert.deepEqual(g['7'].inputs, { model: ['1', 0], positive: ['4', 0], negative: ['5', 0], latent_image: ['6', 0], seed: 42, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 });
  assert.deepEqual(g['6'].inputs, { width: 1024, height: 1536, batch_size: 1 });
  assert.equal(g['9'].inputs.filename_prefix, `moss_draw/${id}/native`);
  assert(!Object.values(g).some(n => n.class_type === 'LoadImage'));
  assert(Object.isFrozen(p)); assert(Object.isFrozen(p.checks));
});

test('K2 explicit supported settings compile and none removes LoRA connection', () => {
  const { K2_ADAPTER: a } = adapters();
  const raw = { ...input, backend: 'k2', mode: 't2i', style: 'none', negative: 'blur', width: 2560, height: 1440, steps: 12, cfg: 1, lora_strength: 0, brief: 'brief', checks: ['one cup'], parent_run_id: id };
  const p = a.normalize(raw, []); const { graph: g } = a.compile(p, id, []);
  assert.equal(g['4'].inputs.text, raw.prompt); assert.equal(g['5'].class_type, 'CLIPTextEncode'); assert.equal(g['5'].inputs.text, 'blur');
  assert(!g['10']); assert.deepEqual(g['7'].inputs.model, ['1', 0]);
  assert.equal(g['7'].inputs.steps, 12); assert.deepEqual(g['6'].inputs, { width: 2560, height: 1440, batch_size: 1 });
  assert.equal(p.parent_run_id, id); assert.deepEqual(p.checks, ['one cup']);
});

test('K2 rejects image conditioning, wrong modes, styles, strength and silently ignored CFG', () => {
  const { K2_ADAPTER: a } = adapters();
  invalid(() => a.normalize(input, [asset()]));
  for (const patch of [{ mode: 'edit' }, { backend: 'qwen' }, { style: 'styled' }, { model: 'sft' }, { cfg: 3 }, { steps: 7 }, { steps: 21 }, { style: 'none', lora_strength: 1 }, { style: 'none', lora_strength: 0.5 }, { lora_strength: -1 }, { shift: 5 }]) invalid(() => a.normalize({ ...input, ...patch }, []));
});

test('K2 accepts known landscapes but rejects unapproved large portrait and grid violations', () => {
  const { K2_ADAPTER: a } = adapters();
  for (const [width, height] of [[256, 256], [1152, 1728], [2048, 1536], [2560, 1440], [2560, 1536]]) {
    const p = a.normalize({ ...input, width, height }, []); assert.equal(a.compile(p, id, []).graph['6'].inputs.width, width);
  }
  for (const [width, height] of [[1536, 2048], [2048, 2048], [1008, 1024], [2592, 1536], [0, 1024]]) invalid(() => a.normalize({ ...input, width, height }, []));
});

test('Qwen single reference inherits exact canvas instead of silently resizing', () => {
  const { QWEN_ADAPTER: a } = adapters();
  const p = a.normalize({ ...input, backend: 'qwen', mode: 'edit' }, [asset()]);
  const { graph: g, outputNode } = a.compile(p, id, [upload(1)]);
  assert.equal(outputNode, '13'); assert.equal(p.width, 1024); assert.equal(p.height, 1536);
  assert.equal(p.steps, 8); assert.equal(p.cfg, 1); assert.equal(p.sampler, 'euler'); assert.equal(p.scheduler, 'manual_sigmas'); assert.equal(p.shift, null);
  assert.equal(g['1'].inputs.unet_name, 'qwen_image_2.1_turbo_int8_convrot.safetensors');
  assert.equal(g['2'].inputs.clip_name, 'qwen3vl_8b_int8_convrot.safetensors'); assert.equal(g['3'].inputs.vae_name, 'qwen_image_2.1_vae_bf16.safetensors');
  assert.equal(g['6'].class_type, 'TextEncodeQwenImageEditPlus'); assert.deepEqual(g['6'].inputs.image1, ['4', 0]);
  assert.equal(g['6'].inputs.prompt, input.prompt); assert.equal(g['4'].inputs.image, upload(1).name);
  assert(!g['5']); assert(!Object.hasOwn(g['6'].inputs, 'image2'));
  assert.deepEqual(g['8'].inputs, { width: 1024, height: 1536, batch_size: 1 });
  assert.equal(g['10'].inputs.sigmas, '1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0');
  assert.equal(g['11'].inputs.cfg, 1); assert.equal(g['11'].inputs.noise_seed, 42);
  assert.deepEqual(g['11'].inputs.latent_image, ['8', 0]);
  assert.equal(g['13'].inputs.filename_prefix, `moss_draw/${id}/native`);
});

test('Qwen preserves exact supported source size and only resizes when explicit', () => {
  const { QWEN_ADAPTER: a } = adapters();
  for (const [w,h] of [[1024,1024],[1024,1536],[1696,2528],[2560,1440],[1152,1792]]) {
    const p=a.normalize(input,[asset(w,h)]);assert.deepEqual([p.width,p.height],[w,h]);
  }
  for (const [width,height] of [[2048,2048],[2400,1792],[1792,2400],[2528,1696],[1696,2528],[2752,1536],[1536,2752]]) {
    const p = a.normalize({ ...input, width, height }, [asset()]);
    assert.deepEqual(a.compile(p,id,[upload(1)]).graph['8'].inputs, { width, height, batch_size: 1 });
  }
  invalid(() => a.normalize(input, [asset(1200,800)]));
  invalid(() => a.normalize({ ...input, width: 1024 }, [asset()]));
  invalid(() => a.normalize({ ...input, width: 2048, height: 2304 }, [asset()]));
  invalid(() => a.normalize({ ...input, width: 1025, height: 1024 }, [asset()]));
});

test('Qwen second reference is ordered material input and cannot overwrite primary canvas', () => {
  const { QWEN_ADAPTER: a } = adapters();
  const p = a.normalize(input, [asset(), asset(512,512)]);
  const g = a.compile(p, id, [upload(1),upload(2)]).graph;
  assert.equal(g['4'].inputs.image, upload(1).name); assert.equal(g['5'].inputs.image, upload(2).name);
  assert.deepEqual(g['6'].inputs.image1, ['4',0]); assert.deepEqual(g['6'].inputs.image2, ['5',0]);
  invalid(() => a.compile(p,id,[upload(1)]));
  invalid(() => a.compile(p,id,[upload(2),upload(1)]));
});

test('Qwen rejects unsupported mode/style/negative/steps and reference counts', () => {
  const { QWEN_ADAPTER: a } = adapters();
  for (const refs of [[],[asset(),asset(),asset()]]) invalid(() => a.normalize(input,refs));
  for (const patch of [{mode:'inpaint'},{mode:'t2i'},{style:'styled'},{lora_strength:1},{negative:'blur'},{steps:9},{cfg:4},{shift:5},{model:'base'},{backend:'moss'}]) invalid(() => a.normalize({...input,...patch},[asset()]));
});

test('both adapters reject arbitrary graph/path/model keys and malformed generic values', () => {
  const { K2_ADAPTER: k, QWEN_ADAPTER: q } = adapters();
  for (const [a,assets] of [[k,[]],[q,[asset()]]]) {
    for (const field of ['url','comfyUrl','path','references','graph','workflow','shell','filename_prefix','characters','sampler','scheduler','batch_size','__proto__']) {
      const raw = {...input}; Object.defineProperty(raw, field, {value:'unsafe',enumerable:true}); invalid(() => a.normalize(raw,assets));
    }
    for (const patch of [{request_id:'../x'},{prompt:' '},{seed:Number.MAX_SAFE_INTEGER+1},{seed:-1},{seed:true},{steps:NaN},{checks:[5]},{parent_run_id:'../x'}]) invalid(() => a.normalize({...input,...patch},assets));
    const p = a.normalize(input,assets); invalid(() => a.compile(p,'../x',assets.length?[upload(1)]:[]));
  }
});

test('compile revalidates effective fields and never accepts arbitrary uploaded paths', () => {
  const { K2_ADAPTER:k, QWEN_ADAPTER:q } = adapters();
  const kp=k.normalize(input,[]), qp=q.normalize(input,[asset()]);
  for (const patch of [{backend:'moss'},{scheduler:'simple'},{model:'bad'},{cfg:7},{reference_count:0},{height:9000},{graph:{}}]) invalid(()=>q.compile({...qp,...patch},id,[upload(1)]));
  for (const bad of [{...upload(1),name:'../../secret.png'},{...upload(1),type:'output'},{...upload(1),subfolder:'other'},{...upload(1),name:upload(1).name.replace(id,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')}]) invalid(()=>q.compile(qp,id,[bad]));
  invalid(()=>k.compile({...kp,sampler:'er_sde'},id,[]));
  invalid(()=>k.compile(kp,id,[upload(1)]));
});

test('compilation clones templates and does not contaminate following runs', () => {
  const { K2_ADAPTER:k,QWEN_ADAPTER:q }=adapters();
  for (const [a,assets,uploads] of [[k,[],[]],[q,[asset()],[upload(1)]]]) {
    const p=a.normalize(input,assets);const first=a.compile(p,id,uploads);first.graph['1'].inputs.unet_name='evil';
    const next=a.compile(p,id,uploads);assert.notEqual(next.graph['1'].inputs.unet_name,'evil');assert.equal(p.prompt,input.prompt);
  }
});

test('catalog reports only supported modes, truthful none-only styles and backend-specific bounds', () => {
  const { BACKEND_CATALOG:c,K2_ADAPTER:k,QWEN_ADAPTER:q }=adapters();
  assert.deepEqual(c.map(x=>x.id),['k2','qwen']);
  assert.deepEqual(c[0].modes,['t2i']); assert.deepEqual(c[1].modes,['edit']);
  assert.equal(c[0].defaults.mode,'t2i'); assert.equal(c[1].defaults.mode,'edit');
  assert.equal(c[0].defaults.style,'none'); assert.equal(c[0].defaults.lora_strength,0);
  assert.equal(c[1].defaults.style,'none');
  assert.deepEqual(c[0].styles,[{id:'none',trigger:'',strength:0}]);
  assert.deepEqual(c[1].styles,[{id:'none',trigger:'',strength:0}]);
  assert.equal(c[1].defaults.scheduler,'manual_sigmas');
  assert(k.maxPixels>=2560*1440&&k.maxPixels<=4500000);assert(q.maxPixels>=1696*2528&&q.maxPixels<=4500000);
});
