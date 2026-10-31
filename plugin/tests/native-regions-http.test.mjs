import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDrawingService } from '../src/dispatcher.mjs';
import { registerTools } from '../src/tools.mjs';
import { waitForRun } from '../src/wait.mjs';
import { encodePng, decodePng } from '../src/region-pixels.mjs';

const WIDTH = 512, HEIGHT = 320;
const LEFT = [201, 36, 51, 255], RIGHT = [42, 173, 66, 255], REPAIRED = [48, 180, 72, 255];
const GLOBAL_PROMPT = 'GLOBAL_HEADCOUNT_ONLY: exactly two robots in the whole canvas, one left and one right.';
const REGIONS = [
  { id: 'left', box: [32, 32, 256, 288], reference_index: 1,
    prompt: 'Replace only the left mannequin using its assigned red design.',
    style: 'none', lora_strength: 0, seed: 120, context_px: 32, feather_px: 0 },
  { id: 'right', box: [256, 32, 480, 288], reference_index: 2,
    prompt: 'Replace only the right mannequin using its assigned green design.',
    style: 'none', lora_strength: 0, seed: 121, context_px: 32, feather_px: 0,
    qwen_prompt: '仅整理右侧角色边缘，保留绿色设计与裁切构图。' },
];
const sha = data => createHash('sha256').update(data).digest('hex');
const solid = (width, height, color) => encodePng({ width, height, pixels: Buffer.alloc(width * height * 4).fill(Buffer.from(color)) });
const inBox = (x, y, [left, top, right, bottom]) => x >= left && x < right && y >= top && y < bottom;

// Hand-built pixel oracles: no regionCrop/regionComposite/compiler calls build
// expected values. Transparent canvas pixels retain nonzero hidden RGB.
function basePixels() {
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
    pixels.set([13 + x % 7, 22 + y % 11, 35, [0, 127, 255][(x + y) % 3]], (y * WIDTH + x) * 4);
  }
  return pixels;
}
function expectedCanvas(base, changes) {
  const pixels = Buffer.from(base);
  for (const [box, color] of changes) {
    for (let y = box[1]; y < box[3]; y++) for (let x = box[0]; x < box[2]; x++) pixels.set(color, (y * WIDTH + x) * 4);
  }
  return pixels;
}
function expectedCrop(pixels, left) {
  // Literal geometry: both context crops are 288x320, at x=0 and x=224.
  const cropped = Buffer.alloc(288 * HEIGHT * 4);
  for (let y = 0; y < HEIGHT; y++) pixels.copy(cropped, y * 288 * 4, (y * WIDTH + left) * 4, (y * WIDTH + left + 288) * 4);
  return cropped;
}
function assertPixels(bytes, width, height, pixels, message) {
  const image = decodePng(bytes);
  assert.deepEqual([image.width, image.height], [width, height], message);
  assert.deepEqual(image.pixels, pixels, message);
}

