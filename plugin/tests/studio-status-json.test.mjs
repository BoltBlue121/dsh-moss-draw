import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {createStudioStore} from '../src/studio-store.mjs';
import {emptyStudioDoc} from '../src/studio-domain.mjs';
import {handleStudioAction} from '../src/studio-host.mjs';
import {registerTools} from '../src/tools.mjs';
import {createStore} from '../src/store.mjs';
import {createService, normalizeInput} from '../src/core.mjs';
import {createRegionService} from '../src/regions.mjs';
import {createStudioTaskView} from '../client/studio-task-view.mjs';

// defineTool.execute validates arguments only. Exercise the installed runtime's
// actual output boundary as well when running under Electron RUN_AS_NODE.
let sdkTools = {defineTool: value => value}, sdkRuntime;
if (process.env.MOSS_SDK_PACKAGE) {
  const require = createRequire(process.env.MOSS_SDK_PACKAGE);
  sdkTools = require('@deepseek-ai/dsh-tools');
  const {Context} = require('@deepseek-ai/cordis');
  const ctx = new Context();
  ctx.provide('systemPrompt', {tools() {}});
  sdkRuntime = new sdkTools.ToolRuntime(ctx);
}

function assertJson(value, field = '$') {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number') return assert.ok(Number.isFinite(value), `${field}: nonfinite number`);
  assert.equal(typeof value, 'object', `${field}: non-JSON ${typeof value}`);
  assert.ok(Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)), `${field}: non-JSON object`);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assert.ok(Object.hasOwn(value, i), `${field}[${i}]: sparse array`);
      assertJson(value[i], `${field}[${i}]`);
    }
  } else {
    for (const [key, entry] of Object.entries(value)) assertJson(entry, `${field}.${key}`);
  }
}

async function fixture(t) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'studio-status-json-'));
  t.after(() => {
    assert.equal(path.dirname(dataRoot), path.resolve(tmpdir()));
    assert.ok(path.basename(dataRoot).startsWith('studio-status-json-'));
    return rm(dataRoot, {recursive: true, force: true});
  });
  const studio = createStudioStore({dataRoot});
  const series = await studio.createSeries({title: 'Status JSON regression'});
  const doc = emptyStudioDoc('caption');
  doc.caption.caption = 'A blue cup with a gold rim.';
  const created = await studio.createPage({series_id: series.series_id, title: 'Cup', doc});
  const page = await studio.startTask({page_id: created.page_id, expected_revision: created.revision, intent: 'Inspect status only', max_runs: 1});
  const plan = await studio.preparePlan({page_id: page.page_id, expected_revision: page.revision, request_key: 'status-fixture', settings: {seed: 42}, assets: []});
  const runId = randomUUID();
  let observations = 0;
  const noGpu = () => { throw Error('Status queries must not submit or advance a GPU job'); };
  const entry = {dataRoot, studio, service: {generate: noGpu, run: noGpu, context: async () => { observations++; return {runs: []}; }}};
  const definitions = new Map();
  registerTools({tools: {register: tool => definitions.set(tool.name, tool)}}, {
    sdk: {tools: sdkTools}, getService: () => entry, readGuide: async () => ({}),
    config: {workspaceRoot: dataRoot, dataRoot}, attachments: {},
  });
  const exec = {agent: {session: {deriveMessages: () => []}}, signal: new AbortController().signal};
  const args = {studio_page_id: page.page_id, studio_status: true};
  const tool = definitions.get('art_context');
  const status = async () => {
    const value = await tool.execute(args, exec);
    return sdkRuntime ? sdkRuntime.createSuccessResult({...exec, arguments: args, token: {}}, tool, value).value : value;
  };
  const uiStatus = () => handleStudioAction(entry, 'studioTaskStatus', {page_id: page.page_id}, exec.signal, {actor: 'ui'});
  const bindRun = async run => {
    await studio.claimPlan({plan_id: plan.plan_id});
    await studio.finishPlan({plan_id: plan.plan_id, run_id: runId, status: 'succeeded'});
    entry.service.context = async () => { observations++; return {runs: [run ?? {run_id: runId, status: 'succeeded'}]}; };
  };
  return {dataRoot, studio, page, plan, runId, entry, status, uiStatus, bindRun, tool, exec, args, noGpu, observations: () => observations};
}

// A missing error/review is normal for successful and not-yet-reviewed runs.
// Unconditionally materializing their undefined values must break this test.
test('studio status with a run lacking error and review remains lossless JSON', async t => {
  const f = await fixture(t);
  await f.bindRun();
  const result = await f.status();
  assertJson(result);
  assert.equal(result.plans[0].run.run_id, f.runId);
  assert.equal(result.plans[0].run.status, 'succeeded');
  for (const key of ['params', 'artifact', 'error']) assert.equal(Object.hasOwn(result.plans[0].run, key), false);
  assert.equal(result.plans[0].run.context?.review, undefined);
  assert.equal(f.observations(), 1);
});

