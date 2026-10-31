// Browser-safe, shared by the UI and both server-side Agent write paths.
const fail=(code,message)=>{throw Object.assign(new TypeError(message),{code});};
const invalid=message=>fail('STUDIO_INVALID_INPUT',message);
export function stableStudioValue(value){
 if(Array.isArray(value))return value.map(stableStudioValue);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stableStudioValue(value[k])]));
 return value;
}
export const equalStudioValue=(a,b)=>JSON.stringify(stableStudioValue(a))===JSON.stringify(stableStudioValue(b));
export function validateStudioEditPolicy(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||!['full','descriptions'].includes(value.mode))invalid('Invalid edit policy mode.');
 const fields=value.mode==='full'?['mode']:['mode','item_ids','summary','caption','text'];
 if(Reflect.ownKeys(value).some(k=>typeof k!=='string'||!fields.includes(k))||fields.some(k=>!Object.hasOwn(value,k)))invalid('Unknown or missing edit policy field.');
 if(value.mode==='full')return{mode:'full'};
 for(const k of ['summary','caption','text'])if(typeof value[k]!=='boolean')invalid('Edit policy flags must be boolean.');
 const ids=value.item_ids;
 if(ids!==null&&(!Array.isArray(ids)||ids.length>128||ids.some(id=>typeof id!=='string'||!id.trim()||id.length>80||['__proto__','constructor','prototype'].includes(id))||new Set(ids).size!==ids.length))invalid('Invalid edit policy item IDs.');
 return structuredClone(value);
}
export function assertStudioEditPolicy(before,after,value){
 const policy=validateStudioEditPolicy(value??{mode:'full'});if(policy.mode==='full')return;
 const strip=doc=>{const out=structuredClone(doc);if(doc.kind==='layout'&&policy.summary)delete out.layout.summary.caption;if(doc.kind==='caption'&&policy.caption)delete out.caption.caption;
  for(const item of out.layout.items)if(doc.kind==='layout'&&(policy.item_ids===null||policy.item_ids.includes(item.id))){delete item.caption;if(policy.text)delete item.text;}return out;};
 if(!equalStudioValue(strip(before),strip(after)))fail('STUDIO_EDIT_SCOPE','Only the permitted description fields may change; preserve geometry, camera, identity, order, shared inputs and nonselected items.');
}
