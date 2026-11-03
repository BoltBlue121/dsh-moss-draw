import path from 'node:path';
import {mkdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,randomBytes} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {fault,strictObject,text,number,strings,runId,STYLES,parseLoras} from './catalog.mjs';
import {DEFAULT_CAMERA,validateCamera,validateBody} from './workbench-camera.mjs';

const CONTENT_KEYS=['title','canvas','references','regions','prompt','qwen_full_prompt','camera'];
const PATCH_KEYS=['title','prompt','camera','qwen_full_prompt','regions'];
const REGION_KEYS=['id','box','reference_index','prompt','style','lora_strength','loras','seed','context_px','feather_px','qwen_prompt','steps','cfg','body','group','locked'];
const pick=(object,key,fallback)=>Object.hasOwn(object,key)?object[key]:fallback;
const clone=value=>structuredClone(value);
const now=()=>new Date().toISOString();
const invalid=message=>{throw fault('INVALID_INPUT',message);};
const conflict=()=>{throw fault('WORKBENCH_CONFLICT','Document or proposal revision changed; reload before applying.');};
const revision=value=>number(value,'revision',1,Number.MAX_SAFE_INTEGER-1,true);
function bounded(value,max=262144){if(Buffer.byteLength(JSON.stringify(value),'utf8')>max)invalid('Workbench value exceeds the size limit.');return value;}
function boolean(value,name){if(typeof value!=='boolean')invalid(`Invalid ${name}.`);return value;}
function normalizeContent(input,previous){
  strictObject(input,CONTENT_KEYS);
  strictObject(input.canvas,['width','height','reference']);
  const width=number(input.canvas.width,'canvas width',1,4096,true),height=number(input.canvas.height,'canvas height',1,4096,true);
  if(width*height>4500000)invalid('Canvas exceeds 4.5 MP.');
  if(!Array.isArray(input.references)||input.references.length<2||input.references.length>4)invalid('Use two to four references including the canvas.');
  const references=Array.from(input.references,r=>text(r,'reference',4096,true));
  const reference=text(input.canvas.reference,'canvas reference',4096,true);
  if(reference!==references[0])invalid('Canvas reference must equal references[0].');
  if(!Array.isArray(input.regions)||input.regions.length<1||input.regions.length>4)invalid('Use one to four regions.');
  const ids=new Set();
  const regions=Array.from(input.regions,r=>{
    strictObject(r,REGION_KEYS);
    const id=text(r.id,'region id',40,true);
    if(!/^[A-Za-z0-9_-]+$/.test(id)||ids.has(id))invalid('Region IDs must be unique identifiers.');ids.add(id);
    if(!Array.isArray(r.box)||r.box.length!==4||Array.from(r.box).some(v=>!Number.isSafeInteger(v)))invalid('Region box must contain four integer coordinates.');
    const [l,t,rr,b]=r.box;if(l<0||t<0||rr>width||b>height||l>=rr||t>=b)invalid('Stored execution box must remain inside the canvas.');
    const style=pick(r,'style','fymrie');if(typeof style!=='string'||!Object.hasOwn(STYLES,style))invalid('Unknown region style.');
    const strength=number(pick(r,'lora_strength',style==='none'?0:1),'LoRA strength',0,2);
    if(style==='none'&&strength!==0)invalid('Style none requires zero strength.');
    const loras=parseLoras(r.loras);
    const old=previous?.regions.find(v=>v.id===id);
    return {
      id,box:[...r.box],reference_index:number(r.reference_index,'reference index',1,references.length-1,true),prompt:text(r.prompt,'region prompt',10000,true),
      style,lora_strength:strength,...(loras.length?{loras}:{}),seed:number(pick(r,'seed',old?.seed??randomBytes(6).readUIntBE(0,6)),'seed',0,Number.MAX_SAFE_INTEGER,true),
      context_px:number(pick(r,'context_px',64),'context pixels',0,512,true),feather_px:number(pick(r,'feather_px',8),'feather pixels',0,128,true),
      qwen_prompt:text(pick(r,'qwen_prompt',''),'region Qwen prompt',10000),steps:number(pick(r,'steps',30),'steps',1,100,true),cfg:number(pick(r,'cfg',4),'cfg',0,20),
      group:text(pick(r,'group',''),'region group',80),locked:boolean(pick(r,'locked',false),'locked'),
      ...(Object.hasOwn(r,'body')?{body:validateBody(r.body)}:{}),
    };
  });
  return bounded({title:text(input.title,'title',200,true),canvas:{width,height,reference},references,regions,
    prompt:text(input.prompt,'prompt',12000,true),qwen_full_prompt:text(pick(input,'qwen_full_prompt',''),'full Qwen prompt',10000),
    camera:validateCamera(pick(input,'camera',DEFAULT_CAMERA))});
}
function patchContent(current,patch){
  strictObject(patch,PATCH_KEYS);if(!Object.keys(patch).length)invalid('Patch cannot be empty.');
  // Camera patches are field-level; omitted fields retain the current lens.
  const merged={...current,...patch};
  if(Object.hasOwn(patch,'camera')){strictObject(patch.camera,Object.keys(DEFAULT_CAMERA));merged.camera={...current.camera,...patch.camera};}
  return normalizeContent(merged,current);
}
function lockedRegionsUnchanged(before,after){
  for(let i=0;i<before.regions.length;i++){
    const region=before.regions[i];if(!region.locked)continue;
    if(!isDeepStrictEqual(region,after.regions[i]))throw fault('WORKBENCH_LOCKED','Unlock the existing region with an explicit manual update before proposing changes.');
  }
}
function parse(value){try{return JSON.parse(value);}catch{throw fault('STORE_CORRUPT','Workbench record cannot be read.');}}

