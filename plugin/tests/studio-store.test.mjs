import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, writeFile, readFile, stat, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

import {emptyStudioDoc, compileStudioDoc} from '../src/studio-domain.mjs';

const api = await import('../src/studio-store.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const item = (id, extra = {}) => ({id, label: 'object', caption: `Item ${id}`, bbox: [16, 16, 96, 96], ...extra});
const doc = (items = [item('a')]) => ({
  kind: 'layout',
  layout: {width: 320, height: 256, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: {caption: 'A quiet garden.'}, items},
  caption: {caption: 'Original plain caption; preserve my words.'},
});
async function setup(t) {
  assert.equal(typeof api.createStudioStore, 'function', 'independent Studio SQLite store must exist');
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'studio-store-'));
  t.after(() => rm(dataRoot, {recursive: true, force: true}));
  return {dataRoot, store: () => api.createStudioStore({dataRoot})};
}
async function pageFixture(t, initial = doc()) {
  const f = await setup(t), store = f.store();
  const series = await store.createSeries({title: 'Series One'});
  const page = await store.createPage({series_id: series.series_id, title: 'Page One', doc: initial});
  return {...f, store, series, page};
}
const latest = page => page.proposals.at(-1);
const invalid = {code: 'STUDIO_INVALID_INPUT'};

