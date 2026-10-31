import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createStudioStore } from '../src/studio-store.mjs';
import { emptyStudioDoc } from '../src/studio-domain.mjs';
import { createRegionService } from '../src/regions.mjs';
import { encodePng } from '../src/region-pixels.mjs';

const STYLE = 'SHARED_STYLE_SENTINEL';
const IDENTITY = 'CROP_A_IDENTITY_SENTINEL';
const OTHER_IDENTITY = 'CROP_B_IDENTITY_SENTINEL';
const SCENE = 'FULL_SCENE_SENTINEL';

async function captureFirstChild(t, engine) {
  const dataRoot = await mkdtemp(path.join(tmpdir(), 'studio-regions-shared-'));
  t.after(async () => {
    // Never remove a path other than this test's verified mkdtemp directory.
    assert.equal(path.dirname(dataRoot), tmpdir());
    assert.ok(path.basename(dataRoot).startsWith('studio-regions-shared-'));
    await rm(dataRoot, { recursive: true, force: true });
  });
  const store = createStudioStore({ dataRoot });
  const series = await store.createSeries({ title: 'Shared crop fixture' });
  const doc = emptyStudioDoc();
  doc.layout.width = 256;
  doc.layout.height = 256;
  doc.layout.summary.caption = SCENE;
  doc.layout.items = [
    { id: 'alice', label: 'character', caption: 'ACTION_A_SENTINEL', bbox: [0, 0, 128, 256] },
    { id: 'bob', label: 'character', caption: 'ACTION_B_SENTINEL', bbox: [128, 0, 256, 256] },
  ];
  const created = await store.createPage({ series_id: series.series_id, title: 'Two people', doc });
  const profile = await store.updateSeriesProfile({
    series_id: series.series_id, expected_revision: 0, style: STYLE,
    cast: [
      { character_id: 'a', name: 'Alice', description: IDENTITY },
      { character_id: 'b', name: 'Bob', description: OTHER_IDENTITY },
    ],
  });
  const applied = await store.applySeriesProfile({
    page_id: created.page_id, expected_revision: created.revision, profile_revision: profile.revision,
    bindings: [{ item_id: 'alice', character_id: 'a' }, { item_id: 'bob', character_id: 'b' }],
    caption_cast_ids: [],
  });
  const page = await store.startTask({
    page_id: applied.page_id, expected_revision: applied.revision, intent: 'Edit Alice only', max_runs: 1,
  });
  const data = encodePng({ width: 256, height: 256, pixels: Buffer.alloc(256 * 256 * 4, 255) });
  const assets = [0, 1].map(() => ({ data, mediaType: 'image/png', width: 256, height: 256 }));
  const metadata = assets.map(({ data: bytes, ...info }) => ({
    ...info, sha256: createHash('sha256').update(bytes).digest('hex'),
  }));
  const plan = await store.preparePlan({
    page_id: page.page_id, expected_revision: page.revision, request_key: `shared-${engine}`,
    settings: { backend: 'moss', mode: 'regions', seed: 1, region_bindings: [{ item_id: 'alice', reference_index: 1 }] },
    assets: metadata,
  }, assets, engine);
  const calls = [];
  const service = createRegionService({
    dataRoot: path.join(dataRoot, 'local-region-service'), editEngine: engine,
    childService: {
      async generate(input) {
        calls.push(structuredClone(input));
        // Local boundary spy only: do not generate pixels or access a worker.
        return { run_id: randomUUID(), status: 'running' };
      },
      async run() { assert.fail('First regional stage must not poll an existing child.'); },
    },
  });
  const { backend, ...request } = plan.request;
  assert.equal(backend, 'moss');
  const draft = await service.generate(request, assets);
  await service.generate({ mode: 'regions', action: 'execute', plan_id: draft.run_id });
  await service.run({ run_id: draft.run_id });
  assert.equal(calls.length, 1);
  return { plan, child: calls[0] };
}

for (const engine of ['legacy', 'native']) {
  test(`${engine} actual region child uses shared style and selected identity once without full-scene leakage`, async t => {
    const { plan, child } = await captureFirstChild(t, engine);
    assert.equal(child.prompt.split(STYLE).length - 1, 1, 'shared style must occur once in the actual child request');
    assert.equal(child.prompt.split(IDENTITY).length - 1, 1, 'bound card identity must occur once');
    assert.equal(child.prompt.includes(OTHER_IDENTITY), false, 'another visible item is not a cast reference for this crop');
    assert.equal(child.prompt.includes('ACTION_B_SENTINEL'), false, 'another item action must not leak into this crop');
    assert.equal(child.prompt.includes(SCENE), false, 'full-page summary must not become crop instructions');
    assert.equal(child.prompt.split('ACTION_A_SENTINEL').length - 1, 1);
    assert.equal(plan.prompt, plan.request.prompt, 'previewed plan prompt must match the frozen service request');
    assert.equal(plan.doc.layout.summary.caption, SCENE, 'the full scene stays in the frozen source document');
    assert.equal(plan.doc.shared.style, STYLE);
    assert.equal(plan.doc.shared.cast[1].description, OTHER_IDENTITY);
  });
}
