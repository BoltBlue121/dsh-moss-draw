import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStudioStore } from '../src/studio-store.mjs';
import { emptyStudioDoc } from '../src/studio-domain.mjs';
import { createRegionService } from '../src/regions.mjs';
import { encodePng } from '../src/region-pixels.mjs';
import { registerTools } from '../src/tools.mjs';
import { createWorkbenchBridge } from '../src/workbench-host.mjs';
import { createWorkbenchStore } from '../src/workbench-store.mjs';

const POLICY = { mode: 'descriptions', item_ids: [], summary: false, caption: true, text: false };

async function fixture(t) {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), 'studio-text-only-run-'));
  t.after(async () => {
    assert.equal(path.dirname(dataRoot), os.tmpdir());
    assert.ok(path.basename(dataRoot).startsWith('studio-text-only-run-'));
    await rm(dataRoot, { recursive: true, force: true });
  });
  const studio = createStudioStore({ dataRoot });
  const series = await studio.createSeries({ title: 'Text-only boundary' });
  const doc = emptyStudioDoc('caption');
  doc.caption.caption = 'Only update the description';
  let page = await studio.createPage({ series_id: series.series_id, title: 'Text', doc });
  async function protect() {
    page = await studio.setEditPolicy({ page_id: page.page_id, expected_revision: page.revision,
      policy: POLICY, editing_only: true });
    return page;
  }
  const generated = [];
  let polls = 0;
  const regional = createRegionService({
    dataRoot, editEngine: 'native',
    childService: {
      async generate(input) {
        generated.push(structuredClone(input));
        return { run_id: randomUUID(), status: 'failed', error: { code: 'LOCAL_FIXTURE_STOP', message: 'No GPU' } };
      },
      async run() { polls++; return { status: 'failed', error: { code: 'LOCAL_FIXTURE_STOP', message: 'No GPU' } }; },
    },
  });
  const data = encodePng({ width: 256, height: 256, pixels: Buffer.alloc(256 * 256 * 4, 255) });
  const assets = [0, 1].map(() => ({ data, mediaType: 'image/png', width: 256, height: 256 }));
  const entry = { dataRoot, studio, service: regional, workbench: createWorkbenchStore({ dataRoot }) };
  const definitions = new Map();
  registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, {
    sdk: { tools: { defineTool: value => value } }, getService: () => entry,
    config: { dataRoot, workspaceRoot: dataRoot, editEngine: 'native' },
    readGuide: async () => ({}), attachments: {},
  });
  const exec = { agent: { session: { deriveMessages: () => [] } }, signal: new AbortController().signal };
  const call = (name, input) => definitions.get(name).execute(input, exec);
  async function draft(execute = true) {
    const result = await regional.generate({ mode: 'regions', action: 'draft', request_id: randomUUID(),
      prompt: 'Regional edit', regions: [{ id: 'a', box: [0, 0, 128, 256], reference_index: 1, prompt: 'One person', seed: 1 }] }, assets);
    if (execute) await regional.generate({ mode: 'regions', action: 'execute', plan_id: result.run_id });
    return result;
  }
  return { entry, studio, regional, assets, generated, get polls() { return polls; }, protect, draft, call, exec };
}

test('unbound historical regional run cannot submit a new child while the Session is text-only', async t => {
  const f = await fixture(t), run = await f.draft();
  await f.protect();
  assert.equal(await f.studio.boundRun({ run_id: run.run_id }), null);
  await assert.rejects(f.call('art_run', { run_id: run.run_id }), /STUDIO_TEXT_ONLY/);
  assert.equal(f.generated.length, 0);
  assert.equal(f.polls, 0);
});

test('unbound regional stage checks the latest Session marker after art_run has started', async t => {
  const f = await fixture(t), run = await f.draft();
  f.entry.service = {
    async run(input, options) {
      await f.protect(); // Simulate human text-only selection while queued before regional advancement.
      return f.regional.run(input, options);
    },
  };
  await assert.rejects(f.call('art_run', { run_id: run.run_id }), /STUDIO_TEXT_ONLY/);
  assert.equal(f.generated.length, 0);
});

test('manual and paused Studio-bound regional runs still return paused without advancing', async t => {
  const f = await fixture(t);
  for (const control of ['manual', 'paused']) {
    let advanced = 0;
    f.entry.studio = { async boundRun() { return { mode: 'regions', control, plan_id: randomUUID() }; } };
    f.entry.service = { async run() { advanced++; throw new Error('Must not advance'); } };
    const result = await f.call('art_run', { run_id: randomUUID() });
    assert.equal(result.status, 'paused');
    assert.equal(advanced, 0);
  }
});

test('a bound regional run rechecks manual takeover at the actual next-stage boundary', async t => {
  const f = await fixture(t);
  let control = 'auto', submitted = 0;
  f.entry.studio = {
    async boundRun() { return { mode: 'regions', control, plan_id: randomUUID() }; },
    async taskState() { return { tasks: [] }; },
  };
  f.entry.service = {
    async run(_input, options) {
      control = 'manual';
      await options.beforeStage();
      submitted++;
      return { status: 'failed' };
    },
  };
  await assert.rejects(f.call('art_run', { run_id: randomUUID() }), /STUDIO_HUMAN_CONTROL/);
  assert.equal(submitted, 0);
});

test('text-only Session still permits observing already submitted non-regional results without stage submission', async t => {
  const f = await fixture(t);
  await f.protect();
  let observations = 0;
  const run_id = randomUUID();
  f.entry.service = { async run(input) { observations++; return { run_id: input.run_id, status: 'succeeded' }; } };
  const result = await f.call('art_run', { run_id });
  assert.equal(result.status, 'succeeded');
  assert.equal(observations, 1);
  assert.equal(f.generated.length, 0);
});

test('text-only Session still permits local regional drafts and does not advance art_context observations', async t => {
  const f = await fixture(t), draft = await f.draft(false);
  await f.protect();
  const result = await f.call('art_run', { run_id: draft.run_id });
  assert.equal(result.status, 'draft');
  const context = await f.call('art_context', { run_id: draft.run_id });
  assert.equal(context.runs[0].status, 'draft');
  assert.equal(f.generated.length, 0);
});

test('workbench materialize remains a GPU-free draft during text-only mode', async t => {
  const f = await fixture(t);
  await f.protect();
  const bridge = createWorkbenchBridge({ getEntry: () => f.entry, resolveReference: async () => f.assets[0] });
  const document = await bridge({ action: 'create', title: 'Legacy regions', canvas: { width: 256, height: 256, reference: 'base' },
    references: ['base', 'character'], prompt: 'A local composition',
    regions: [{ id: 'a', box: [0, 0, 128, 256], reference_index: 1, prompt: 'A person' }] }, f.exec, 'agent');
  const result = await f.call('art_generate', { mode: 'workbench', workbench: {
    action: 'materialize', document_id: document.document_id, expected_revision: document.revision,
  } });
  assert.equal(result.status, 'draft');
  assert.equal(f.generated.length, 0);
  assert.equal(f.polls, 0);
});