test('prepared plans without runs stay JSON and never observe the service', async t => {
  const f = await fixture(t), result = await f.status();
  assertJson(result);
  assert.equal(result.plans[0].status, 'prepared');
  assert.equal(result.plans[0].run_id, null);
  assert.equal(Object.hasOwn(result.plans[0], 'run'), false);
  assert.equal(result.plans[0].effective.prompt, 'A blue cup with a gold rim.');
  assert.equal(f.observations(), 0);
});

test('pagePlans does not invent undefined fields for sparse persisted optional fields', async t => {
  const f = await fixture(t);
  const sparse = {plan_id: f.plan.plan_id, page_id: f.page.page_id, page_revision: f.page.revision, status: 'prepared'};
  // Model an older persisted plan using the real SQLite/read/projection path.
  const db = new DatabaseSync(path.join(f.dataRoot, 'studio', 'editor.sqlite'));
  try { db.prepare('UPDATE studio_plans SET value=? WHERE plan_id=?').run(JSON.stringify(sparse), f.plan.plan_id); }
  finally { db.close(); }
  const listed = await f.studio.pagePlans({page_id: f.page.page_id});
  assertJson(listed);
  assert.deepEqual(listed.plans, [{plan_id: f.plan.plan_id, page_revision: f.page.revision, status: 'prepared'}]);
  const result = await f.status();
  assertJson(result);
  assert.equal(result.plans[0].status, 'prepared');
  assert.equal(f.observations(), 0);
});

test('real core context nested optional fields preserve complete prompt and review', async t => {
  const f = await fixture(t);
  await f.bindRun();
  const prompt = '细'.repeat(12000), negative = 'blur, incorrect stitching';
  const params = {...normalizeInput({request_id: 'saved-status', prompt, negative, seed: 0}), characters: [{prompt: 'One adult with a blue coat.', style: 'none', lora_strength: 0}]};
  // Historical service records can omit optional parent_run_id; core.context
  // constructs an own undefined property nested inside context for this shape.
  delete params.parent_run_id;
  const store = createStore(f.dataRoot), at = '2026-10-27T00:00:00.000Z';
  await store.write({schemaVersion: 1, run_id: f.runId, input_hash: 'status-fixture', status: 'succeeded', params, created_at: at, updated_at: at,
    artifact: {path: path.join(f.dataRoot, 'not-opened.png'), sha256: 'a'.repeat(64), width: 1024, height: 1024}});
  const service = createService({dataRoot: f.dataRoot, comfyUrl: 'http://fixture.invalid', fetchImpl: f.noGpu});
  const review = (await service.review({run_id: f.runId, observations: ['审'.repeat(500), 'Gold rim remains visible'], issues: ['Minor edge seam'], next_change: '改'.repeat(500)})).review;
  f.entry.service = service;
  const raw = (await service.context({run_id: f.runId})).runs[0];
  assert.equal(Object.hasOwn(raw.context, 'parent_run_id'), true);
  assert.equal(raw.context.parent_run_id, undefined);
  const result = await f.status(), run = result.plans[0].run;
  assertJson(result);
  assert.equal(run.context.prompt, prompt);
  assert.equal(run.context.negative, negative);
  assert.deepEqual(run.context.review, review);
  assert.deepEqual(run.context.characters, [{prompt: 'One adult with a blue coat.', style: 'none', lora_strength: 0}]);
  assert.equal(Object.hasOwn(run.context, 'parent_run_id'), false);
  assert.equal(run.artifact.sha256, 'a'.repeat(64));
});

test('nested object optionals are omitted without dropping null zero false or review fields', async t => {
  const f = await fixture(t), review = {observations: ['All seams inspected'], issues: [], next_change: '', updated_at: '2026-10-27T00:00:00.000Z'};
  await f.bindRun({run_id: f.runId, status: 'failed', params: {seed: 0, characters: [{prompt: 'An adult', x: undefined, y: 0, style: 'none', lora_strength: 0}]},
    artifact: null, context: {prompt: 'Unabridged prompt', parent_run_id: null, review: {...review, optional: undefined}, checks: [], optional: undefined},
    error: {code: 'EXECUTION_FAILED', message: 'Failed safely', retryable: false, detail: undefined}, private_runtime_field: new Map()});
  const result = await f.status(), run = result.plans[0].run;
  assertJson(result);
  assert.deepEqual(run.params, {seed: 0, characters: [{prompt: 'An adult', y: 0, style: 'none', lora_strength: 0}]});
  assert.equal(run.artifact, null);
  assert.equal(run.context.parent_run_id, null);
  assert.deepEqual(run.context.review, review);
  assert.deepEqual(run.error, {code: 'EXECUTION_FAILED', message: 'Failed safely', retryable: false});
  assert.equal(Object.hasOwn(run, 'private_runtime_field'), false);
});