export function createWorkbenchStore({dataRoot}){
  if(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot))throw fault('INVALID_CONFIG','Workbench dataRoot must be a trusted absolute path.');
  const directory=path.join(path.resolve(dataRoot),'workbench'),filename=path.join(directory,'documents.sqlite');
  // Every operation closes its own connection. The transaction body is entirely
  // synchronous: no await, network or asset reads can hold the SQLite writer.
  function transaction(write,operation){
    mkdirSync(directory,{recursive:true});const db=new DatabaseSync(filename);let began=false;
    try{
      db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
      db.exec(`CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, content TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS revisions(document_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, operation TEXT NOT NULL, content TEXT NOT NULL, PRIMARY KEY(document_id,revision), FOREIGN KEY(document_id) REFERENCES documents(id));
        CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, document_id TEXT NOT NULL, created_at TEXT NOT NULL, value TEXT NOT NULL, FOREIGN KEY(document_id) REFERENCES documents(id));
        CREATE INDEX IF NOT EXISTS proposals_document ON proposals(document_id,created_at);`);
      db.exec(write?'BEGIN IMMEDIATE':'BEGIN');began=true;
      const result=operation(db);db.exec('COMMIT');began=false;return clone(result);
    }catch(e){if(/locked|busy/i.test(e.message)&&e.code?.startsWith('ERR_SQLITE'))throw fault('WORKBENCH_BUSY','Another process is saving the document; reload and retry.');throw e;}
    finally{if(began)db.exec('ROLLBACK');db.close();}
  }
  function row(db,id){const r=db.prepare('SELECT * FROM documents WHERE id=?').get(id);if(!r)throw fault('WORKBENCH_NOT_FOUND','Workbench document not found.');return r;}
  function checked(db,input){const r=row(db,runId(input.document_id));if(r.revision!==revision(input.expected_revision))conflict();return r;}
  function document(db,r){return{document_id:r.id,revision:r.revision,...parse(r.content),created_at:r.created_at,updated_at:r.updated_at,
    proposals:db.prepare("SELECT value FROM proposals WHERE document_id=? ORDER BY json_extract(value,'$.submitted_revision') DESC LIMIT 20").all(r.id).map(p=>parse(p.value)).reverse()};}
  function snapshot(db,r,content,operation){
    const next=r.revision+1,at=now(),encoded=JSON.stringify(bounded(content));
    const change=db.prepare('UPDATE documents SET revision=?,updated_at=?,content=? WHERE id=? AND revision=?').run(next,at,encoded,r.id,r.revision);if(change.changes!==1)conflict();
    db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?)').run(r.id,next,at,operation,encoded);
    return row(db,r.id);
  }
  return Object.freeze({
    async create(input){const content=normalizeContent(input),id=randomUUID(),at=now();return transaction(true,db=>{
      const encoded=JSON.stringify(content);db.prepare('INSERT INTO documents VALUES(?,?,?,?,?)').run(id,1,at,at,encoded);db.prepare('INSERT INTO revisions VALUES(?,?,?,?,?)').run(id,1,at,'create',encoded);return document(db,row(db,id));});},
    async get(input){strictObject(input,['document_id']);const id=runId(input.document_id);return transaction(false,db=>document(db,row(db,id)));},
    async list(input={}){strictObject(input,['limit']);const limit=number(pick(input,'limit',20),'limit',1,100,true);return transaction(false,db=>({documents:db.prepare('SELECT * FROM documents ORDER BY updated_at DESC,id DESC LIMIT ?').all(limit).map(r=>{
      const c=parse(r.content);return{document_id:r.id,revision:r.revision,title:c.title,canvas:c.canvas,created_at:r.created_at,updated_at:r.updated_at,region_count:c.regions.length,
        pending_proposals:db.prepare("SELECT COUNT(*) AS count FROM proposals WHERE document_id=? AND json_extract(value,'$.status')='pending'").get(r.id).count};})}));},
    async update(input){strictObject(input,['document_id','expected_revision','patch']);runId(input.document_id);revision(input.expected_revision);return transaction(true,db=>{
      const r=checked(db,input),content=patchContent(parse(r.content),input.patch);return document(db,snapshot(db,r,content,'update'));});},
    async propose(input){strictObject(input,['document_id','expected_revision','patch','summary']);runId(input.document_id);revision(input.expected_revision);const summary=text(input.summary,'proposal summary',1000,true);return transaction(true,db=>{
      const r=checked(db,input),base=parse(r.content),proposed=patchContent(base,input.patch);lockedRegionsUnchanged(base,proposed);
      const id=randomUUID(),created_at=now();const patch=Object.fromEntries(Object.keys(input.patch).map(k=>[k,proposed[k]]));
      const value={id,proposal_id:id,base_revision:r.revision,submitted_revision:r.revision+1,summary,status:'pending',patch,base,proposed,accepted:[],created_at};
      const next=snapshot(db,r,base,'propose');db.prepare('INSERT INTO proposals VALUES(?,?,?,?)').run(id,r.id,created_at,JSON.stringify(value));return document(db,next);});},
    async resolve(input){strictObject(input,['document_id','expected_revision','proposal_id','accept','reject']);runId(input.document_id);runId(input.proposal_id);revision(input.expected_revision);
      const accept=strings(input.accept,'accept selectors',9,80);if(new Set(accept).size!==accept.length)invalid('Duplicate acceptance selector.');
      const reject=Object.hasOwn(input,'reject')?boolean(input.reject,'reject'):false;if((reject&&accept.length)||(!reject&&!accept.length))invalid('Choose acceptance selectors or reject.');
      return transaction(true,db=>{
        const r=checked(db,input),found=db.prepare('SELECT value FROM proposals WHERE id=? AND document_id=?').get(input.proposal_id,r.id);if(!found)throw fault('WORKBENCH_NOT_FOUND','Proposal not found.');
        const p=parse(found.value);if(p.status!=='pending'||p.submitted_revision!==r.revision)conflict();
        let content=parse(r.content);
        if(!reject){
          if(accept.includes('regions')&&accept.some(s=>s.startsWith('region:')))invalid('Do not combine region and regions selectors.');
          const patch={};let regions=clone(content.regions);
          for(const selector of accept){
            if(PATCH_KEYS.includes(selector)){if(!Object.hasOwn(p.patch,selector))invalid('Selector was not proposed.');patch[selector]=p.proposed[selector];continue;}
            if(!selector.startsWith('region:')||!Object.hasOwn(p.patch,'regions'))invalid('Unknown acceptance selector.');
            const id=selector.slice(7),before=p.base.regions.find(x=>x.id===id),after=p.proposed.regions.find(x=>x.id===id);
            if((!before&&!after)||isDeepStrictEqual(before,after))invalid('Region was not changed by the proposal.');
            const index=regions.findIndex(x=>x.id===id);if(!after){if(index>=0)regions.splice(index,1);}else if(index<0)regions.push(after);else regions[index]=after;
          }
          if(accept.some(s=>s.startsWith('region:')))patch.regions=regions;
          content=patchContent(content,patch);lockedRegionsUnchanged(parse(r.content),content);
        }
        const next=snapshot(db,r,content,reject?'reject':'accept');p.status=reject?'rejected':'accepted';p.accepted=[...accept];p.resolved_at=now();p.resolved_revision=next.revision;
        db.prepare('UPDATE proposals SET value=? WHERE id=?').run(JSON.stringify(p),p.proposal_id);return document(db,next);
      });},
    async history(input){strictObject(input,['document_id','limit']);const id=runId(input.document_id),limit=number(pick(input,'limit',20),'limit',1,100,true);return transaction(false,db=>{
      row(db,id);return{document_id:id,revisions:db.prepare('SELECT revision,created_at,operation FROM revisions WHERE document_id=? ORDER BY revision DESC LIMIT ?').all(id,limit)};});},
    async restore(input){strictObject(input,['document_id','expected_revision','revision']);runId(input.document_id);revision(input.expected_revision);revision(input.revision);return transaction(true,db=>{
      const r=checked(db,input),old=db.prepare('SELECT content FROM revisions WHERE document_id=? AND revision=?').get(r.id,input.revision);if(!old)throw fault('WORKBENCH_NOT_FOUND','Revision not found.');
      // Only content is restored. Proposal decisions are never rewound/reactivated.
      return document(db,snapshot(db,r,parse(old.content),'restore'));
    });},
  });
}
