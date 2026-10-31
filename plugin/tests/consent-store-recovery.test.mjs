import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createStudioStore} from '../src/studio-store.mjs';
import {emptyStudioDoc} from '../src/studio-domain.mjs';

const SESSION = 'recovery-session';
const ops = patch => ({proposal: null, resume: false, exit_text_only: false,
  generation: {mode: 'none', runs: 0, backend: null, intent: ''}, continue_generation: false, ...patch});
const drawOps = () => ops({generation: {mode: 'use_remaining', runs: 0, backend: 'moss', intent: ''}, continue_generation: true});
async function fixture(t, {task = true} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'consent-store-recovery-'));
  t.after(async () => {
    assert.equal(path.dirname(root), tmpdir());
    assert.ok(path.basename(root).startsWith('consent-store-recovery-'));
    await rm(root, {recursive: true, force: true});
  });
  const s = createStudioStore({dataRoot: root});
  const series = await s.createSeries({title: 'S'}), doc = emptyStudioDoc();
  doc.layout.summary.caption = 'Room';
  doc.layout.items = [{id: 'hero', label: 'character', caption: 'Person', bbox: [100, 100, 600, 900]}];
  let page = await s.createPage({series_id: series.series_id, title: 'P', doc});
  if (task) page = await s.startTask({page_id: page.page_id, expected_revision: page.revision,
    intent: 'Original request', max_runs: 2}, {message_id: 'origin'});
  const mutate = fn => {
    const db = new DatabaseSync(path.join(root, 'studio/editor.sqlite'));
    try { db.exec('BEGIN IMMEDIATE'); fn(db); db.exec('COMMIT'); } finally { db.close(); }
  };
  const patchConsent = (id, fn) => mutate(db => {
    const value = JSON.parse(db.prepare('SELECT value FROM studio_consents WHERE consent_id=?').get(id).value);
    fn(value);
    db.prepare('UPDATE studio_consents SET value=? WHERE consent_id=?').run(JSON.stringify(value), id);
  });
  const ask = (operation = drawOps(), key = 'ask', session = SESSION, target = page) => s.requestConsent({
    page_id: target.page_id, expected_revision: target.revision, request_key: key, operations: operation,
  }, {session_id: session, message_id: 'request'});
  const evidence = (message_id, reply_only = false, session_id = SESSION) => ({session_id, message_id, reply_only, decisions: {}});
  const approve = consent => ({session_id: SESSION, evidence: {...evidence('yes', true), decisions: {
    [consent.consent_id]: {status: 'approved', message_id: 'yes', question_message_id: 'question', request_digest: consent.presentation_digest},
  }}});
  return {s, root, page, doc, series, mutate, patchConsent, ask, evidence, approve};
}

for (const change of ['expiry', 'invalid-expiry', 'revision', 'budget', 'policy']) {
  test(`${change} makes pending ineffective for new work instead of locking all generation`, async t => {
    const f = await fixture(t), {consent} = await f.ask();
    if (change === 'expiry') f.patchConsent(consent.consent_id, c => { c.expires_at = '2000-01-01T00:00:00.000Z'; });
    if (change === 'invalid-expiry') f.patchConsent(consent.consent_id, c => { c.expires_at = 'not-a-date'; });
    if (change === 'revision') f.mutate(db => db.prepare('UPDATE studio_pages SET revision=revision+1 WHERE page_id=?').run(f.page.page_id));
    if (change === 'budget') f.mutate(db => {
      const task = JSON.parse(db.prepare('SELECT value FROM studio_tasks WHERE page_id=?').get(f.page.page_id).value);
      task.max_runs++;
      db.prepare('UPDATE studio_tasks SET value=? WHERE page_id=?').run(JSON.stringify(task), f.page.page_id);
    });
    if (change === 'policy') f.mutate(db => db.prepare('INSERT INTO studio_page_policy VALUES(?,?)').run(f.page.page_id, JSON.stringify({policy: {mode: 'descriptions', item_ids: [], summary: false, caption: false, text: false}})));
    await f.s.assertConsentGeneration({message_id: 'new-request', page_id: f.page.page_id, action: 'raw'});
    assert.ok(['stale', 'expired'].includes((await f.s.consentState({page_id: f.page.page_id})).consent.status));
  });
}

test('a different page is not blocked by an unrelated unanswered consent', async t => {
  const f = await fixture(t), {consent} = await f.ask();
  const other = await f.s.createPage({series_id: f.series.series_id, title: 'Other', doc: f.doc});
  const started = await f.s.startTask({page_id: other.page_id, expected_revision: other.revision, intent: 'Other page'}, {message_id: 'other-request'});
  assert.equal(started.task.claimed_runs, 0);
  assert.equal((await f.s.consentState({page_id: f.page.page_id})).consent.consent_id, consent.consent_id);
  await assert.rejects(f.s.assertConsentGeneration({message_id: 'unknown', action: 'raw'}), {code: 'STUDIO_CONSENT_GENERATION'});
});

