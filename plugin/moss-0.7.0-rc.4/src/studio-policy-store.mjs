import{validateStudioEditPolicy,assertStudioEditPolicy,equalStudioValue}from'./studio-edit-policy.mjs';
import{requireStudioHuman}from'./studio-agent-state.mjs';
import{studioGeometryKey}from'./studio-scene.mjs';
export const STUDIO_POLICY_SCHEMA=`CREATE TABLE IF NOT EXISTS studio_page_policy(page_id TEXT PRIMARY KEY REFERENCES studio_pages(page_id),value TEXT NOT NULL);`;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export function readStudioPolicy(db,pageId){if(!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_page_policy'").get())return{policy:{mode:'full'}};const row=db.prepare('SELECT value FROM studio_page_policy WHERE page_id=?').get(pageId);return row?JSON.parse(row.value):{policy:{mode:'full'}};}
export function studioTextOnlySession(db){if(!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_page_policy'").get())return false;return !!db.prepare("SELECT 1 FROM studio_page_policy q WHERE json_extract(q.value,'$.editing_only')=1 AND q.page_id NOT IN (SELECT page_id FROM studio_deleted_pages) AND q.page_id IN (SELECT page_id FROM studio_pages WHERE series_id NOT IN (SELECT series_id FROM studio_deleted_series)) LIMIT 1").get();}
export function setStudioTextOnly(db,key,enabled){saveStudioPolicy(db,key,{...readStudioPolicy(db,key),editing_only:enabled});}
export function saveStudioPolicy(db,pageId,value){db.prepare('INSERT INTO studio_page_policy VALUES(?,?) ON CONFLICT(page_id) DO UPDATE SET value=excluded.value').run(pageId,JSON.stringify(value));}
export function assertStudioPagePolicy(db,current,doc,title=current.title){const {policy}=readStudioPolicy(db,current.page_id);assertStudioEditPolicy(JSON.parse(current.doc),doc,policy);if(policy.mode==='descriptions'&&title!==current.title)fail('STUDIO_EDIT_SCOPE','Description-only editing cannot rename the page.');}
export function studioDescriptionsStatus(db,pageId,doc){const value=readStudioPolicy(db,pageId);return !value.geometry_key?'unchecked':value.geometry_key===studioGeometryKey(doc)?'current':'stale';}
export function acknowledgeStudioDescriptions(db,pageId,doc){saveStudioPolicy(db,pageId,{...readStudioPolicy(db,pageId),geometry_key:studioGeometryKey(doc)});}
export function checkStudioDescriptionRefresh(before,after){
 if(studioGeometryKey(before)!==studioGeometryKey(after))fail('STUDIO_DESCRIPTION_CHECK','Save geometry first: call studioAgentUpdate with new geometry and captions WITHOUT descriptions_checked; re-read the page revision, then call studioAgentUpdate with descriptions_checked:true and only caption/summary text changes. Do not change geometry in that second call.');
 const captions=doc=>doc.kind==='caption'?[doc.caption.caption]:[doc.layout.summary.caption,...doc.layout.items.map(i=>i.caption)];
 if(equalStudioValue(captions(before),captions(after)))fail('STUDIO_DESCRIPTION_CHECK','A description refresh must actually update text; human confirmation is a separate UI action.');
}
export function createStudioPolicyMethods({transaction,checked,page,snapshot,stalePending,request,id,revision}){
 return{
  async confirmDescriptions(input){request(input,['page_id','expected_revision','lease_token'],['page_id','expected_revision']);const key=id(input.page_id),expected=revision(input.expected_revision);return transaction(true,db=>{const current=checked(db,key,expected);requireStudioHuman(db,key,input.lease_token);const doc=JSON.parse(current.doc);acknowledgeStudioDescriptions(db,key,doc);const next=snapshot(db,current,current.title,doc,'human-confirm-descriptions');stalePending(db,next,next.updated_at);return page(db,next);});},
  async setEditPolicy(input){request(input,['page_id','expected_revision','policy','lease_token','editing_only'],['page_id','expected_revision','policy']);const key=id(input.page_id),expected=revision(input.expected_revision),policy=validateStudioEditPolicy(input.policy);
   return transaction(true,db=>{const current=checked(db,key,expected);requireStudioHuman(db,key,input.lease_token);const doc=JSON.parse(current.doc),ids=new Set(doc.layout.items.map(i=>i.id));if(policy.mode==='descriptions'&&policy.item_ids?.some(k=>!ids.has(k)))fail('STUDIO_INVALID_INPUT','Selected edit-policy item is not on this page.');const previous=readStudioPolicy(db,key);if(input.editing_only!==undefined&&typeof input.editing_only!=='boolean')fail('STUDIO_INVALID_INPUT','editing_only must be boolean.');const editing_only=input.editing_only??(policy.mode==='full'?false:previous.editing_only??false);if(equalStudioValue(previous.policy,policy)&&!!previous.editing_only===editing_only)return page(db,current);saveStudioPolicy(db,key,{...previous,policy,editing_only});const next=snapshot(db,current,current.title,doc,'human-edit-policy');stalePending(db,next,next.updated_at);return page(db,next);});
  },
 };
}
