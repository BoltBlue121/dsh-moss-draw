import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeInput, compileGraph, catalog } from '../src/core.mjs';
import { MOSS_SAMPLERS, MOSS_SCHEDULERS } from '../src/catalog.mjs';
import { normalizeMode } from '../src/modes.mjs';
import { NATIVE_EDIT_ADAPTER } from '../src/native-edit.mjs';
import { createStudioStore } from '../src/studio-store.mjs';
import { emptyStudioDoc } from '../src/studio-domain.mjs';

const id = 'bbb17a25-9c17-41f2-8614-9f57186c2c35';
const input = { request_id: 'sampler-req', prompt: 'A quiet studio portrait.' };
const ksampler = (params) => compileGraph(params, id)['10'].inputs;

test('t2i keeps euler/sgm_uniform/50 when the caller picks nothing', () => {
  const params = normalizeInput(input);
  assert.equal(params.sampler, 'euler');
  assert.equal(params.scheduler, 'sgm_uniform');
  assert.equal(params.steps, 50);
  assert.equal(ksampler(params).sampler_name, 'euler');
  assert.equal(ksampler(params).scheduler, 'sgm_uniform');
});

test('a caller-chosen sampler and scheduler reach the compiled KSampler node', () => {
  const params = normalizeInput({ ...input, sampler: 'dpmpp_2m', scheduler: 'karras', steps: 32 });
  assert.equal(params.sampler, 'dpmpp_2m');
  assert.equal(params.scheduler, 'karras');
  assert.equal(params.steps, 32);
  const node = ksampler(params);
  assert.equal(node.sampler_name, 'dpmpp_2m');
  assert.equal(node.scheduler, 'karras');
  assert.equal(node.steps, 32);
});

test('an unknown sampler is refused with the full list of usable names', () => {
  assert.throws(() => normalizeInput({ ...input, sampler: 'nope' }), (error) => {
    assert.equal(error.code, 'INVALID_INPUT');
    assert.match(error.message, /Unsupported sampler "nope"/);
    assert.match(error.message, /Use one of:/);
    assert.match(error.message, /dpmpp_2m/);
    return true;
  });
});

test('an unknown scheduler is refused with the full list of usable names', () => {
  assert.throws(() => normalizeInput({ ...input, scheduler: 'nope' }), (error) => {
    assert.equal(error.code, 'INVALID_INPUT');
    assert.match(error.message, /Unsupported scheduler "nope"/);
    assert.match(error.message, /Use one of:/);
    assert.match(error.message, /sgm_uniform/);
    return true;
  });
});

test('the catalog publishes every sampler and scheduler the worker really has', () => {
  const view = catalog();
  assert.deepEqual(view.samplers, [...MOSS_SAMPLERS]);
  assert.deepEqual(view.schedulers, [...MOSS_SCHEDULERS]);
  assert.ok(view.samplers.includes('euler') && view.samplers.includes('dpmpp_3m_sde'));
  assert.ok(view.schedulers.includes('sgm_uniform') && view.schedulers.includes('kl_optimal'));
  const t2i = view.modes.find((mode) => mode.id === 't2i');
  assert.ok(t2i.caller_selectable.includes('sampler') && t2i.caller_selectable.includes('scheduler'));
  assert.equal(view.defaults.sampler, 'euler');
  assert.equal(view.defaults.scheduler, 'sgm_uniform');
});

test('workbench t2i settings accept sampler/scheduler and freeze them into the plan', async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'sampler-studio-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = createStudioStore({ dataRoot });
  const series = await store.createSeries({ title: 'Sampler page' });
  const doc = emptyStudioDoc('caption');
  doc.caption.caption = 'A blue cup.';
  const page = await store.createPage({ series_id: series.series_id, title: 'Cup', doc });
  const started = await store.startTask({ page_id: page.page_id, expected_revision: page.revision, intent: 'Draw a cup' });
  const plan = await store.preparePlan({
    page_id: page.page_id, expected_revision: started.revision, request_key: 'sampler-plan',
    settings: { backend: 'moss', mode: 't2i', seed: 42, sampler: 'uni_pc', scheduler: 'beta', steps: 24 }, assets: [],
  });
  assert.equal(plan.effective.sampler, 'uni_pc');
  assert.equal(plan.effective.scheduler, 'beta');
  assert.equal(plan.effective.steps, 24);
  assert.equal(plan.request.sampler, 'uni_pc');
  assert.equal(plan.request.scheduler, 'beta');
});

test('a non-t2i backend neither freezes sampler fields nor accepts them', async (t) => {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'sampler-k2-'));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  const store = createStudioStore({ dataRoot });
  const series = await store.createSeries({ title: 'K2 page' });
  const doc = emptyStudioDoc('caption');
  doc.caption.caption = 'A blue cup.';
  const page = await store.createPage({ series_id: series.series_id, title: 'Cup', doc });
  const started = await store.startTask({ page_id: page.page_id, expected_revision: page.revision, intent: 'Draw a cup' });
  // K2 has its own fixed sampler pair. Its effective params carry them, but the
  // frozen request must not, or replay would push a t2i-only field into K2.
  const plan = await store.preparePlan({
    page_id: page.page_id, expected_revision: started.revision, request_key: 'k2-plan',
    settings: { backend: 'k2', mode: 't2i', seed: 7 }, assets: [],
  });
  assert.ok(plan.effective.sampler);
  assert.equal(Object.hasOwn(plan.request, 'sampler'), false);
  assert.equal(Object.hasOwn(plan.request, 'scheduler'), false);
  await assert.rejects(store.preparePlan({
    page_id: page.page_id, expected_revision: started.revision, request_key: 'k2-sampler',
    settings: { backend: 'k2', mode: 't2i', seed: 8, sampler: 'euler' }, assets: [],
  }), (error) => {
    assert.equal(error.code, 'STUDIO_INVALID_INPUT');
    assert.match(error.message, /moss t2i only/);
    return true;
  });
});

test('modes without a KSampler choice refuse sampler fields and name their fixed pair', () => {
  assert.throws(() => normalizeMode({ mode: 'characters', request_id: 'r', prompt: 'p', sampler: 'euler', characters: [{ prompt: 'one adult' }] }, []), (error) => {
    assert.equal(error.code, 'INVALID_INPUT');
    assert.match(error.message, /t2i only/);
    assert.match(error.message, /sampler=euler, scheduler=simple/);
    return true;
  });
  assert.throws(() => NATIVE_EDIT_ADAPTER.normalize({ backend: 'moss', mode: 'edit', request_id: 'r', prompt: 'p', scheduler: 'karras' }, []), (error) => {
    assert.equal(error.code, 'INVALID_INPUT');
    assert.match(error.message, /t2i only/);
    assert.match(error.message, /MOSSImageScheduler|sgm_uniform/);
    return true;
  });
});
