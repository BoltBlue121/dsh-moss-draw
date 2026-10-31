import path from 'node:path';
import {existsSync, mkdirSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateStudioDoc} from './studio-domain.mjs';
import {STUDIO_TASK_SCHEMA,readStudioTask,publicStudioTask,requireStudioHuman,createStudioTaskMethods} from './studio-agent-state.mjs';
import {STUDIO_PLAN_SCHEMA,createStudioPlanMethods} from './studio-execution.mjs';
import {STUDIO_POLICY_SCHEMA,readStudioPolicy,assertStudioPagePolicy,createStudioPolicyMethods,studioDescriptionsStatus,acknowledgeStudioDescriptions,checkStudioDescriptionRefresh,studioTextOnlySession,setStudioTextOnly} from './studio-policy-store.mjs';
import {STUDIO_SERIES_PROFILE_SCHEMA,createStudioSeriesProfileMethods,assertStudioSharedUnchanged} from './studio-series-profile.mjs';
import {STUDIO_CONSENT_SCHEMA,createStudioConsentMethods,assertStudioConsentGeneration} from './studio-consent-store.mjs';

const REQUEST_BYTES = 512 * 1024 + 16 * 1024;
const LIST_LIMIT = 100;
const PROPOSAL_LIMIT = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = new Map([
  ['kind', ['kind']], ['layout.summary', ['layout', 'summary']],
  ['layout.items', ['layout', 'items']], ['caption', ['caption']],
  ['layout.camera', ['layout', 'camera']],
  ['layout.prompt_options', ['layout', 'prompt_options']], ['layout.perspective', ['layout', 'perspective']],
]);
const now = () => new Date().toISOString();
function fault(code, message) { return Object.assign(new Error(message), {code}); }
function invalid(message) { throw fault('STUDIO_INVALID_INPUT', message); }
function notFound(name) { throw fault('STUDIO_NOT_FOUND', `${name} not found.`); }
function conflict() { throw fault('STUDIO_CONFLICT', 'Page or proposal revision changed; reload before applying.'); }
function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function id(value) {
  if (typeof value !== 'string' || !UUID.test(value)) invalid('Expected a UUID.');
  return value.toLowerCase();
}
function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER) invalid('Revision must be a positive safe integer.');
  return value;
}
function text(value, name, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`Invalid ${name}.`);
  return value;
}

