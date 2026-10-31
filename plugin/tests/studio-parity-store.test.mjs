import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, stat, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

import {createStudioStore} from '../src/studio-store.mjs';

const item = (id, extra = {}) => ({id, label: 'object', caption: `Item ${id}`, bbox: [16, 16, 96, 96], ...extra});
const doc = (items = [item('a')]) => ({
  kind: 'layout',
  layout: {width: 320, height: 256, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: {caption: 'A quiet garden.'}, items},
  caption: {caption: 'Original plain caption.'},
});

async function fixture(t, initial = doc()) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'studio-parity-store-'));
  t.after(() => rm(dataRoot, {recursive: true, force: true}));
  const store = createStudioStore({dataRoot});
  const series = await store.createSeries({title: 'Series'});
  const page = await store.createPage({series_id: series.series_id, title: 'Page', doc: initial});
  return {dataRoot, store, series, page};
}
const latest = page => page.proposals.at(-1);

test('locked identity allows proposing/merging unlocked deletions or additions before a locked item while rejecting locked modifications, deletions, unlocks, or cross-locked reorders', async t => {
  const {store: s, page: p} = await fixture(t, doc([item('u1'), item('lock1', {locked: true}), item('u2'), item('lock2', {locked: true})]));

  // Deleting unlocked item before locked item shifts lock1's index from 1 to 0, and adding u0 before lock1 shifts it; both must succeed.
  const proposedValid = doc([item('u0'), item('lock1', {locked: true}), item('u2', {caption: 'Edited u2'}), item('lock2', {locked: true}), item('u3')]);
  const pending = await s.propose({page_id: p.page_id, expected_revision: 1, doc: proposedValid, summary: 'Delete u1, add u0/u3, edit u2'});
  assert.equal(pending.revision, 2);

  // Partial accept of deleting u1 (which shifts lock1 index) must also succeed.
  const afterPartial = await s.resolve({
    page_id: p.page_id,
    expected_revision: 2,
    proposal_id: latest(pending).proposal_id,
    accept: ['item:u1', 'item:u0'],
  });
  assert.deepEqual(afterPartial.doc.layout.items.map(i => i.id), ['u0', 'lock1', 'u2', 'lock2']);
  assert.equal(latest(afterPartial).status, 'partial');

  // Reject modifying locked item content, unlocking it, deleting it, or reordering surviving common items across a locked item.
  const baseItems = afterPartial.doc.layout.items;
  const badMutations = [
    [item('u0'), item('lock1', {locked: true, caption: 'Mutated'}), item('u2'), item('lock2', {locked: true})],
    [item('u0'), item('lock1', {locked: false}), item('u2'), item('lock2', {locked: true})],
    [item('u0'), item('u2'), item('lock2', {locked: true})],
    [item('lock1', {locked: true}), item('u0'), item('u2'), item('lock2', {locked: true})], // u0 moved after lock1
    [item('u0'), item('lock1', {locked: true}), item('lock2', {locked: true}), item('u2')], // u2 moved after lock2
    [item('u0'), item('lock2', {locked: true}), item('u2'), item('lock1', {locked: true})], // lock1 and lock2 swapped
  ];
  for (const items of badMutations) {
    await assert.rejects(
      s.propose({page_id: p.page_id, expected_revision: afterPartial.revision, doc: doc(items), summary: 'Illegal locked change'}),
      {code: 'STUDIO_LOCKED'},
    );
  }
  assert.deepEqual((await s.getPage({page_id: p.page_id})).doc.layout.items, baseItems);

  // Human updatePage remains authoritative and is NOT guarded by lockedUnchanged (can unlock, reorder, or delete locked items directly).
  const manualUpdated = await s.updatePage({
    page_id: p.page_id,
    expected_revision: afterPartial.revision,
    doc: doc([item('lock2', {locked: false, caption: 'Manually unlocked and moved'})]),
  });
  assert.equal(manualUpdated.revision, afterPartial.revision + 1);
  assert.deepEqual(manualUpdated.doc.layout.items.map(i => [i.id, i.locked]), [['lock2', false]]);
});