test('requests and guards are session scoped without superseding another session consent', async t => {
  const f = await fixture(t), {consent: first} = await f.ask();
  await f.ask(drawOps(), 'foreign', 'other-session');
  await f.s.assertConsentGeneration({message_id: 'third-request', action: 'raw'}, f.evidence('third-request', false, 'third-session'));
  const applied = await f.s.applyConsent({consent_id: first.consent_id}, f.approve(first));
  assert.equal(applied.consent.status, 'applied');
});

test('new native substantive request supersedes pending but a short or qualified reply cannot spend old allowance', async t => {
  const f = await fixture(t), {consent} = await f.ask();
  await assert.rejects(f.s.assertConsentGeneration({message_id: 'reply', action: 'raw'}, f.evidence('reply', true)), {code: 'STUDIO_CONSENT_GENERATION'});
  assert.equal((await f.s.consentState({page_id: f.page.page_id})).consent.status, 'pending');
  await f.s.assertConsentGeneration({message_id: 'new-request', action: 'raw'}, f.evidence('new-request'));
  assert.equal((await f.s.consentState({page_id: f.page.page_id})).consent.status, 'stale');
  assert.notEqual((await f.s.applyConsent({consent_id: consent.consent_id}, f.approve(consent))).consent.status, 'applied');
  await assert.rejects(f.s.assertConsentGeneration({message_id: 'reply', action: 'raw'}, f.evidence('reply', true)), {code: 'STUDIO_CONSENT_GENERATION'});
});

test('manual nonce expiry rotates only the handshake under the same native approval', async t => {
  const f = await fixture(t);
  const takeover = await f.s.takeover({page_id: f.page.page_id, expected_revision: f.page.revision, client_id: 'owner'});
  f.page = takeover.page;
  const {consent} = await f.ask(ops({resume: true}), 'manual', SESSION, f.page);
  const proof = f.approve(consent), first = await f.s.applyConsent({consent_id: consent.consent_id}, proof);
  assert.equal(first.consent.status, 'awaiting_handoff');
  f.patchConsent(consent.consent_id, c => { c.handoff.expires_at = '2000-01-01T00:00:00.000Z'; });
  const second = await f.s.applyConsent({consent_id: consent.consent_id}, proof);
  assert.equal(second.consent.status, 'awaiting_handoff');
  assert.equal(second.consent.approved_message_id, 'yes');
  assert.notEqual(second.consent.handoff.nonce, first.consent.handoff.nonce);
  const ack = {consent_id: consent.consent_id, page_id: f.page.page_id, expected_revision: f.page.revision,
    nonce: first.consent.handoff.nonce, client_id: 'owner', lease_token: takeover.lease_token};
  await assert.rejects(f.s.ackConsentHandoff(ack), {code: 'STUDIO_CONSENT_HANDOFF'});
  await f.s.ackConsentHandoff({...ack, nonce: second.consent.handoff.nonce});
  const applied = await f.s.applyConsent({consent_id: consent.consent_id}, proof);
  assert.equal(applied.consent.status, 'applied');
  assert.equal(applied.page.task.control, 'auto');
  assert.equal(applied.page.task.max_runs, 2);
  assert.equal(applied.page.task.claimed_runs, 0);
  assert.deepEqual(await f.s.applyConsent({consent_id: consent.consent_id}, proof), applied);
});

test('taskless text updates do not create a task and cannot change structure or bypass review', async t => {
  const f = await fixture(t, {task: false}), doc = structuredClone(f.page.doc);
  doc.layout.summary.caption = 'New wording';
  const updated = await f.s.agentUpdate({page_id: f.page.page_id, expected_revision: f.page.revision, doc});
  assert.equal(updated.task, undefined);
  assert.equal(updated.doc.layout.summary.caption, 'New wording');
  for (const change of [d => { d.layout.items[0].bbox[0]++; }, d => { d.layout.items[0].locked = true; }, d => { d.layout.items[0].id = 'another'; }]) {
    const changed = structuredClone(updated.doc); change(changed);
    await assert.rejects(f.s.agentUpdate({page_id: updated.page_id, expected_revision: updated.revision, doc: changed}), {code: 'STUDIO_EDIT_SCOPE'});
  }
  const proposed = structuredClone(updated.doc); proposed.layout.summary.caption = 'Pending human review';
  const pending = await f.s.propose({page_id: updated.page_id, expected_revision: updated.revision, doc: proposed, summary: 'Review'});
  // Proposals no longer block agentUpdate when there is no task (taskless text remains valid).
  const reverted = await f.s.agentUpdate({page_id: pending.page_id, expected_revision: pending.revision, doc: updated.doc});
  assert.equal(reverted.doc.layout.summary.caption, 'New wording');
});