test('real regional top-level review remains visible in UI status with existing context', async t => {
  const f = await fixture(t);
  await f.bindRun();
  const at = '2026-10-27T00:00:00.000Z', prompt = 'Keep every regional prompt detail. '.repeat(150);
  const artifact = {path: path.join(f.dataRoot, 'not-opened.png'), sha256: 'b'.repeat(64), width: 512, height: 512};
  const region = {id: 'coat', box: [32, 64, 256, 384], reference_index: 1, prompt, style: 'none', lora_strength: 0, seed: 0, context_px: 64, feather_px: 8, steps: 30, cfg: 4, qwen_prompt: ''};
  const params = {request_id: 'regional-status', backend: 'moss', mode: 'regions', width: 512, height: 512, prompt, negative: '', brief: 'Coat edit', checks: ['Original border unchanged'], parent_run_id: null, regions: [region], qwen_full_prompt: ''};
  await createStore(path.join(f.dataRoot, 'region-pipelines')).write({schemaVersion: 1, run_id: f.runId, input_hash: 'regional-status-fixture', status: 'succeeded', params, edit_engine: 'native', created_at: at, updated_at: at,
    cursor: 1, phase: 'edit', history: [], preview_artifact: artifact, artifact});
  const service = createRegionService({dataRoot: f.dataRoot, childService: {generate: f.noGpu, run: f.noGpu}});
  const review = (await service.review({run_id: f.runId, observations: ['All original seams preserved'], issues: ['Tiny highlight mismatch'], next_change: 'Keep current framing'})).review;
  f.entry.service = service;
  const result = await f.status();
  assertJson(result);
  assert.deepEqual(result.plans[0].run.context.review, review);
  assert.deepEqual(result.plans[0].run.params.regions, [region]);
  assert.equal(result.plans[0].run.params.prompt, prompt);
  const ui = await f.uiStatus();
  assertJson(ui);
  assert.deepEqual(ui.plans[0].run.context.review, review);
  const React = {createElement: (type, props, ...children) => ({type, props, children: children.flat(Infinity)}), useState: value => [value, () => {}], useEffect() {}};
  const tree = createStudioTaskView(React)({model: {}, state: {page: ui.page, taskPlans: ui.plans}});
  const text = [];
  const visit = node => { if (typeof node === 'string') text.push(node); else node?.children?.forEach(visit); };
  visit(tree);
  assert.ok(text.includes('All original seams preserved'));
  assert.ok(text.includes('Tiny highlight mismatch'));
  assert.ok(text.includes('Keep current framing'));
});

test('service observation failures remain JSON-safe without leaking exception details', async t => {
  const f = await fixture(t);
  await f.bindRun();
  f.entry.service.context = async () => { throw Error('private transport diagnostic'); };
  const result = await f.status();
  assertJson(result);
  assert.equal(result.plans[0].observation_error, 'Run status temporarily unavailable.');
  assert.equal(Object.hasOwn(result.plans[0], 'run'), false);
});

for (const [label, invalid] of [
  ['NaN', NaN], ['Infinity', Infinity], ['negative Infinity', -Infinity], ['negative zero', -0], ['bigint', 1n],
  ['Date', new Date('2026-10-27T00:00:00.000Z')], ['sparse array', [, 'present']], ['undefined array item', [undefined]],
]) {
  test(`status projection rejects ${label} instead of silently laundering invalid data`, async t => {
    const f = await fixture(t);
    await f.bindRun({run_id: f.runId, status: 'succeeded', params: {seed: invalid}});
    await assert.rejects(f.status(), /STUDIO_STATUS_INVALID_JSON/);
    await assert.rejects(f.uiStatus(), {code: 'STUDIO_STATUS_INVALID_JSON'});
  });
}

test('installed SDK output boundary rejects the original undefined-field shape', {skip: !sdkRuntime}, async t => {
  const f = await fixture(t);
  assert.throws(() => sdkRuntime.createSuccessResult({...f.exec, arguments: f.args, token: {}}, f.tool,
    {plans: [{run: {run_id: f.runId, status: 'succeeded', error: undefined, context: {review: undefined}}}]}),
  /tool "art_context" returned invalid output: value is not lossless JSON/);
});