// Exercise real createDrawingService -> createRegionService, stores, compilers,
// default fetch, multipart upload, history reconciliation and artifact delivery.
// Only Comfy/GPU execution is replaced by this loopback synthetic pixel server.
async function fixture(t, { lostFirstPOSTreply }) {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'native-regions-http-'));
  const dataRoot = path.join(workspaceRoot, 'ledger');
  await mkdir(dataRoot);
  const base = basePixels();
  const canvas = encodePng({ width: WIDTH, height: HEIGHT, pixels: base });
  const leftRef = solid(256, 256, LEFT), rightRef = solid(256, 256, RIGHT);
  const expectedCrops = [expectedCrop(base, 0), expectedCrop(expectedCanvas(base, [[REGIONS[0].box, LEFT]]), 224)];
  const uploads = new Map(), uploadRequests = [], posts = [], history = {}, outputs = new Map(), requests = [], serverErrors = [];
  let droppedReplies = 0;
  const json = (res, value) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      requests.push({ method: req.method, pathname: url.pathname, search: url.search });
      if (req.method === 'POST' && url.pathname === '/upload/image') {
        const parts = []; for await (const part of req) parts.push(part);
        const form = await new Request(url, { method: 'POST', headers: req.headers, body: Buffer.concat(parts) }).formData();
        assert.equal(form.get('overwrite'), 'false');
        assert.equal(form.get('type'), 'input');
        const file = form.get('image');
        assert.equal(file.type, 'image/png');
        uploadRequests.push(file.name);
        assert(!uploads.has(file.name), 'a recovered child must not upload any reference twice');
        uploads.set(file.name, Buffer.from(await file.arrayBuffer()));
        json(res, { name: file.name, subfolder: '', type: 'input' });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/prompt') {
        let text = ''; for await (const part of req) text += part;
        const body = JSON.parse(text), graph = body.prompt, id = body.extra_data.moss_run_id;
        assert.equal(body.client_id, `moss-draw-${id}`);
        assert(!posts.some(post => post.id === id), 'reconciliation must never POST the original child again');
        const ordinal = posts.length;
        const isNative = Object.values(graph).some(node => node.class_type === 'TextEncodeMOSSImageEdit');
        const post = { id, graph, kind: isNative ? 'native' : 'qwen' };
        posts.push(post);
        assert(ordinal < 3, 'only two native edits and one right-region Qwen call are authorized');
        const saves = Object.entries(graph).filter(([, node]) => node.class_type === 'SaveImage');
        assert.equal(saves.length, 1);
        const [saveId, save] = saves[0];
        assert.equal(save.inputs.filename_prefix, `moss_draw/${id}/native`);
        let bytes;
        if (ordinal < 2) {
          assert(isNative, 'even after restart with legacy config, this parent must submit native Edit');
          assert(!Object.values(graph).some(node => ['MossImageEdit', 'MossImageEditLoader', 'MossDrawEditStyleLoader'].includes(node.class_type)));
          assert.equal(graph['4'].class_type, 'LoraLoaderModelOnly');
          assert.equal(graph['4'].inputs.lora_name, 'MOSS-Image-Edit-rank64.safetensors');
          assert.equal(graph['4'].inputs.strength_model, 1);
          assert(!graph['5'], 'portable package ships no style LoRA stack');
          assert.deepEqual(graph['6'].inputs.model, ['4', 0]);
          assert.deepEqual(graph['10'].inputs.model, ['6', 0]);
          assert.deepEqual(graph['10'].inputs.positive, ['7', 0]);
          assert.deepEqual(graph['10'].inputs.negative, ['8', 0]);
          assert.equal(graph['10'].inputs.seed, [120, 121][ordinal]);
          assert.deepEqual(graph['9'].inputs, { width: 288, height: 320, batch_size: 1 });
          assert.match(graph['7'].inputs.prompt, /^Edit the first image/);
          assert(graph['7'].inputs.prompt.includes(REGIONS[ordinal].prompt));
          assert(!graph['7'].inputs.prompt.includes(REGIONS[1 - ordinal].prompt));
          assert.doesNotMatch(graph['7'].inputs.prompt, /GLOBAL_HEADCOUNT_ONLY|exactly two robots|one left and one right/i);
          assert.equal(graph['8'].inputs.prompt, '');

          // Verify both conditioning branches all the way to the real uploaded
          // bytes. Checking positive alone misses reversed/missing negative refs.
          for (const conditioning of ['positive', 'negative']) {
            const encoder = graph[graph['10'].inputs[conditioning][0]];
            assert.equal(encoder.class_type, 'TextEncodeMOSSImageEdit');
            assert.equal(encoder.inputs.edit_format, 'Moss-Image-Edit');
            assert.deepEqual(Object.keys(encoder.inputs).filter(key => key.startsWith('images.')).sort(), ['images.image_0', 'images.image_1']);
            for (const [index, scaleId, loadId, width, height] of [[0, '21', '20', 288, 320], [1, '23', '22', 256, 256]]) {
              assert.deepEqual(encoder.inputs[`images.image_${index}`], [scaleId, 0]);
              assert.deepEqual(graph[scaleId], { class_type: 'ImageScale', inputs: { image: [loadId, 0], upscale_method: 'lanczos', width, height, crop: 'disabled' } });
              assert.equal(graph[loadId].class_type, 'LoadImage');
              const name = graph[loadId].inputs.image;
              assert.equal(name, `moss-${id}-ref${index + 1}.png`);
              assert(uploads.has(name), `${conditioning} reference must have arrived through HTTP multipart`);
              if (index === 0) assertPixels(uploads.get(name), 288, 320, expectedCrops[ordinal], 'crop must use committed canvas, not preview or original base');
              else assert.deepEqual(uploads.get(name), [leftRef, rightRef][ordinal], 'assigned reference must stay second');
            }
          }
          assert.equal(Object.values(graph).filter(node => node.class_type === 'LoadImage').length, 2);
          const assigned = decodePng(uploads.get(graph['22'].inputs.image));
          bytes = solid(288, 320, assigned.pixels.subarray(0, 4));
        } else {
          assert(!isNative, 'the third call is the optional right-region Qwen repair');
          assert.equal(graph['6'].class_type, 'TextEncodeQwenImageEditPlus');
          assert.equal(graph['6'].inputs.prompt, REGIONS[1].qwen_prompt);
          assert.equal(Object.values(graph).filter(node => node.class_type === 'LoadImage').length, 1);
          assert.equal(graph['4'].inputs.image, `moss-${id}-ref1.png`);
          assert.deepEqual(uploads.get(graph['4'].inputs.image), outputs.get(`moss_draw/${posts[1].id}`), 'Qwen input must be the exact right native output, not the full canvas');
          assert.deepEqual([graph['8'].inputs.width, graph['8'].inputs.height], [288, 320]);
          bytes = solid(288, 320, REPAIRED);
        }
        const promptId = `native-regions-${ordinal + 1}`;
        outputs.set(`moss_draw/${id}`, bytes);
        history[promptId] = {
          prompt: [ordinal + 1, promptId, graph, { ...body.extra_data, client_id: body.client_id }, [saveId]],
          status: { status_str: 'success', completed: true, messages: [] },
          outputs: { [saveId]: { images: [{ filename: 'native_00001_.png', subfolder: `moss_draw\\${id}`, type: 'output' }] } },
        };
        if (lostFirstPOSTreply && ordinal === 0) {
          droppedReplies++;
          req.socket.destroy(); // Execution/history committed; receipt alone is lost.
          return;
        }
        json(res, { prompt_id: promptId, number: ordinal + 1, node_errors: {} });
        return;
      }
      assert.equal(req.method, 'GET', 'all recovery and collection traffic must be GET-only');
      if (url.pathname === '/history') {
        assert.equal(url.searchParams.get('max_items'), '1000');
        json(res, history); return;
      }
      if (url.pathname.startsWith('/history/')) {
        const id = url.pathname.split('/').at(-1);
        json(res, history[id] ? { [id]: history[id] } : {}); return;
      }
      if (url.pathname === '/queue') { json(res, { queue_running: [], queue_pending: [] }); return; }
      if (url.pathname === '/view') {
        assert.equal(url.searchParams.get('filename'), 'native_00001_.png');
        assert.equal(url.searchParams.get('type'), 'output');
        const subfolder = url.searchParams.get('subfolder');
        assert(!subfolder.includes('\\'), 'Windows history paths must normalize before /view');
        assert(outputs.has(subfolder));
        res.setHeader('content-type', 'image/png'); res.end(outputs.get(subfolder)); return;
      }
      throw new Error(`Unexpected fixture route ${url.pathname}`);
    } catch (error) {
      serverErrors.push(error);
      res.writeHead(500); res.end('synthetic fixture rejected request');
    }
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    // workspaceRoot is the exact mkdtemp directory created by this fixture.
    assert.equal(path.dirname(workspaceRoot), path.resolve(tmpdir()));
    assert(path.basename(workspaceRoot).startsWith('native-regions-http-'));
    await rm(workspaceRoot, { recursive: true, force: true });
    if (serverErrors.length) throw serverErrors[0];
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const comfyUrl = `http://127.0.0.1:${server.address().port}`;
  const files = [];
  for (const [name, bytes] of [['canvas.png', canvas], ['left.png', leftRef], ['right.png', rightRef]]) {
    const file = path.join(workspaceRoot, name); await writeFile(file, bytes); files.push(file);
  }
  const savedFiles = [], images = [], definitions = new Map();
  // Host attachment sink only: production tools still validate paths, hashes,
  // dimensions and exact bytes. No production service or fetch is mocked.
  const attachments = {
    async saveImage({ data, mediaType }) {
      const { width, height } = decodePng(data), attachment = { id: sha(data), width, height, mediaType };
      images.push({ data: Buffer.from(data), attachment }); return attachment;
    },
    async saveFile({ data, name }) {
      const attachment = { id: sha(data), name };
      savedFiles.push({ data: Buffer.from(data), attachment }); return attachment;
    },
    imageHostPath: ref => ref.hostPath,
  };
  const exec = {
    agent: { session: { deriveMessages: () => [{ source: { kind: 'user' }, content: files.map(hostPath => ({ type: 'image', attachment: { hostPath } })) }] } },
    signal: new AbortController().signal,
  };
  function mount(editEngine) {
    const service = createDrawingService({ dataRoot, comfyUrl, ...(editEngine ? { editEngine } : {}) });
    definitions.clear();
    registerTools({ tools: { register: definition => definitions.set(definition.name, definition) } }, {
      sdk: { tools: { defineTool: definition => definition } }, service, readGuide: async () => ({}), config: { workspaceRoot, dataRoot }, attachments,
    });
    return service;
  }
  return {
    dataRoot, base, files, uploads, uploadRequests, posts, requests, history, serverErrors, savedFiles, images, definitions, exec, mount,
    droppedReplies: () => droppedReplies,
    call: (name, args) => definitions.get(name).execute(args, exec),
    parentRecord: async id => JSON.parse(await readFile(path.join(dataRoot, 'region-pipelines', 'runs', id, 'run.json'), 'utf8')),
  };
}

