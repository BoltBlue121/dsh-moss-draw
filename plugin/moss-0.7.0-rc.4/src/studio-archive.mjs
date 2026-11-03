import path from 'node:path';
import {existsSync,mkdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {validateStudioDoc} from './studio-domain.mjs';

const fault=(code,message)=>Object.assign(new Error(message),{code});
const invalid=message=>{throw fault('STUDIO_ARCHIVE_INPUT',message);};
const conflict=()=>{throw fault('STUDIO_ARCHIVE_CONFLICT','Archive revision changed; reload before applying.');};
const notFound=()=>{throw fault('STUDIO_ARCHIVE_NOT_FOUND','Archive not found.');};
function request(value,keys,required=keys){
 if(!value||typeof value!=='object'||Array.isArray(value)||![Object.prototype,null].includes(Object.getPrototypeOf(value)))invalid('Expected an object.');
 for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(typeof key!=='string'||!keys.includes(key)||!d.enumerable||!Object.hasOwn(d,'value'))invalid('Unknown or non-JSON field.');}
 if(required.some(key=>!Object.hasOwn(value,key)))invalid('Required field missing.');
}
function string(value,max,blank=true){if(typeof value!=='string'||value.length>max||!blank&&!value.trim())invalid('Invalid text.');return value;}
function id(value){if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))invalid('Invalid archive UUID.');return value.toLowerCase();}
function integer(value,min,max){if(!Number.isSafeInteger(value)||value<min||value>max)invalid('Invalid integer.');return value;}
function full(row){return{archive_id:row.archive_id,title:row.title,category:row.category,revision:row.revision,doc:JSON.parse(row.doc),prompt:row.prompt,created_at:row.created_at,updated_at:row.updated_at};}
const schema=`CREATE TABLE IF NOT EXISTS archives(archive_id TEXT PRIMARY KEY,title TEXT NOT NULL,category TEXT NOT NULL,revision INTEGER NOT NULL,kind TEXT NOT NULL,doc TEXT NOT NULL,prompt TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);CREATE INDEX IF NOT EXISTS archive_recency ON archives(updated_at DESC);`;

export function createStudioArchive({dataRoot}){
 if(typeof dataRoot!=='string'||!path.isAbsolute(dataRoot)||dataRoot.includes('\0'))invalid('Trusted absolute data root required.');
 const folder=path.join(dataRoot,'studio'),filename=path.join(folder,'archive.sqlite');
 function transaction(write,work){if(!write&&!existsSync(filename))return work(null);if(write)mkdirSync(folder,{recursive:true});const db=new DatabaseSync(filename,{readOnly:!write});let began=false;try{db.exec('PRAGMA busy_timeout=5000;');if(write)db.exec('PRAGMA synchronous=FULL;');db.exec(write?'BEGIN IMMEDIATE':'BEGIN');began=true;if(write)db.exec(schema);const value=work(db);db.exec('COMMIT');began=false;return structuredClone(value);}catch(error){if(error.code?.startsWith('ERR_SQLITE')&&/busy|locked/i.test(error.message))conflict();throw error;}finally{try{if(began)db.exec('ROLLBACK');}finally{db.close();}}}
 function row(db,key,expected){const value=db?.prepare('SELECT * FROM archives WHERE archive_id=? AND deleted=0').get(key);if(!value)notFound();if(expected!==undefined&&value.revision!==expected)conflict();return value;}
 return Object.freeze({
  async list(input={}){request(input,['query','category','offset','limit'],[]);const query=string(input.query??'',200),category=input.category===undefined?undefined:string(input.category,80),offset=integer(input.offset??0,0,1000000),limit=integer(input.limit??50,1,100);
   return transaction(false,db=>{if(!db)return{items:[],total:0,next_offset:null};const params=[],filters=['deleted=0'];if(query){filters.push('(instr(lower(title),lower(?))>0 OR instr(lower(category),lower(?))>0)');params.push(query,query);}if(category!==undefined){filters.push('category=?');params.push(category);}const where=filters.join(' AND '),total=db.prepare(`SELECT COUNT(*) AS n FROM archives WHERE ${where}`).get(...params).n;const items=db.prepare(`SELECT archive_id,title,category,revision,kind,created_at,updated_at FROM archives WHERE ${where} ORDER BY updated_at DESC,rowid DESC LIMIT ? OFFSET ?`).all(...params,limit,offset);return{items,total,next_offset:offset+limit<total?offset+limit:null};});
  },
  async add(input){request(input,['title','category','doc','prompt']);const title=string(input.title,200,false),category=string(input.category,80),doc=validateStudioDoc(input.doc),prompt=string(input.prompt,524288);if(Buffer.byteLength(JSON.stringify({title,category,doc,prompt}),'utf8')>1572864)invalid('Archive exceeds the byte limit.');
   return transaction(true,db=>{if(db.prepare('SELECT COUNT(*) AS n FROM archives WHERE deleted=0').get().n>=1000)invalid('Archive limit reached (1000).');const key=randomUUID(),at=new Date().toISOString();db.prepare('INSERT INTO archives VALUES(?,?,?,?,?,?,?,?,?,0)').run(key,title,category,1,doc.kind,JSON.stringify(doc),prompt,at,at);return full(row(db,key));});
  },
  async get(input){request(input,['archive_id']);const key=id(input.archive_id);return transaction(false,db=>full(row(db,key)));},
  async update(input){request(input,['archive_id','expected_revision','title','category'],['archive_id','expected_revision']);const key=id(input.archive_id),expected=integer(input.expected_revision,1,Number.MAX_SAFE_INTEGER-1);if(!Object.hasOwn(input,'title')&&!Object.hasOwn(input,'category'))invalid('No metadata change supplied.');const title=input.title===undefined?undefined:string(input.title,200,false),category=input.category===undefined?undefined:string(input.category,80);
   return transaction(true,db=>{const prior=row(db,key,expected);db.prepare('UPDATE archives SET title=?,category=?,revision=?,updated_at=? WHERE archive_id=?').run(title??prior.title,category??prior.category,expected+1,new Date().toISOString(),key);return full(row(db,key));});
  },
  async delete(input){request(input,['archive_id','expected_revision']);const key=id(input.archive_id),expected=integer(input.expected_revision,1,Number.MAX_SAFE_INTEGER-1);return transaction(true,db=>{row(db,key,expected);db.prepare('UPDATE archives SET deleted=1,revision=?,updated_at=? WHERE archive_id=?').run(expected+1,new Date().toISOString(),key);return{deleted:true,archive_id:key,revision:expected+1};});},
 });
}