test('layout.order selector reorders retained items without applying unselected item content changes, additions, or removals', async t => {
  const {store: s, page: p} = await fixture(t, doc([item('a'), item('b'), item('c')]));
  const proposed = doc([
    item('c', {caption: 'Changed C'}),
    item('new1'),
    item('a', {caption: 'Changed A'}),
  ]); // b is removed in proposed, new1 is added, c and a reordered and edited
  const pending = await s.propose({page_id: p.page_id, expected_revision: 1, doc: proposed, summary: 'Reorder and edit'});

  // Accepting ONLY layout.order reorders surviving proposed items (c before a), keeps unaccepted removal 'b' anchored after its nearest preceding retained proposed item ('a' was before 'b' in current? Wait: in current ['a','b','c'], nearest preceding retained proposed item of 'b' is 'a'), and does NOT apply caption edits or add 'new1'.
  const resolved = await s.resolve({
    page_id: p.page_id,
    expected_revision: 2,
    proposal_id: latest(pending).proposal_id,
    accept: ['layout.order'],
  });
  assert.equal(latest(resolved).status, 'partial');
  assert.deepEqual(resolved.doc.layout.items.map(i => i.id), ['c', 'a', 'b']);
  assert.equal(resolved.doc.layout.items.find(i => i.id === 'c').caption, 'Item c');
  assert.equal(resolved.doc.layout.items.find(i => i.id === 'a').caption, 'Item a');
});

test('layout.order can be combined with specific item selectors, and untouched removed items stay anchored to their nearest preceding retained proposed item', async t => {
  const {store: s, page: p} = await fixture(t, doc([item('u0'), item('a'), item('u1'), item('u2'), item('b')]));
  // In proposed: u0, u1, u2 are removed; b and a are reordered to [b, a], and 'a' caption is changed, 'b' caption is changed.
  const proposed = doc([item('b', {caption: 'B2'}), item('a', {caption: 'A2'})]);
  const pending = await s.propose({page_id: p.page_id, expected_revision: 1, doc: proposed, summary: 'Reorder b, a and remove u0, u1, u2'});

  // Accept layout.order + item:a (content change) + item:u1 (removal), leaving u0 and u2 retained!
  // In current: u0 has no preceding proposed item -> goes before all proposed items.
  // u2's nearest preceding retained proposed item in current is 'a' -> follows 'a'.
  const resolved = await s.resolve({
    page_id: p.page_id,
    expected_revision: 2,
    proposal_id: latest(pending).proposal_id,
    accept: ['layout.order', 'item:a', 'item:u1'],
  });
  assert.equal(latest(resolved).status, 'partial');
  assert.deepEqual(resolved.doc.layout.items.map(i => i.id), ['u0', 'b', 'a', 'u2']);
  assert.equal(resolved.doc.layout.items.find(i => i.id === 'a').caption, 'A2');
  assert.equal(resolved.doc.layout.items.find(i => i.id === 'b').caption, 'Item b');
});

test('item additions insert after nearest preceding retained proposed item in proposed order regardless of accept array order', async t => {
  const {store: s, page: p1} = await fixture(t, doc([item('x'), item('y')]));
  // Proposed: [add0, x, addA, addB, y]
  const proposed = doc([item('add0'), item('x'), item('addA'), item('addB'), item('y')]);
  const pending1 = await s.propose({page_id: p1.page_id, expected_revision: 1, doc: proposed, summary: 'Insert items'});
  const r1 = await s.resolve({
    page_id: p1.page_id,
    expected_revision: 2,
    proposal_id: latest(pending1).proposal_id,
    accept: ['item:addB', 'item:add0', 'item:addA'],
  });
  assert.deepEqual(r1.doc.layout.items.map(i => i.id), ['add0', 'x', 'addA', 'addB', 'y']);
  assert.equal(latest(r1).status, 'accepted');

  // Second page with identical proposal, accepted in reverse selector order -> identical item order
  const p2 = await s.createPage({series_id: p1.series_id, title: 'Page 2', doc: doc([item('x'), item('y')])});
  const pending2 = await s.propose({page_id: p2.page_id, expected_revision: 1, doc: proposed, summary: 'Insert items'});
  const r2 = await s.resolve({
    page_id: p2.page_id,
    expected_revision: 2,
    proposal_id: latest(pending2).proposal_id,
    accept: ['item:addA', 'item:addB', 'item:add0'],
  });
  assert.deepEqual(r2.doc.layout.items.map(i => i.id), ['add0', 'x', 'addA', 'addB', 'y']);
});