test('state/get/history are read only and creation uses only new studio/editor.sqlite', async t => {
  const f = await setup(t), s = f.store();
  await mkdir(path.join(f.dataRoot, 'workbench'));
  const legacy = path.join(f.dataRoot, 'workbench', 'documents.sqlite');
  await writeFile(legacy, 'old workbench sentinel');
  assert.deepEqual(await s.state({}), {series: [], pages: [],page_total:0,next_offset:null,features:{proposal_order:true,history_preview:true}});
  await assert.rejects(s.getPage({page_id: randomUUID()}), {code: 'STUDIO_NOT_FOUND'});
  assert.deepEqual(await readdir(f.dataRoot), ['workbench']);
  const series = await s.createSeries({title: 'Test'});
  const input = doc();
  const p = await s.createPage({series_id: series.series_id, title: 'Title', doc: input});
  assert.deepEqual(Object.keys(p).sort(), ['created_at', 'descriptions_status', 'doc', 'edit_policy', 'editing_only', 'page_id', 'proposals', 'revision', 'series_id', 'title', 'updated_at']);
  assert.match(p.page_id, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
  assert.equal(p.revision, 1);
  assert.deepEqual(p.proposals, []);
  assert.equal(p.doc.caption.caption, 'Original plain caption; preserve my words.');
  input.layout.items[0].caption = 'mutated input';
  p.doc.layout.items[0].caption = 'mutated output';
  const dbFile = path.join(f.dataRoot, 'studio', 'editor.sqlite');
  const before = await stat(dbFile), bytes = await readFile(dbFile);
  const loaded = await f.store().getPage({page_id: p.page_id});
  assert.equal(loaded.doc.layout.items[0].caption, 'Item a');
  assert.deepEqual(await s.state({}), {
    page_total:1,next_offset:null,
    features:{proposal_order:true,history_preview:true},
    series: [{series_id: series.series_id, title: 'Test'}],
    pages: [{page_id: p.page_id, series_id: series.series_id, title: 'Title', revision: 1, kind: 'layout', updated_at: p.updated_at, pending_proposals: 0}],
  });
  assert.deepEqual((await s.history({page_id: p.page_id})).revisions.map(r => [r.revision, r.operation]), [[1, 'create']]);
  assert.equal((await stat(dbFile)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readFile(dbFile), bytes);
  assert.equal(await readFile(legacy, 'utf8'), 'old workbench sentinel');
});

test('empty editing documents have no references prerequisite and optional page titles retain on update', async t => {
  const f = await setup(t), s = f.store();
  const series = await s.createSeries({title: 'Drafts'});
  const empty = emptyStudioDoc();
  const p = await s.createPage({series_id: series.series_id, title: 'Untitled', doc: empty});
  assert.equal(p.doc.kind, 'layout');
  assert.equal(p.doc.layout.summary.caption, '');
  assert.deepEqual(p.doc.layout.items, []);
  assert.equal(p.doc.caption.caption, '');
  const updated = await s.updatePage({page_id: p.page_id, expected_revision: 1, doc: empty});
  assert.equal(updated.title, 'Untitled');
  assert.deepEqual(updated.doc, empty);
  assert.equal(compileStudioDoc(updated.doc).compiled, false);
  await assert.rejects(s.createPage({series_id: series.series_id, title: 'No document'}), invalid);
});

test('whole-document CAS across independent store instances retains complete title and both-mode snapshots', async t => {
  const f = await pageFixture(t), {page: p, store: s} = f;
  const changed = doc([item('b')]); changed.kind = 'caption'; changed.caption.caption = 'New caption';
  const competing = await Promise.allSettled([
    s.updatePage({page_id: p.page_id, expected_revision: 1, title: 'Renamed', doc: changed}),
    api.createStudioStore({dataRoot: f.dataRoot}).updatePage({page_id: p.page_id, expected_revision: 1, title: 'stale', doc: doc()}),
  ]);
  assert.equal(competing[0].status, 'fulfilled');
  assert.equal(competing[1].reason.code, 'STUDIO_CONFLICT');
  const restored = await s.restore({page_id: p.page_id, expected_revision: 2, revision: 1});
  assert.equal(restored.revision, 3);
  assert.equal(restored.title, 'Page One');
  assert.deepEqual(restored.doc, doc());
  const again = await s.restore({page_id: p.page_id, expected_revision: 3, revision: 2});
  assert.equal(again.title, 'Renamed');
  assert.deepEqual(again.doc, changed);
  assert.deepEqual((await s.history({page_id: p.page_id})).revisions.map(r => [r.revision, r.operation]), [[4, 'restore'], [3, 'restore'], [2, 'update'], [1, 'create']]);
});

test('proposal snapshots do not change content; accepting one item closes all unselected changes', async t => {
  const {store: s, page: p} = await pageFixture(t, doc([item('a'), item('b')]));
  const proposed = structuredClone(p.doc);
  proposed.layout.items[0].bbox = [32, 32, 112, 112];
  proposed.layout.items[1].caption = 'Do not accept B';
  proposed.layout.summary.caption = 'Do not accept summary';
  proposed.caption.caption = 'Do not accept caption';
  const pending = await s.propose({page_id: p.page_id, expected_revision: 1, doc: proposed, summary: 'Move A'});
  assert.equal(pending.revision, 2);
  assert.deepEqual(pending.doc, p.doc);
  const proposal = latest(pending);
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.base_revision, 1);
  assert.equal(proposal.submitted_revision, 2);
  assert.deepEqual(proposal.accepted, []);
  assert.deepEqual(proposal.base_doc, p.doc);
  assert.deepEqual(proposal.proposed_doc, proposed);
  proposed.layout.items[0].caption = 'external mutation';
  proposal.base_doc.kind = 'caption';
  const accepted = await s.resolve({page_id: p.page_id, expected_revision: 2, proposal_id: proposal.proposal_id, accept: ['item:a']});
  assert.equal(accepted.revision, 3);
  assert.deepEqual(accepted.doc.layout.items[0].bbox, [32, 32, 112, 112]);
  assert.equal(accepted.doc.layout.items[0].caption, 'Item a');
  assert.deepEqual(accepted.doc.layout.items[1], p.doc.layout.items[1]);
  assert.deepEqual(accepted.doc.layout.summary, p.doc.layout.summary);
  assert.deepEqual(accepted.doc.caption, p.doc.caption);
  assert.equal(latest(accepted).status, 'partial');
  assert.deepEqual(latest(accepted).accepted, ['item:a']);
  await assert.rejects(s.resolve({page_id: p.page_id, expected_revision: 3, proposal_id: proposal.proposal_id, accept: ['caption']}), {code: 'STUDIO_CONFLICT'});
});

test('item selectors add/delete/replace without applying reorder; aggregate items selector reorders', async t => {
  let {store: s, page: p} = await pageFixture(t, doc([item('a'), item('b')]));
  async function apply(items, accept) {
    const proposed = {...p.doc, layout: {...p.doc.layout, items}};
    const pending = await s.propose({page_id: p.page_id, expected_revision: p.revision, doc: proposed, summary: 'Edit items'});
    p = await s.resolve({page_id: p.page_id, expected_revision: pending.revision, proposal_id: latest(pending).proposal_id, accept});
  }
  await apply([item('b'), item('c')], ['item:c']);
  assert.deepEqual(p.doc.layout.items.map(i => i.id), ['a', 'b', 'c']);
  await apply([item('c'), item('b')], ['item:a']);
  assert.deepEqual(p.doc.layout.items.map(i => i.id), ['b', 'c']);
  await apply([item('c'), item('b', {caption: 'B replaced'})], ['item:b']);
  assert.deepEqual(p.doc.layout.items.map(i => i.id), ['b', 'c']);
  assert.equal(p.doc.layout.items[0].caption, 'B replaced');
  await apply([p.doc.layout.items[1], p.doc.layout.items[0]], ['layout.items']);
  assert.deepEqual(p.doc.layout.items.map(i => i.id), ['c', 'b']);
});

test('root summary camera and caption selectors preserve unrelated optional document metadata', async t => {
  const {store: s, page: p} = await pageFixture(t);
  const proposed = structuredClone(p.doc);
  proposed.kind = 'caption';
  proposed.layout.summary.caption = 'Accepted summary';
  proposed.layout.camera = {enabled: false};
  proposed.caption.caption = 'Accepted caption';
  const pending = await s.propose({page_id: p.page_id, expected_revision: 1, doc: proposed, summary: 'Both modes'});
  const resolved = await s.resolve({page_id: p.page_id, expected_revision: 2, proposal_id: latest(pending).proposal_id, accept: ['kind', 'layout.summary', 'layout.camera', 'caption']});
  assert.deepEqual(resolved.doc, proposed);
  const removed = structuredClone(resolved.doc); delete removed.layout.camera;
  const next = await s.propose({page_id: p.page_id, expected_revision: 3, doc: removed, summary: 'Remove camera'});
  const result = await s.resolve({page_id: p.page_id, expected_revision: 4, proposal_id: latest(next).proposal_id, accept: ['layout.camera']});
  assert.equal(Object.hasOwn(result.doc.layout, 'camera'), false);
});

test('manual edits, later proposals and restore invalidate pending and never resurrect previous decisions', async t => {
  let {store: s, page: p} = await pageFixture(t);
  const proposed = doc(); proposed.caption.caption = 'AI proposal';
  p = await s.propose({page_id: p.page_id, expected_revision: 1, doc: proposed, summary: 'one'});
  const firstId = latest(p).proposal_id;
  p = await s.propose({page_id: p.page_id, expected_revision: 2, doc: proposed, summary: 'two'});
  assert.equal(p.proposals[0].status, 'stale');
  const secondId = latest(p).proposal_id;
  p = await s.updatePage({page_id: p.page_id, expected_revision: 3, doc: p.doc});
  assert(p.proposals.every(v => v.status === 'stale'));
  await assert.rejects(s.resolve({page_id: p.page_id, expected_revision: 4, proposal_id: secondId, accept: ['caption']}), {code: 'STUDIO_CONFLICT'});
  p = await s.propose({page_id: p.page_id, expected_revision: 4, doc: proposed, summary: 'three'});
  const thirdId = latest(p).proposal_id;
  p = await s.restore({page_id: p.page_id, expected_revision: 5, revision: 2});
  assert.equal(p.revision, 6);
  assert(p.proposals.every(v => v.status === 'stale'));
  for (const proposal_id of [firstId, thirdId]) await assert.rejects(s.resolve({page_id: p.page_id, expected_revision: 6, proposal_id, accept: ['caption']}), {code: 'STUDIO_CONFLICT'});
  p = await s.propose({page_id: p.page_id, expected_revision: 6, doc: proposed, summary: 'reject me'});
  p = await s.resolve({page_id: p.page_id, expected_revision: 7, proposal_id: latest(p).proposal_id, accept: [], reject: true});
  assert.equal(latest(p).status, 'rejected');
  assert.deepEqual(p.doc, doc());
  p = await s.restore({page_id: p.page_id, expected_revision: 8, revision: 7});
  assert.equal(latest(p).status, 'rejected');
});

test('proposals cannot mutate/delete/reorder/unlock locked items but manual unlock is allowed', async t => {
  const {store: s, page: p} = await pageFixture(t, doc([item('a', {locked: true}), item('b')]));
  for (const items of [[item('a', {locked: true, caption: 'changed'}), item('b')], [item('b')], [item('b'), item('a', {locked: true})], [item('a', {locked: false}), item('b')]]) {
    await assert.rejects(s.propose({page_id: p.page_id, expected_revision: 1, doc: doc(items), summary: 'Locked'}), {code: 'STUDIO_LOCKED'});
  }
  assert.equal((await s.history({page_id: p.page_id})).revisions.length, 1);
  const unlocked = await s.updatePage({page_id: p.page_id, expected_revision: 1, doc: doc([item('a', {locked: false}), item('b')])});
  assert.equal(unlocked.revision, 2);
  assert.equal((await s.propose({page_id: p.page_id, expected_revision: 2, doc: doc([item('a', {caption: 'Now allowed'}), item('b')]), summary: 'Unlocked'})).revision, 3);
});

test('partial merge can delete an unlocked item before a locked item by identity while preserving the locked item', async t => {
  const {store: s, page: p} = await pageFixture(t, doc([item('a'), item('b', {locked: true})]));
  const pending = await s.propose({page_id: p.page_id, expected_revision: 1, doc: doc([item('c'), item('b', {locked: true})]), summary: 'Replace first'});
  const partial = await s.resolve({page_id: p.page_id, expected_revision: 2, proposal_id: latest(pending).proposal_id, accept: ['item:a']});
  assert.equal(partial.revision, 3);
  assert.equal(latest(partial).status, 'partial');
  assert.deepEqual(partial.doc.layout.items.map(i => i.id), ['b']);
  const pending2 = await s.propose({page_id: p.page_id, expected_revision: 3, doc: doc([item('c'), item('b', {locked: true})]), summary: 'Add c before locked b'});
  const accepted = await s.resolve({page_id: p.page_id, expected_revision: 4, proposal_id: latest(pending2).proposal_id, accept: ['layout.items']});
  assert.equal(latest(accepted).status, 'accepted');
  assert.deepEqual(accepted.doc.layout.items.map(i => i.id), ['c', 'b']);
});

test('UUIDs, strict request shapes, titles, finite revisions and malformed documents are rejected atomically', async t => {
  const {store: s, page: p, series} = await pageFixture(t);
  for (const id of ['../escape', 'a'.repeat(36), '00000000-0000-0000-0000-000000000000', '', null, {}, p.page_id + '/x']) {
    await assert.rejects(s.getPage({page_id: id}), invalid);
    await assert.rejects(s.createPage({series_id: id, title: 'x', doc: doc()}), invalid);
  }
  for (const title of ['', ' ', 'x'.repeat(201), null, 1]) {
    await assert.rejects(s.createSeries({title}), invalid);
    await assert.rejects(s.createPage({series_id: series.series_id, title, doc: doc()}), invalid);
    await assert.rejects(s.updatePage({page_id: p.page_id, expected_revision: 1, title, doc: doc()}), invalid);
  }
  for (const expected_revision of [0, -1, NaN, Infinity, 1.5, '1', Number.MAX_SAFE_INTEGER]) await assert.rejects(s.updatePage({page_id: p.page_id, expected_revision, doc: doc()}), invalid);
  for (const bad of [null, {}, {...doc(), extra: true}, {...doc(), layout: {...doc().layout, items: [item('a'), item('a')]}}, {...doc(), layout: {...doc().layout, width: NaN}}, {...doc(), layout: {...doc().layout, items: Array(2)}}]) {
    await assert.rejects(s.updatePage({page_id: p.page_id, expected_revision: 1, doc: bad}), invalid);
  }
  await assert.rejects(s.updatePage({page_id: p.page_id, expected_revision: 1}), invalid);
  await assert.rejects(s.createPage({series_id: randomUUID(), title: 'missing', doc: doc()}), {code: 'STUDIO_NOT_FOUND'});
  await assert.rejects(s.restore({page_id: p.page_id, expected_revision: 1, revision: 9}), {code: 'STUDIO_NOT_FOUND'});
  for (const [method, value] of [['state', {limit: 0}], ['history', {page_id: p.page_id, limit: 1}], ['getPage', {page_id: p.page_id, path: '/tmp'}], ['createSeries', {title: 'a', unknown: true}]]) await assert.rejects(s[method](value), invalid);
  assert.equal((await s.getPage({page_id: p.page_id})).revision, 1);
  assert.equal((await s.history({page_id: p.page_id})).revisions.length, 1);
});

test('selectors must describe actual proposed changes, use dense unique bounded arrays, and not mix item granularity', async t => {
  const {store: s, page: p} = await pageFixture(t);
  const proposed = doc([item('a', {caption: 'changed'})]);
  const pending = await s.propose({page_id: p.page_id, expected_revision: 1, doc: proposed, summary: 'change'});
  for (const accept of [[], ['caption'], ['item:missing'], ['layout.items', 'item:a'], ['item:a', 'item:a'], ['layout.width'], ['__proto__'], Array(1), Array.from({length: 261}, (_, i) => `item:oversize${i}`), 'item:a']) await assert.rejects(s.resolve({page_id: p.page_id, expected_revision: 2, proposal_id: latest(pending).proposal_id, accept}), invalid);
  await assert.rejects(s.resolve({page_id: p.page_id, expected_revision: 2, proposal_id: latest(pending).proposal_id, accept: ['item:a'], reject: true}), invalid);
  await assert.rejects(s.resolve({page_id: p.page_id, expected_revision: 2, proposal_id: latest(pending).proposal_id, accept: [], reject: 'yes'}), invalid);
  assert.equal((await s.getPage({page_id: p.page_id})).revision, 2);
  assert.equal(latest(await s.getPage({page_id: p.page_id})).status, 'pending');
});

test('partial item acceptance revalidates merged documents rather than overflowing 128 items', async t => {
  const initial = doc(Array.from({length: 128}, (_, i) => item(`i${i}`)));
  const {store: s, page: p} = await pageFixture(t, initial);
  const proposed = doc([...initial.layout.items.slice(1), item('new')]);
  const pending = await s.propose({page_id: p.page_id, expected_revision: 1, doc: proposed, summary: 'swap'});
  await assert.rejects(s.resolve({page_id: p.page_id, expected_revision: 2, proposal_id: latest(pending).proposal_id, accept: ['item:new']}), invalid);
  assert.equal((await s.getPage({page_id: p.page_id})).doc.layout.items.length, 128);
});

test('bounded JSON requests fail before serializing non-JSON values or writing a revision', async t => {
  const {store: s, page: p} = await pageFixture(t);
  const cycle = doc(); cycle.caption.caption = cycle;
  const bigint = doc(); bigint.caption.caption = 1n;
  const tooLarge = doc(Array.from({length: 50}, (_, i) => item(`large${i}`, {caption: '界'.repeat(12000)})));
  const custom = doc(); custom.toJSON = () => doc();
  for (const value of [cycle, bigint, tooLarge, custom]) await assert.rejects(s.updatePage({page_id: p.page_id, expected_revision: 1, doc: value}), invalid);
  await assert.rejects(s.propose({page_id: p.page_id, expected_revision: 1, doc: doc(), summary: 'x'.repeat(1001)}), invalid);
  assert.equal((await s.history({page_id: p.page_id})).revisions.length, 1);
});

test('series creation is capped at 100 and all list/history/proposal responses stay bounded', async t => {
  const f = await setup(t), s = f.store();
  let series;
  for (let i = 0; i < 100; i++) series = await s.createSeries({title: `Series ${i}`});
  await assert.rejects(s.createSeries({title: 'Overflow'}), invalid);
  assert.equal((await s.state({})).series.length, 100);
  let p;
  for (let i = 0; i < 101; i++) p = await s.createPage({series_id: series.series_id, title: `Page ${i}`, doc: doc()});
  assert.equal((await s.state({})).pages.length, 100);
  for (let i = 0; i < 104; i++) {
    const value = doc(); value.caption.caption = `Proposal ${i}`;
    p = await s.propose({page_id: p.page_id, expected_revision: p.revision, doc: value, summary: `Proposal ${i}`});
  }
  assert.equal(p.proposals.length, 20);
  assert.deepEqual(p.proposals.map(v => v.submitted_revision), Array.from({length: 20}, (_, i) => i + 86));
  assert.equal(p.proposals.filter(v => v.status === 'pending').length, 1);
  assert.equal((await s.history({page_id: p.page_id})).revisions.length, 100);
  const restored = await s.restore({page_id: p.page_id, expected_revision: 105, revision: 1});
  assert.equal(restored.revision, 106);
  assert.deepEqual(restored.doc, doc());
});

test('all item deletions and additions in one valid proposal fit the selector bound', async t => {
  const initial = doc(Array.from({length: 128}, (_, i) => item(`before${i}`)));
  const proposed = doc(Array.from({length: 128}, (_, i) => item(`after${i}`)));
  const {store: s, page: p} = await pageFixture(t, initial);
  const pending = await s.propose({page_id: p.page_id, expected_revision: 1, doc: proposed, summary: 'Replace every item'});
  const accept = [...initial.layout.items.map(v => `item:${v.id}`), ...proposed.layout.items.map(v => `item:${v.id}`)];
  const resolved = await s.resolve({page_id: p.page_id, expected_revision: 2, proposal_id: latest(pending).proposal_id, accept});
  assert.deepEqual(resolved.doc, proposed);
  assert.equal(latest(resolved).accepted.length, 256);
});

test('editing persistence allows outside boxes while compile reports them and never writes a revision', async t => {
  const initial = doc([item('outside', {bbox: [-10, 0, 400, 200]})]);
  const {store: s, page: p} = await pageFixture(t, initial);
  assert.deepEqual(p.doc, initial);
  assert.equal(compileStudioDoc(p.doc).compiled, false);
  assert.equal((await s.getPage({page_id: p.page_id})).revision, 1);
});

test('request accessors and non-JSON properties fail without invoking user code', async t => {
  const {store: s, page: p} = await pageFixture(t);
  let called = false;
  const input = {page_id: p.page_id, expected_revision: 1, get doc() {called = true; return doc();}};
  await assert.rejects(s.updatePage(input), invalid);
  assert.equal(called, false);
  const hidden = {page_id: p.page_id}; Object.defineProperty(hidden, 'ignored', {value: true});
  await assert.rejects(s.getPage(hidden), invalid);
  await assert.rejects(s.getPage({page_id: p.page_id, [Symbol('extra')]: true}), invalid);
  const deep = doc(); let branch = deep;
  for (let i = 0; i < 40; i++) branch = branch.extra = {};
  await assert.rejects(s.updatePage({page_id: p.page_id, expected_revision: 1, doc: deep}), invalid);
  assert.equal((await s.getPage({page_id: p.page_id})).revision, 1);
});

function childUpdate(t, dataRoot, page_id, title) {
  const moduleUrl = new URL('../src/studio-store.mjs', import.meta.url).href;
  const code = `import {createStudioStore} from ${JSON.stringify(moduleUrl)};import {writeFile} from 'node:fs/promises';let result;try{const page=await createStudioStore({dataRoot:${JSON.stringify(dataRoot)}}).updatePage({page_id:${JSON.stringify(page_id)},expected_revision:1,title:${JSON.stringify(title)},doc:${JSON.stringify(doc())}});result={status:'ok',revision:page.revision};}catch(error){result={status:error.code};}await writeFile(${JSON.stringify(path.join(dataRoot, title + '.json'))},JSON.stringify(result));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], {stdio: 'inherit', env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}});
  t.after(() => { if (child.exitCode === null) child.kill(); });
  return new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
}

test('independent Node processes race a single revision with one CAS winner and no lost snapshot', async t => {
  const {store: s, page: p, dataRoot} = await pageFixture(t);
  assert.deepEqual(await Promise.all([childUpdate(t, dataRoot, p.page_id, 'one'), childUpdate(t, dataRoot, p.page_id, 'two')]), [0, 0]);
  const results = await Promise.all(['one', 'two'].map(async name => JSON.parse(await readFile(path.join(dataRoot, name + '.json'), 'utf8'))));
  assert.deepEqual(results.map(v => v.status).sort(), ['STUDIO_CONFLICT', 'ok']);
  assert.equal((await s.getPage({page_id: p.page_id})).revision, 2);
  assert.deepEqual((await s.history({page_id: p.page_id})).revisions.map(r => r.revision), [2, 1]);
});
