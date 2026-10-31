import{sharedSnapshot,resolveStudioSharedDoc}from'./studio-shared.mjs';
import{equalStudioValue}from'./studio-edit-policy.mjs';
import{requireStudioHuman}from'./studio-agent-state.mjs';
export const STUDIO_SERIES_PROFILE_SCHEMA=`CREATE TABLE IF NOT EXISTS studio_series_profiles(series_id TEXT PRIMARY KEY REFERENCES studio_series(series_id),value TEXT NOT NULL);`;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export function assertStudioSharedUnchanged(before,after){if(!equalStudioValue(before.shared,after.shared))fail('STUDIO_SHARED_PROTECTED','Shared inputs are pinned by the human; change their page snapshot in the workbench first.');}
export function assertStudioLockedShared(before,after){
 if(!before.layout.items.some(i=>i.locked))return;
 const a=resolveStudioSharedDoc({...before,kind:'layout'}),b=resolveStudioSharedDoc({...after,kind:'layout'}),byId=new Map(b.layout.items.map(i=>[i.id,i]));
 if((before.shared?.style??'')!==(after.shared?.style??''))fail('STUDIO_LOCKED','Unlock affected objects before changing their shared style.');
 for(const item of a.layout.items)if(item.locked&&!equalStudioValue(item,byId.get(item.id)))fail('STUDIO_LOCKED','A shared update would change a locked object. Unlock it explicitly first.');
}
export function createStudioSeriesProfileMethods({transaction,row,seriesRow,checked,page,snapshot,stalePending,request,id,revision,validateDoc}){
 const get=(db,key)=>{seriesRow(db,key);if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='studio_series_profiles'").get())return{series_id:key,revision:0,style:'',cast:[]};const entry=db.prepare('SELECT value FROM studio_series_profiles WHERE series_id=?').get(key);return entry?JSON.parse(entry.value):{series_id:key,revision:0,style:'',cast:[]};};
 return{
  async getSeriesProfile(input){request(input,['series_id']);const key=id(input.series_id);return transaction(false,db=>get(db,key));},
  async updateSeriesProfile(input){request(input,['series_id','expected_revision','style','cast']);const key=id(input.series_id),expected=input.expected_revision;if(!Number.isSafeInteger(expected)||expected<0||expected>=Number.MAX_SAFE_INTEGER-1)fail('STUDIO_INVALID_INPUT','Invalid profile revision.');const{bindings,caption_cast_ids,...profile}=sharedSnapshot({series_id:key,revision:expected+1,style:input.style,cast:input.cast});
   return transaction(true,db=>{if(get(db,key).revision!==expected)fail('STUDIO_CONFLICT','Series profile changed; reload first.');db.prepare('INSERT INTO studio_series_profiles VALUES(?,?) ON CONFLICT(series_id) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(profile));return profile;});
  },
  async applySeriesProfile(input){request(input,['page_id','expected_revision','profile_revision','bindings','caption_cast_ids','lease_token'],['page_id','expected_revision','profile_revision','bindings','caption_cast_ids']);const key=id(input.page_id),expected=revision(input.expected_revision),profileRevision=revision(input.profile_revision);
   return transaction(true,db=>{const current=checked(db,key,expected);requireStudioHuman(db,key,input.lease_token);const profile=get(db,current.series_id);if(profile.revision!==profileRevision)fail('STUDIO_CONFLICT','Series profile changed before applying.');const before=JSON.parse(current.doc),doc=validateDoc({...before,shared:sharedSnapshot(profile,input.bindings,input.caption_cast_ids)});resolveStudioSharedDoc(doc);assertStudioLockedShared(before,doc);const next=snapshot(db,current,current.title,doc,'human-apply-shared');stalePending(db,next,next.updated_at);return page(db,next);});
  },
 };
}