// Check before JSON.stringify: no cycles, getters, exotic objects, sparse arrays,
// nonfinite numbers or toJSON hooks can silently alter a request on persistence.
function boundedJson(value) {
  let nodes = 0, stringBytes = 0;
  const ancestors = new Set();
  function visit(current, depth) {
    if (++nodes > 50000 || depth > 32) invalid('Request JSON is too complex.');
    if (current === null || typeof current === 'boolean') return;
    if (typeof current === 'string') {
      stringBytes += Buffer.byteLength(current, 'utf8');
      if (stringBytes > REQUEST_BYTES) invalid('Request JSON exceeds the size limit.');
      return;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) invalid('Request numbers must be finite.');
      return;
    }
    if (typeof current !== 'object' || (!Array.isArray(current) && !object(current))) invalid('Request must contain JSON values only.');
    if (ancestors.has(current)) invalid('Request JSON cannot contain cycles.');
    ancestors.add(current);
    const keys = Reflect.ownKeys(current);
    if (Array.isArray(current) && (current.length > 50000 || keys.length !== current.length + 1)) invalid('Request arrays must be dense and bounded.');
    for (const key of keys) {
      if (Array.isArray(current) && key === 'length') continue;
      if (typeof key !== 'string') invalid('Request keys must be strings.');
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid('Request fields must be ordinary JSON properties.');
      if (Array.isArray(current) && (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= current.length)) invalid('Request arrays must not have named properties.');
      stringBytes += Buffer.byteLength(key, 'utf8');
      visit(descriptor.value, depth + 1);
    }
    ancestors.delete(current);
  }
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > REQUEST_BYTES) invalid('Request JSON exceeds the size limit.');
}
function request(input, keys, required = keys) {
  if (!object(input)) invalid('Expected a request object.');
  boundedJson(input);
  const unknown=Object.keys(input).filter(key=>!keys.includes(key)),missing=required.filter(key=>!Object.hasOwn(input,key));
  const names=values=>values.slice(0,12).map(key=>String(key).replace(/[^A-Za-z0-9_.-]/g,'?').slice(0,80)).join(', ');
  if(unknown.length||missing.length)invalid(`${unknown.length?`Unsupported fields: ${names(unknown)}. `:''}${missing.length?`Missing fields: ${names(missing)}. `:''}Allowed fields: ${names(keys)}.`);
  return input;
}
const FEATURES = Object.freeze({proposal_order: true, history_preview: true});
function commonOrderChanged(beforeItems, afterItems) {
  const afterIds = new Set(afterItems.map(item => item.id));
  const beforeCommon = beforeItems.filter(item => afterIds.has(item.id)).map(item => item.id);
  const beforeIds = new Set(beforeCommon);
  const afterCommon = afterItems.filter(item => beforeIds.has(item.id)).map(item => item.id);
  return !isDeepStrictEqual(beforeCommon, afterCommon);
}
function lockedUnchanged(before, after) {
  const afterById = new Map(after.layout.items.map((item, index) => [item.id, {item, index}]));
  const commonIndices = before.layout.items
    .map((item, beforeIndex) => ({item, beforeIndex, afterEntry: afterById.get(item.id)}))
    .filter(entry => entry.afterEntry !== undefined);
  for (const item of before.layout.items) {
    if (!item.locked) continue;
    const found = afterById.get(item.id);
    if (!found || !isDeepStrictEqual(item, found.item)) {
      throw fault('STUDIO_LOCKED', 'Unlock an existing item with a manual update before proposing changes to its content or order.');
    }
    for (const other of commonIndices) {
      if (other.item.id === item.id) continue;
      if ((other.beforeIndex < before.layout.items.indexOf(item)) !== (other.afterEntry.index < found.index)) {
        throw fault('STUDIO_LOCKED', 'Unlock an existing item with a manual update before proposing changes to its content or order.');
      }
    }
  }
}
function selectors(input) {
  // Up to 128 removals + 128 additions + non-item/order fields. A full
  // replacement must not be rejected merely for using item-level selectors.
  if (!Array.isArray(input) || input.length > 263 || new Set(input).size !== input.length) invalid('Acceptance selectors must be a bounded unique array.');
  for (const selector of input) {
    if (typeof selector !== 'string' || (selector !== 'layout.canvas' && selector !== 'layout.order' && !FIELDS.has(selector) && (!selector.startsWith('item:') || !selector.slice(5).trim() || selector.slice(5).length > 80))) invalid('Unknown acceptance selector.');
  }
  if (input.includes('layout.items') && input.some(selector => selector === 'layout.order' || selector.startsWith('item:'))) invalid('Do not combine layout.items and item or order selectors.');
  return [...input];
}
function proposalChangeSet(proposal) {
  const before = proposal.base_doc, after = proposal.proposed_doc, changes = new Set();
  if (before.layout.width !== after.layout.width || before.layout.height !== after.layout.height) changes.add('layout.canvas');
  for (const [selector, fields] of FIELDS) {
    if (selector === 'layout.items') continue;
    const leaf = fields.at(-1);
    const b = fields.length === 2 ? before.layout : before;
    const a = fields.length === 2 ? after.layout : after;
    if (!isDeepStrictEqual(b[leaf], a[leaf])) changes.add(selector);
  }
  for (const id of new Set([...before.layout.items, ...after.layout.items].map(item => item.id))) {
    const b = before.layout.items.find(item => item.id === id);
    const a = after.layout.items.find(item => item.id === id);
    if (!isDeepStrictEqual(b, a)) changes.add(`item:${id}`);
  }
  if (commonOrderChanged(before.layout.items, after.layout.items)) changes.add('layout.order');
  return changes;
}
export function studioProposalSelectors(proposal) { return [...proposalChangeSet(proposal)]; }
function resolutionStatus(proposal, accepted) {
  const required = proposalChangeSet(proposal), chosen = new Set(accepted);
  if (chosen.has('layout.items')) {
    for (const key of [...required]) {
      if (key === 'layout.order' || key.startsWith('item:')) required.delete(key);
    }
  }
  for (const key of required) {
    if (!chosen.has(key)) return 'partial';
  }
  return 'accepted';
}
function mergeProposal(current, proposal, accepted) {
  const merged = structuredClone(current);
  const chosen = new Set(accepted);
  const addedIds = new Set();
  let reorder = false;
  for (const selector of accepted) {
    if (selector === 'layout.canvas') {
      const before = proposal.base_doc.layout, after = proposal.proposed_doc.layout;
      if (before.width === after.width && before.height === after.height) invalid('Canvas was not changed by the proposal.');
      merged.layout.width = after.width; merged.layout.height = after.height; continue;
    }
    if (selector === 'layout.order') {
      if (!commonOrderChanged(proposal.base_doc.layout.items, proposal.proposed_doc.layout.items)) invalid('Order was not changed by the proposal.');
      reorder = true; continue;
    }
    const fields = FIELDS.get(selector);
    if (fields) {
      const leaf = fields.at(-1);
      const before = fields.length === 2 ? proposal.base_doc.layout : proposal.base_doc;
      const after = fields.length === 2 ? proposal.proposed_doc.layout : proposal.proposed_doc;
      if (isDeepStrictEqual(before[leaf], after[leaf])) invalid('Selector was not changed by the proposal.');
      const target = fields.length === 2 ? merged.layout : merged;
      if (Object.hasOwn(after, leaf)) target[leaf] = structuredClone(after[leaf]);
      else delete target[leaf];
      continue;
    }
    const itemId = selector.slice(5);
    const before = proposal.base_doc.layout.items.find(item => item.id === itemId);
    const after = proposal.proposed_doc.layout.items.find(item => item.id === itemId);
    if (isDeepStrictEqual(before, after)) invalid('Item was not changed by the proposal.');
    const index = merged.layout.items.findIndex(item => item.id === itemId);
    if (!after) { if (index >= 0) merged.layout.items.splice(index, 1); }
    else if (index < 0) addedIds.add(itemId);
    else merged.layout.items[index] = structuredClone(after);
  }
  if (!chosen.has('layout.items')) {
    const proposedItems = proposal.proposed_doc.layout.items;
    const proposedIds = new Set(proposedItems.map(item => item.id));
    if (reorder) {
      const byId = new Map(merged.layout.items.map(item => [item.id, item]));
      const buckets = new Map([[null, []]]);
      let anchor = null;
      for (const item of merged.layout.items) {
        if (proposedIds.has(item.id)) {
          anchor = item.id;
          if (!buckets.has(anchor)) buckets.set(anchor, []);
        } else {
          buckets.get(anchor).push(item);
        }
      }
      const reordered = [...buckets.get(null)];
      for (const propItem of proposedItems) {
        const kept = byId.get(propItem.id);
        if (!kept) continue;
        reordered.push(kept, ...(buckets.get(propItem.id) ?? []));
      }
      merged.layout.items = reordered;
    }
    if (addedIds.size > 0) {
      const retainedIds = new Set(merged.layout.items.map(item => item.id));
      let anchorId = null;
      for (const propItem of proposedItems) {
        if (retainedIds.has(propItem.id)) {
          anchorId = propItem.id;
        } else if (addedIds.has(propItem.id)) {
          const clone = structuredClone(propItem);
          if (anchorId === null) merged.layout.items.unshift(clone);
          else {
            const at = merged.layout.items.findIndex(item => item.id === anchorId);
            merged.layout.items.splice(at + 1, 0, clone);
          }
          retainedIds.add(propItem.id);
          anchorId = propItem.id;
        }
      }
    }
  }
  const validated = validateStudioDoc(merged);
  lockedUnchanged(current, validated);
  return validated;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS studio_series (
    series_id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS studio_pages (
    page_id TEXT PRIMARY KEY, series_id TEXT NOT NULL REFERENCES studio_series(series_id),
    title TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), kind TEXT NOT NULL,
    doc TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS studio_revisions (
    page_id TEXT NOT NULL REFERENCES studio_pages(page_id), revision INTEGER NOT NULL,
    operation TEXT NOT NULL, created_at TEXT NOT NULL, snapshot TEXT NOT NULL,
    PRIMARY KEY(page_id, revision)
  );
  CREATE TABLE IF NOT EXISTS studio_proposals (
    proposal_id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES studio_pages(page_id),
    submitted_revision INTEGER NOT NULL, status TEXT NOT NULL, value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS studio_deleted_pages (page_id TEXT PRIMARY KEY REFERENCES studio_pages(page_id),deleted_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS studio_deleted_series (series_id TEXT PRIMARY KEY REFERENCES studio_series(series_id),deleted_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS studio_pages_recency ON studio_pages(updated_at DESC);
  CREATE INDEX IF NOT EXISTS studio_proposals_page ON studio_proposals(page_id, submitted_revision DESC);
`;

export function createStudioStore({dataRoot}) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || dataRoot.includes('\0')) invalid('Studio dataRoot must be a trusted absolute path.');
  const directory = path.join(path.resolve(dataRoot), 'studio');
  const filename = path.join(directory, 'editor.sqlite');

  // Each call owns and closes its connection. No await occurs within the
  // transaction: BEGIN IMMEDIATE serializes writers across store instances.
  function transaction(write, operation) {
    if (!write && !existsSync(filename)) return operation(null);
    if (write) mkdirSync(directory, {recursive: true});
    let db, began = false;
    try {
      db = new DatabaseSync(filename, {readOnly: !write});
      db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
      if (write) db.exec('PRAGMA synchronous=FULL;');
      db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
      began = true;
      if (write) db.exec(SCHEMA + STUDIO_TASK_SCHEMA + STUDIO_PLAN_SCHEMA + STUDIO_POLICY_SCHEMA + STUDIO_SERIES_PROFILE_SCHEMA + STUDIO_CONSENT_SCHEMA);
      const result = operation(db);
      db.exec('COMMIT');
      began = false;
      return structuredClone(result);
    } catch (error) {
      if (error.code?.startsWith('ERR_SQLITE') && /locked|busy/i.test(error.message)) conflict();
      throw error;
    } finally {
      try { if (began) db.exec('ROLLBACK'); }
      finally { db?.close(); }
    }
  }
  function existsTable(db,name){return !!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
  function deleted(db,kind,key){const table=kind==='page'?'studio_deleted_pages':'studio_deleted_series',column=kind==='page'?'page_id':'series_id';return existsTable(db,table)&&!!db.prepare(`SELECT 1 FROM ${table} WHERE ${column}=?`).get(key);}
  function seriesRow(db,seriesId){const value=db?.prepare('SELECT * FROM studio_series WHERE series_id=?').get(seriesId);if(!value||deleted(db,'series',seriesId))notFound('Series');return value;}
  function livePages(db){let clause='1';if(existsTable(db,'studio_deleted_pages'))clause+=' AND p.page_id NOT IN (SELECT page_id FROM studio_deleted_pages)';if(existsTable(db,'studio_deleted_series'))clause+=' AND p.series_id NOT IN (SELECT series_id FROM studio_deleted_series)';return clause;}
  function row(db, pageId) {
    const value = db?.prepare('SELECT * FROM studio_pages WHERE page_id=?').get(pageId);
    if (!value||deleted(db,'page',pageId)||deleted(db,'series',value.series_id)) notFound('Page');
    return value;
  }
  function checked(db, pageId, expected) {
    const value = row(db, pageId);
    if (value.revision !== expected) conflict();
    return value;
  }
  function page(db, value) {
    const proposals = db.prepare('SELECT value FROM studio_proposals WHERE page_id=? ORDER BY submitted_revision DESC LIMIT ?')
      .all(value.page_id, PROPOSAL_LIMIT).reverse().map(proposal => JSON.parse(proposal.value));
    return {
      page_id: value.page_id, series_id: value.series_id, title: value.title,
      revision: value.revision, doc: JSON.parse(value.doc), proposals,
      created_at: value.created_at, updated_at: value.updated_at,
      edit_policy:readStudioPolicy(db,value.page_id).policy,
      editing_only:!!readStudioPolicy(db,value.page_id).editing_only,
      descriptions_status:studioDescriptionsStatus(db,value.page_id,JSON.parse(value.doc)),
      ...(readStudioTask(db,value.page_id)?{task:publicStudioTask(readStudioTask(db,value.page_id))}:{}),
    };
  }
  function saveProposal(db, proposal) {
    db.prepare('UPDATE studio_proposals SET status=?,value=? WHERE proposal_id=?')
      .run(proposal.status, JSON.stringify(proposal), proposal.proposal_id);
  }
  function stalePending(db, value, at) {
    for (const entry of db.prepare("SELECT value FROM studio_proposals WHERE page_id=? AND status='pending'").all(value.page_id)) {
      const proposal = JSON.parse(entry.value);
      proposal.status = 'stale';
      proposal.resolved_at = at;
      proposal.resolved_revision = value.revision;
      saveProposal(db, proposal);
    }
  }
  function snapshot(db, previous, title, doc, operation) {
    revision(previous.revision);
    const next = previous.revision + 1, at = now();
    const changed = db.prepare('UPDATE studio_pages SET title=?,revision=?,kind=?,doc=?,updated_at=? WHERE page_id=? AND revision=?')
      .run(title, next, doc.kind, JSON.stringify(doc), at, previous.page_id, previous.revision);
    if (changed.changes !== 1) conflict();
    db.prepare('INSERT INTO studio_revisions VALUES(?,?,?,?,?)')
      .run(previous.page_id, next, operation, at, JSON.stringify({title, doc}));
    return row(db, previous.page_id);
  }

  // Pure-within-transaction proposal preparation, shared by UI and consent execution.
  function prepareProposalResolution(db,previous,decision){
    const accepted=selectors(decision.accept),reject=decision.reject;
    if(typeof reject!=='boolean'||(reject?accepted.length!==0:accepted.length===0))invalid('Choose acceptance selectors or rejection.');
    const entry=db.prepare('SELECT value FROM studio_proposals WHERE proposal_id=? AND page_id=?').get(id(decision.proposal_id),previous.page_id);
    if(!entry)notFound('Proposal');const proposal=JSON.parse(entry.value);if(proposal.status!=='pending')conflict();
    if(proposal.submitted_revision!==previous.revision){const gap=db.prepare('SELECT revision,operation FROM studio_revisions WHERE page_id=? AND revision>? AND revision<=? ORDER BY revision').all(previous.page_id,proposal.submitted_revision,previous.revision);if(gap.length!==previous.revision-proposal.submitted_revision||gap.some(r=>!['human-takeover','human-pause'].includes(r.operation)))conflict();}
    const current=JSON.parse(previous.doc),doc=reject?current:mergeProposal(current,proposal,accepted),status=reject?'rejected':resolutionStatus(proposal,accepted);
    if(!reject&&proposal.descriptions_checked&&status==='accepted')checkStudioDescriptionRefresh(current,doc);
    return {proposal,doc,status,accepted,reject};
  }
  function commitProposalResolution(db,resolution,next){
    const {proposal,doc,status,accepted,reject}=resolution;
    if(!reject&&proposal.descriptions_checked&&status==='accepted')acknowledgeStudioDescriptions(db,next.page_id,doc);
    Object.assign(proposal,{status,accepted,resolved_at:next.updated_at,resolved_revision:next.revision});saveProposal(db,proposal);
  }

  return Object.freeze({
    ...createStudioConsentMethods({transaction,row,checked,page,snapshot,stalePending,request,id,revision,text,prepareProposalResolution,commitProposalResolution,assertPagePolicy:assertStudioPagePolicy,assertSharedUnchanged:assertStudioSharedUnchanged,lockedUnchanged,readPolicy:readStudioPolicy,studioTextOnlySession,setStudioTextOnly}),
    ...createStudioTaskMethods({transaction,row,checked,page,snapshot,stalePending,request,id,revision,text,validateDoc:validateStudioDoc,lockedUnchanged,assertPagePolicy:assertStudioPagePolicy,assertSharedUnchanged:assertStudioSharedUnchanged,acknowledgeDescriptions:acknowledgeStudioDescriptions,checkDescriptionRefresh:checkStudioDescriptionRefresh,studioTextOnlySession,setStudioTextOnly,assertConsentGeneration:assertStudioConsentGeneration}),
    ...createStudioPolicyMethods({transaction,checked,page,snapshot,stalePending,request,id,revision}),
    ...createStudioSeriesProfileMethods({transaction,row,seriesRow,checked,page,snapshot,stalePending,request,id,revision,validateDoc:validateStudioDoc}),
    ...createStudioPlanMethods({transaction,row,checked,request,id,revision,text,studioTextOnlySession}),
    async state(input = {}) {
      request(input, ['series_id','offset','limit'],[]);
      const seriesId=input.series_id===undefined?undefined:id(input.series_id),offset=input.offset??0,limit=input.limit??100;
      if(!Number.isSafeInteger(offset)||offset<0||offset>1000000||!Number.isSafeInteger(limit)||limit<1||limit>100)invalid('Invalid page range.');
      return transaction(false, db => {
        if(!db)return{series:[],pages:[],page_total:0,next_offset:null,features:FEATURES};
        if(seriesId)seriesRow(db,seriesId);
        const seriesFilter=existsTable(db,'studio_deleted_series')?' WHERE series_id NOT IN (SELECT series_id FROM studio_deleted_series)':'';
        const clause=livePages(db)+(seriesId?' AND p.series_id=?':''),params=seriesId?[seriesId]:[];
        const total=db.prepare(`SELECT COUNT(*) AS n FROM studio_pages p WHERE ${clause}`).get(...params).n;
        const pendingCol=existsTable(db,'studio_proposals')?"(SELECT COUNT(*) FROM studio_proposals sp WHERE sp.page_id=p.page_id AND sp.status='pending')":"0";
        return{series:db.prepare(`SELECT series_id,title FROM studio_series${seriesFilter} ORDER BY created_at DESC,rowid DESC LIMIT ?`).all(LIST_LIMIT),
          pages:db.prepare(`SELECT p.page_id,p.series_id,p.title,p.revision,p.kind,p.updated_at,${pendingCol} AS pending_proposals FROM studio_pages p WHERE ${clause} ORDER BY p.updated_at DESC,p.rowid DESC LIMIT ? OFFSET ?`).all(...params,limit,offset),page_total:total,next_offset:offset+limit<total?offset+limit:null,features:FEATURES};
      });
    },
    async renameSeries(input){
      request(input,['series_id','expected_title','title']);const seriesId=id(input.series_id),expected=text(input.expected_title,'expected title',200),title=text(input.title,'title',200);
      return transaction(true,db=>{if(seriesRow(db,seriesId).title!==expected)conflict();db.prepare('UPDATE studio_series SET title=? WHERE series_id=?').run(title,seriesId);return{series_id:seriesId,title};});
    },
    async deletePage(input){
      request(input,['page_id','expected_revision','lease_token'],['page_id','expected_revision']);const pageId=id(input.page_id),expected=revision(input.expected_revision);
      return transaction(true,db=>{checked(db,pageId,expected);requireStudioHuman(db,pageId,input.lease_token);db.prepare('INSERT INTO studio_deleted_pages VALUES(?,?)').run(pageId,now());return{deleted:true,page_id:pageId};});
    },
    async deleteSeries(input){
      request(input,['series_id','expected_title','expected_pages']);const seriesId=id(input.series_id),expected=text(input.expected_title,'expected title',200),pages=input.expected_pages;
      if(!Array.isArray(pages)||pages.length>5000)invalid('Expected a bounded complete page set.');const requested=new Map();
      for(const p of pages){request(p,['page_id','revision']);const pageId=id(p.page_id);if(requested.has(pageId))invalid('Duplicate page.');requested.set(pageId,revision(p.revision));}
      return transaction(true,db=>{if(seriesRow(db,seriesId).title!==expected)conflict();const current=db.prepare(`SELECT p.page_id,p.revision FROM studio_pages p WHERE ${livePages(db)} AND p.series_id=?`).all(seriesId);
        if(current.length!==requested.size||current.some(p=>requested.get(p.page_id)!==p.revision))conflict();const at=now();
        for(const p of current)requireStudioHuman(db,p.page_id,undefined);
        for(const p of current)db.prepare('INSERT INTO studio_deleted_pages VALUES(?,?)').run(p.page_id,at);
        db.prepare('INSERT INTO studio_deleted_series VALUES(?,?)').run(seriesId,at);return{deleted:true,series_id:seriesId,page_ids:current.map(p=>p.page_id)};
      });
    },
    async createSeries(input) {
      request(input, ['title']);
      const title = text(input.title, 'series title', 200);
      return transaction(true, db => {
        if (db.prepare('SELECT COUNT(*) AS count FROM studio_series WHERE series_id NOT IN (SELECT series_id FROM studio_deleted_series)').get().count >= LIST_LIMIT) invalid('A session may have at most 100 series.');
        const series_id = randomUUID();
        db.prepare('INSERT INTO studio_series VALUES(?,?,?)').run(series_id, title, now());
        return {series_id, title};
      });
    },
    async createPage(input) {
      request(input, ['series_id', 'title', 'doc']);
      const seriesId = id(input.series_id), title = text(input.title, 'page title', 200), doc = validateStudioDoc(input.doc);
      return transaction(true, db => {
        seriesRow(db,seriesId);
        const pageId = randomUUID(), at = now();
        db.prepare('INSERT INTO studio_pages VALUES(?,?,?,?,?,?,?,?)').run(pageId, seriesId, title, 1, doc.kind, JSON.stringify(doc), at, at);
        db.prepare('INSERT INTO studio_revisions VALUES(?,?,?,?,?)').run(pageId, 1, 'create', at, JSON.stringify({title, doc}));
        return page(db, row(db, pageId));
      });
    },
    async getPage(input) {
      request(input, ['page_id']);
      const pageId = id(input.page_id);
      return transaction(false, db => page(db, row(db, pageId)));
    },
    async updatePage(input) {
      request(input, ['page_id', 'expected_revision', 'title', 'doc','lease_token'], ['page_id', 'expected_revision', 'doc']);
      const pageId = id(input.page_id), expected = revision(input.expected_revision), doc = validateStudioDoc(input.doc);
      const title = Object.hasOwn(input, 'title') ? text(input.title, 'page title', 200) : undefined;
      return transaction(true, db => {
        const previous = checked(db, pageId, expected);
        requireStudioHuman(db,pageId,input.lease_token);
        const next = snapshot(db, previous, title ?? previous.title, doc, 'update');
        stalePending(db, next, next.updated_at);
        return page(db, next);
      });
    },
    async propose(input) {
      request(input, ['page_id', 'expected_revision', 'doc', 'summary','descriptions_checked'], ['page_id','expected_revision','doc','summary']);
      if(input.descriptions_checked!==undefined&&typeof input.descriptions_checked!=='boolean')invalid('descriptions_checked must be boolean.');
      const pageId = id(input.page_id), expected = revision(input.expected_revision);
      const proposed = validateStudioDoc(input.doc), summary = text(input.summary, 'proposal summary', 1000);
      return transaction(true, db => {
        const previous = checked(db, pageId, expected), base = JSON.parse(previous.doc),task=readStudioTask(db,pageId);
        if(task&&['manual','paused'].includes(task.control))throw fault('STUDIO_HUMAN_CONTROL','Human control blocks Agent proposals.');
        assertStudioSharedUnchanged(base,proposed);
        assertStudioPagePolicy(db,previous,proposed);
        lockedUnchanged(base, proposed);
        if(input.descriptions_checked)checkStudioDescriptionRefresh(base,proposed);
        const next = snapshot(db, previous, previous.title, base, 'propose');
        stalePending(db, next, next.updated_at);
        const proposal = {
          proposal_id: randomUUID(), status: 'pending', summary,
          base_revision: previous.revision, submitted_revision: next.revision,
          base_doc: base, proposed_doc: proposed, accepted: [], created_at: next.updated_at,
          ...(input.descriptions_checked?{descriptions_checked:true}:{}),
        };
        db.prepare('INSERT INTO studio_proposals VALUES(?,?,?,?,?)')
          .run(proposal.proposal_id, pageId, next.revision, proposal.status, JSON.stringify(proposal));
        return page(db, next);
      });
    },
    async resolve(input,authorization) {
      request(input, ['page_id', 'expected_revision', 'proposal_id', 'accept', 'reject','lease_token'], ['page_id', 'expected_revision', 'proposal_id', 'accept']);
      const pageId = id(input.page_id), proposalId = id(input.proposal_id), expected = revision(input.expected_revision);
      const accepted = selectors(input.accept), reject = Object.hasOwn(input, 'reject') ? input.reject : false;
      if (typeof reject !== 'boolean' || (reject ? accepted.length !== 0 : accepted.length === 0)) invalid('Choose acceptance selectors or reject:true with accept:[].');
      return transaction(true, db => {
        const previous = checked(db, pageId, expected);
        if(authorization?.message_id){
          if(readStudioTask(db,pageId)?.control==='manual')throw fault('STUDIO_HUMAN_CONTROL','Return control through a clean owner handoff before resolving proposals.');
        }else requireStudioHuman(db,pageId,input.lease_token);
        const resolution=prepareProposalResolution(db,previous,{proposal_id:proposalId,accept:accepted,reject});
        if(authorization?.message_id){assertStudioSharedUnchanged(JSON.parse(previous.doc),resolution.doc);assertStudioPagePolicy(db,previous,resolution.doc);lockedUnchanged(JSON.parse(previous.doc),resolution.doc);}
        const next=snapshot(db,previous,previous.title,resolution.doc,reject?'reject':'accept');
        commitProposalResolution(db,resolution,next);
        stalePending(db, next, next.updated_at);
        return page(db, next);
      });
    },
    async history(input) {
      request(input, ['page_id', 'revision'], ['page_id']);
      const pageId = id(input.page_id);
      const target = input.revision === undefined ? undefined : revision(input.revision);
      return transaction(false, db => {
        row(db, pageId);
        if (target !== undefined) {
          const entry = db.prepare('SELECT revision,operation,created_at,snapshot FROM studio_revisions WHERE page_id=? AND revision=?').get(pageId, target);
          if (!entry) notFound('Revision');
          return {revision: entry.revision, operation: entry.operation, created_at: entry.created_at, snapshot: JSON.parse(entry.snapshot)};
        }
        return {revisions: db.prepare('SELECT revision,operation,created_at FROM studio_revisions WHERE page_id=? ORDER BY revision DESC LIMIT ?').all(pageId, LIST_LIMIT)};
      });
    },
    async restore(input) {
      request(input, ['page_id', 'expected_revision', 'revision','lease_token'],['page_id','expected_revision','revision']);
      const pageId = id(input.page_id), expected = revision(input.expected_revision), target = revision(input.revision);
      return transaction(true, db => {
        const previous = checked(db, pageId, expected);
        requireStudioHuman(db,pageId,input.lease_token);
        const entry = db.prepare('SELECT snapshot FROM studio_revisions WHERE page_id=? AND revision=?').get(pageId, target);
        if (!entry) notFound('Revision');
        const old = JSON.parse(entry.snapshot);
        const next = snapshot(db, previous, text(old.title, 'page title', 200), validateStudioDoc(old.doc), 'restore');
        // Restore content only. Decisions remain final; pending proposals expire.
        stalePending(db, next, next.updated_at);
        return page(db, next);
      });
    },
  });
}