test('selector validation rejects unchanged layout.order and rejects combining layout.items with layout.order or item selectors', async t => {
  const {store: s, page: p} = await fixture(t, doc([item('a'), item('b')]));
  const proposed = doc([item('a', {caption: 'A2'}), item('b')]);
  const pending = await s.propose({page_id: p.page_id, expected_revision: 1, doc: proposed, summary: 'No order change'});
  const pid = latest(pending).proposal_id;

  await assert.rejects(
    s.resolve({page_id: p.page_id, expected_revision: 2, proposal_id: pid, accept: ['layout.order']}),
    {code: 'STUDIO_INVALID_INPUT', message: /Order was not changed/i},
  );
  await assert.rejects(
    s.resolve({page_id: p.page_id, expected_revision: 2, proposal_id: pid, accept: ['layout.items', 'layout.order']}),
    {code: 'STUDIO_INVALID_INPUT', message: /combine layout\.items/i},
  );
});

test('proposal status is accepted when all changes are covered (via granular or legacy layout.items), partial for proper subset, and closes once', async t => {
  const {store: s, page: p} = await fixture(t, doc([item('a'), item('b')]));
  const proposed = doc([item('b', {caption: 'B2'}), item('a')]);
  proposed.caption.caption = 'New caption';

  // 1. Legacy layout.items + caption covers all changes -> 'accepted'
  let pending = await s.propose({page_id: p.page_id, expected_revision: p.revision, doc: proposed, summary: 'Full via legacy'});
  let resolved = await s.resolve({
    page_id: p.page_id,
    expected_revision: pending.revision,
    proposal_id: latest(pending).proposal_id,
    accept: ['layout.items', 'caption'],
  });
  assert.equal(latest(resolved).status, 'accepted');

  // 2. Subset via item:b only (leaving layout.order and caption unaccepted) -> 'partial' and closed once
  const nextProposed = doc([item('a', {caption: 'A3'}), item('b', {caption: 'B3'})]);
  nextProposed.caption.caption = 'Another caption';
  pending = await s.propose({page_id: p.page_id, expected_revision: resolved.revision, doc: nextProposed, summary: 'Partial'});
  const pid = latest(pending).proposal_id;
  resolved = await s.resolve({
    page_id: p.page_id,
    expected_revision: pending.revision,
    proposal_id: pid,
    accept: ['item:a'],
  });
  assert.equal(latest(resolved).status, 'partial');
  assert.deepEqual(latest(resolved).accepted, ['item:a']);
  // Resolving again fails with STUDIO_CONFLICT
  await assert.rejects(
    s.resolve({page_id: p.page_id, expected_revision: resolved.revision, proposal_id: pid, accept: ['layout.order']}),
    {code: 'STUDIO_CONFLICT'},
  );
});

