import { createService, catalog as mossCatalog } from './core.mjs';
import { K2_ADAPTER, QWEN_ADAPTER, BACKEND_CATALOG } from './backends.mjs';
import { createRegionService } from './regions.mjs';
import { fault, strictObject, number } from './catalog.mjs';
import { NATIVE_EDIT_ADAPTER, NATIVE_EDIT_CATALOG } from './native-edit.mjs';
import { hash } from './store.mjs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Child ledger is shared by the three fixed compilers. Region parents own a
// separate ledger so advancing a parent cannot deadlock its child store lock.
export function createDrawingService(config) {
  let regions;
  const editEngine=config.editEngine??'native';
  if(!['native','legacy'].includes(editEngine))throw fault('INVALID_CONFIG','Unknown trusted edit engine.');
  const childConfig={...config,externalParentExists:id=>regions.has(id)};
  const services = {
    moss: createService(childConfig),
    k2: createService({ ...childConfig, adapter: K2_ADAPTER }),
    qwen: createService({ ...childConfig, adapter: QWEN_ADAPTER }),
  };
  const nativeEdit=createService({...childConfig,adapter:NATIVE_EDIT_ADAPTER});
  async function originalEditEngine(requestId,fallback){
    if(typeof requestId!=='string'||!requestId||requestId.length>128)return fallback;
    try{const claim=JSON.parse(await readFile(path.join(config.dataRoot,'requests',hash(requestId)+'.json'),'utf8'));
      if(claim.request_id!==requestId||!claim.params)throw fault('STORE_CORRUPT','Invalid request claim.');
      return claim.params.model_variant==='native-sft-edit'?'native':'legacy';
    }catch(e){if(e.code==='ENOENT')return fallback;if(e.code==='STORE_CORRUPT')throw e;throw fault('STORE_CORRUPT','Unreadable request claim.');}
  }
  async function generateChild(input,assets=[],options={}) {
    if (!input || typeof input!=='object' || Array.isArray(input)) throw fault('INVALID_INPUT','Expected drawing parameters.');
    const {backend='moss', ...params}=input;
    if (typeof backend!=='string' || !Object.hasOwn(services,backend)) throw fault('INVALID_INPUT','ART_BACKEND: choose moss, k2 or qwen');
    if(backend==='moss'&&params.mode==='edit'){
      const selected=await originalEditEngine(params.request_id,options.editEngine??editEngine);options.signal?.throwIfAborted();
      return (selected==='native'?nativeEdit:services.moss).generate(params,assets,options);
    }
    return services[backend].generate(params,assets,options);
  }
  regions=createRegionService({dataRoot:config.dataRoot,editEngine,childService:{generate:generateChild,run:(args,options)=>services.moss.run(args,options)}});
  const catalog = () => ({schemaVersion:1, default_backend:'moss', backends:[
    {id:'moss', ...mossCatalog(),modes:mossCatalog().modes.map(m=>m.id==='edit'&&editEngine==='native'?{...NATIVE_EDIT_CATALOG,style_gpu_validated:false,quality_note:'Single-reference native edit is the tested path; multi-reference identity/layout remains experimental.'}:m.id==='regions'?{...m,edit_engine:editEngine,quality_note:'Multi-reference regions can duplicate subjects or leave seams; inspect every result.'}:m)}, ...structuredClone(BACKEND_CATALOG),
  ]});
  return Object.freeze({
    catalog,
    async context(input={}, {signal}={}) {
      signal?.throwIfAborted();strictObject(input,['limit','run_id']);
      if(input.run_id!==undefined) {
        const selected=await regions.has(input.run_id)?regions:services.moss;
        const result=await selected.context(input);signal?.throwIfAborted();return {...result,catalog:catalog()};
      }
      const limit=number(input.limit??3,'limit',1,3,true);
      const [parents,children]=await Promise.all([regions.context({limit}),services.moss.context({limit})]);
      signal?.throwIfAborted();
      const runs=[...parents.runs,...children.runs].sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.run_id.localeCompare(a.run_id)).slice(0,limit);
      return {schemaVersion:1,catalog:catalog(),runs};
    },
    async generate(input,assets=[],{signal}={}) {
      signal?.throwIfAborted();
      if(input?.mode==='regions') {
        const {backend='moss',...params}=input;
        if(backend!=='moss')throw fault('INVALID_INPUT','Regions use MOSS with optional Qwen stages.');
        return regions.generate(params,assets,{signal});
      }
      return generateChild(input,assets,{signal});
    },
    async run(input, options) {return (await regions.has(input?.run_id)?regions:services.moss).run(input,options);},
    async review(input) {return (await regions.has(input?.run_id)?regions:services.moss).review(input);},
  });
}