// Regression targets: wrong persisted engine/conditioning refs, duplicate POST
// on unknown recovery, stale next-crop input, exterior writes or changed delivery.
for (const lostFirstPOSTreply of [false, true]) {
  test(`native two-region HTTP + right Qwen survives new legacy instance: ${lostFirstPOSTreply ? 'lostFirstPOSTreply' : 'normal'}`, { timeout: 15000 }, async t => {
    const f = await fixture(t, { lostFirstPOSTreply });
    let service = f.mount(); // Production default native, not an injected adapter.
    const draft = await f.call('art_generate', {
      mode: 'regions', action: 'draft', request_id: 'native-http-regions-v1', prompt: GLOBAL_PROMPT, references: f.files, regions: REGIONS,
    });
    assert.equal(draft.status, 'draft');
    assert.equal(draft.params.edit_engine, 'native');
    assert.equal((await f.parentRecord(draft.run_id)).edit_engine, 'native');
    assert.equal(f.requests.length, 0, 'draft must be local-only');
    await f.call('art_view', { run_id: draft.run_id, variant: 'preview' });
    assert.equal(f.requests.length, 0, 'preview must not advance or upload the plan');
    assert.notDeepEqual(decodePng(f.images.at(-1).data).pixels, f.base, 'preview is a real annotated overlay, not a valid edit input');
    await f.call('art_generate', { mode: 'regions', action: 'execute', plan_id: draft.run_id });
    assert.equal(f.requests.length, 0, 'execute approves the plan without submitting until run');
    const started = await service.run({ run_id: draft.run_id });
    if (f.serverErrors.length) throw f.serverErrors[0];
    assert.equal(started.status, lostFirstPOSTreply ? 'unknown' : 'running');
    assert.equal(f.posts.length, 1);
    assert.equal(f.uploadRequests.length, 2);
    assert.equal(f.droppedReplies(), Number(lostFirstPOSTreply));
    const beforeRestart = await f.parentRecord(draft.run_id);
    assert.equal(beforeRestart.edit_engine, 'native');
    assert.equal(beforeRestart.pending.child_run_id, f.posts[0].id);
    const originalChild = (await service.context({ run_id: f.posts[0].id })).runs[0];
    assert.equal(originalChild.status, lostFirstPOSTreply ? 'unknown' : 'queued');
    assert.equal(originalChild.prompt_id, lostFirstPOSTreply ? undefined : 'native-regions-1');
    if (lostFirstPOSTreply) assert.equal(originalChild.error.code, 'NETWORK_UNKNOWN');
    assert.equal(Object.keys(f.history).length, 1, 'lost reply still represents one already executed child');

    // Drop old service/tools references. Both modes must recover exclusively from
    // persisted records; the new trusted default deliberately disagrees.
    service = undefined;
    const restartRequest = f.requests.length;
    service = f.mount('legacy');
    assert.equal(service.catalog().backends.find(backend => backend.id === 'moss').modes.find(mode => mode.id === 'regions').edit_engine, 'legacy');
    const recovered = await service.run({ run_id: draft.run_id });
    if (f.serverErrors.length) throw f.serverErrors[0];
    assert.equal(recovered.status, 'running');
    assert.equal(recovered.params.edit_engine, 'native');
    assert.equal(recovered.progress.phase, 'composite');
    assert.equal(recovered.progress.completed_calls, 1);
    assert.equal(f.posts.length, 1, 'first recovery must collect, not resubmit');
    assert.equal(f.uploadRequests.length, 2);
    const recoveryTraffic = f.requests.slice(restartRequest);
    assert(recoveryTraffic.every(request => request.method === 'GET'));
    assert(recoveryTraffic.some(request => request.pathname === (lostFirstPOSTreply ? '/history' : '/history/native-regions-1')));
    assert(recoveryTraffic.some(request => request.pathname === '/queue'));
    assert(recoveryTraffic.some(request => request.pathname === '/view'));
    assert.equal((await service.context({ run_id: f.posts[0].id })).runs[0].prompt_id, 'native-regions-1');

    const done = await waitForRun(service, { run_id: draft.run_id }, { intervalMs: 1, timeoutMs: 5000 });
    if (f.serverErrors.length) throw f.serverErrors[0];
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    assert.equal(done.params.edit_engine, 'native');
    assert.equal(done.progress.completed_calls, 3);
    assert.equal(done.progress.total_calls, 3);
    assert.deepEqual(f.posts.map(post => post.kind), ['native', 'native', 'qwen']);
    assert.equal(f.requests.filter(request => request.method === 'POST' && request.pathname === '/prompt').length, 3);
    assert.equal(f.uploadRequests.length, 5);
    assert.equal(f.uploads.size, 5);
    assert.deepEqual(f.uploadRequests, [
      `moss-${f.posts[0].id}-ref1.png`, `moss-${f.posts[0].id}-ref2.png`,
      `moss-${f.posts[1].id}-ref1.png`, `moss-${f.posts[1].id}-ref2.png`, `moss-${f.posts[2].id}-ref1.png`,
    ]);
    const finalRecord = await f.parentRecord(draft.run_id);
    assert.equal(finalRecord.edit_engine, 'native');
    assert.deepEqual(finalRecord.history.map(({ phase, region }) => [phase, region]), [['edit', 0], ['edit', 1], ['qwen', 1]]);
    assert.deepEqual(finalRecord.history.map(entry => entry.child_run_id), f.posts.map(post => post.id));

    const raw = await readFile(done.artifact.path), actual = decodePng(raw);
    assert.deepEqual([actual.width, actual.height], [WIDTH, HEIGHT]);
    assert.deepEqual(actual.pixels, expectedCanvas(f.base, [[REGIONS[0].box, LEFT], [REGIONS[1].box, REPAIRED]]));
    let outsidePixels = 0, outsideChangedPixels = 0, transparentProtectedPixels = 0;
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      if (REGIONS.some(region => inBox(x, y, region.box))) continue;
      const i = (y * WIDTH + x) * 4;
      outsidePixels++;
      if (f.base[i + 3] === 0) transparentProtectedPixels++;
      if (!actual.pixels.subarray(i, i + 4).equals(f.base.subarray(i, i + 4))) outsideChangedPixels++;
    }
    assert.equal(outsidePixels, 49152);
    assert(transparentProtectedPixels > 0);
    assert.equal(outsideChangedPixels, 0, 'outside-mask RGBA (including hidden RGB) must be byte-exact');
    assert.deepEqual(done.protection, { scope: 'outside_region_union', outside_changed_pixels: 0 });
    for (let index = 0; index < 2; index++) {
      const mask = await readFile(path.join(f.dataRoot, 'region-pipelines', 'runs', draft.run_id, `mask-${index + 1}.png`));
      const expected = expectedCanvas(Buffer.alloc(WIDTH * HEIGHT * 4).fill(Buffer.from([0, 0, 0, 255])), [[REGIONS[index].box, [255, 255, 255, 255]]]);
      assertPixels(mask, WIDTH, HEIGHT, expected, 'persisted mask must match only the half-open writable region');
    }

    for (const [index, post] of f.posts.entries()) {
      const child = (await service.context({ run_id: post.id })).runs[0];
      assert.equal(child.status, 'succeeded');
      assert.equal(child.pipeline_run_id, draft.run_id);
      assert.equal(child.params.backend, index < 2 ? 'moss' : 'qwen');
      if (index < 2) assert.equal(child.params.model_variant, 'native-sft-edit');
    }
    assert.deepEqual((await service.context({})).runs.map(run => run.run_id), [draft.run_id]);
    assert.deepEqual((await f.call('art_context', {})).runs.map(run => run.run_id), [draft.run_id]);

    const settledTraffic = f.requests.length;
    const viewed = await f.call('art_view', { run_id: draft.run_id, variant: 'result' });
    assert.equal(viewed.sha256, sha(raw));
    assert.deepEqual(f.images.at(-1).data, raw);
    const observations = ['Synthetic transport and pixel-composition check only; no model quality claim.'];
    await f.call('art_review', { run_id: draft.run_id, observations, issues: [], next_change: '' });
    const receipt = await f.call('art_deliver', { run_id: draft.run_id });
    assert.equal(receipt.run_id, draft.run_id);
    assert.equal(receipt.sha256, sha(raw));
    assert.equal(done.artifact.sha256, receipt.sha256);
    assert.deepEqual([receipt.width, receipt.height], [WIDTH, HEIGHT]);
    assert.equal(receipt.path, done.artifact.path.replaceAll('\\', '/'));
    const target = /^\[在侧边栏查看原图\]\(<(.+)>\)$/.exec(receipt.markdown_link);
    assert(target, 'delivery must expose the exact artifact sidebar link');
    assert.equal(decodeURIComponent(target[1]), receipt.path);
    assert.equal(f.savedFiles.length, 1);
    assert.deepEqual(f.savedFiles[0].data, raw);
    assert.equal(f.savedFiles[0].attachment.name, `moss-${draft.run_id}.png`);
    assert.deepEqual(f.images.at(-1).data, raw);
    const projected = f.definitions.get('art_deliver').projectContent(f.exec, { isError: false });
    assert.deepEqual(projected.map(item => item.type), ['text', 'file', 'image']);
    assert.deepEqual(JSON.parse(projected[0].text), receipt);
    assert.deepEqual(projected[1].attachment, f.savedFiles[0].attachment);
    assert.deepEqual(projected[2].attachment, f.images.at(-1).attachment);
    assert.deepEqual((await service.context({ run_id: draft.run_id })).runs[0].review.observations, observations);
    assert.equal((await service.run({ run_id: draft.run_id })).status, 'succeeded');
    assert.equal(f.requests.length, settledTraffic, 'inspection, review, delivery and completed re-query must not call Comfy');
  });
}