test('readonly history with revision returns single snapshot without changing head, pending proposals, or file mtime', async t => {
  const {dataRoot, store: s, page: p} = await fixture(t, doc([item('a')]));
  const updatedDoc = doc([item('a', {caption: 'Updated in r2'})]);
  await s.updatePage({page_id: p.page_id, expected_revision: 1, title: 'Title r2', doc: updatedDoc});
  const propDoc = doc([item('a', {caption: 'Proposed in r3'})]);
  const afterPropose = await s.propose({page_id: p.page_id, expected_revision: 2, doc: propDoc, summary: 'Pending proposal'});
  assert.equal(afterPropose.revision, 3);

  const dbFile = path.join(dataRoot, 'studio', 'editor.sqlite');
  const beforeStat = await stat(dbFile);
  const beforeBytes = await readFile(dbFile);

  // List metadata without revision
  const list = await s.history({page_id: p.page_id});
  assert.deepEqual(list.revisions.map(r => [r.revision, r.operation]), [[3, 'propose'], [2, 'update'], [1, 'create']]);

  // Single revision snapshot read
  const rev1 = await s.history({page_id: p.page_id, revision: 1});
  assert.deepEqual(Object.keys(rev1).sort(), ['created_at', 'operation', 'revision', 'snapshot']);
  assert.equal(rev1.revision, 1);
  assert.equal(rev1.operation, 'create');
  assert.deepEqual(rev1.snapshot, {title: 'Page', doc: doc([item('a')])});

  const rev2 = await s.history({page_id: p.page_id, revision: 2});
  assert.equal(rev2.revision, 2);
  assert.equal(rev2.operation, 'update');
  assert.deepEqual(rev2.snapshot, {title: 'Title r2', doc: updatedDoc});

  // Verify head, pending proposal, and DB file bytes/mtime are untouched
  const current = await s.getPage({page_id: p.page_id});
  assert.equal(current.revision, 3);
  assert.equal(latest(current).status, 'pending');
  assert.equal((await stat(dbFile)).mtimeMs, beforeStat.mtimeMs);
  assert.deepEqual(await readFile(dbFile), beforeBytes);

  // Invalid or missing revision / deleted page
  for (const badRev of [0, -1, 1.5, '1', null, NaN]) {
    await assert.rejects(s.history({page_id: p.page_id, revision: badRev}), {code: 'STUDIO_INVALID_INPUT'});
  }
  await assert.rejects(s.history({page_id: p.page_id, revision: 99}), {code: 'STUDIO_NOT_FOUND'});
  await assert.rejects(s.history({page_id: randomUUID(), revision: 1}), {code: 'STUDIO_NOT_FOUND'});

  // Non-existent DB history read returns STUDIO_NOT_FOUND without creating studio directory or editor.sqlite
  const missingRoot = await mkdtemp(path.join(tmpdir(), 'studio-missing-history-'));
  t.after(() => rm(missingRoot, {recursive: true, force: true}));
  const missingStore = createStudioStore({dataRoot: missingRoot});
  await assert.rejects(missingStore.history({page_id: randomUUID(), revision: 1}), {code: 'STUDIO_NOT_FOUND'});
  await assert.rejects(stat(path.join(missingRoot, 'studio')), {code: 'ENOENT'});

  await s.deletePage({page_id: p.page_id, expected_revision: 3});
  await assert.rejects(s.history({page_id: p.page_id}), {code: 'STUDIO_NOT_FOUND'});
  await assert.rejects(s.history({page_id: p.page_id, revision: 1}), {code: 'STUDIO_NOT_FOUND'});
});

test('state reports features capability flags on empty and populated DBs and tracks pending_proposals count accurately', async t => {
  const emptyRoot = await mkdtemp(path.join(tmpdir(), 'studio-empty-state-'));
  t.after(() => rm(emptyRoot, {recursive: true, force: true}));
  const emptyStore = createStudioStore({dataRoot: emptyRoot});
  const emptyState = await emptyStore.state({});
  assert.deepEqual(emptyState, {
    series: [],
    pages: [],
    page_total: 0,
    next_offset: null,
    features: {proposal_order: true, history_preview: true},
  });

  const {store: s, page: p} = await fixture(t);
  let st = await s.state({});
  assert.deepEqual(st.features, {proposal_order: true, history_preview: true});
  assert.equal(st.pages[0].pending_proposals, 0);
  assert.equal(Object.hasOwn(st.pages[0], 'doc'), false);

  // Create a pending proposal -> count becomes 1
  const prop1 = doc([item('a', {caption: 'P1'})]);
  const afterP1 = await s.propose({page_id: p.page_id, expected_revision: 1, doc: prop1, summary: 'P1'});
  st = await s.state({});
  assert.equal(st.pages[0].pending_proposals, 1);

  // Supersede with another proposal -> first becomes stale, count stays 1
  const prop2 = doc([item('a', {caption: 'P2'})]);
  const afterP2 = await s.propose({page_id: p.page_id, expected_revision: afterP1.revision, doc: prop2, summary: 'P2'});
  st = await s.state({});
  assert.equal(st.pages[0].pending_proposals, 1);

  // Resolve (accept/partial) -> count becomes 0
  await s.resolve({
    page_id: p.page_id,
    expected_revision: afterP2.revision,
    proposal_id: latest(afterP2).proposal_id,
    accept: ['item:a'],
  });
  st = await s.state({});
  assert.equal(st.pages[0].pending_proposals, 0);

  // Propose again then manual updatePage stales it -> count becomes 0
  const afterP3 = await s.propose({page_id: p.page_id, expected_revision: 4, doc: prop1, summary: 'P3'});
  assert.equal((await s.state({})).pages[0].pending_proposals, 1);
  await s.updatePage({page_id: p.page_id, expected_revision: afterP3.revision, doc: prop1});
  assert.equal((await s.state({})).pages[0].pending_proposals, 0);
});
