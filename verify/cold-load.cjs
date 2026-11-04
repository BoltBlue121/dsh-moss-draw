#!/usr/bin/env node
/*
 * Cold-load acceptance for the portable AI drawing workbench plugin.
 *
 * Runs the REAL official DSH loader (from the Desktop app.asar) against a fake
 * profile that links this kit's plugin/, with no DSH Host, no network and no
 * GPU. It proves the shipped package can be discovered, loaded, mounted as the
 * "ai-draw" preset, that its 7 art_* tools answer, that guide/templates are
 * actually read from the package, that the workbench RPC path works, and that
 * the client bundle is discovered and served.
 *
 * Must run under the official Desktop executable in Node mode:
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   & "<DesktopDir>\DeepSeek Harness.exe" "verify\cold-load.cjs" --kit "<kit>" --desktop-dir "<DesktopDir>"
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createRequire, syncBuiltinESMExports } = require('node:module');
const { pathToFileURL, fileURLToPath } = require('node:url');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
// Marker deny-lists are base64-encoded so the kit itself never ships the private
// names they detect; decode at runtime.
const decodeMarker = value => Buffer.from(value, 'base64').toString('utf8');
const privateMarker = new RegExp([decodeMarker('b3JjYXJvdXRlcg=='), decodeMarker('a2llZWQ='), decodeMarker('bW9kYXJl'), decodeMarker('Znltcmll'), decodeMarker('ZGxzczU='), decodeMarker('5Y2h6I6y'), decodeMarker('6a2U5aWz'), decodeMarker('5Zyj5aWz'), decodeMarker('5L+u5aWz'), decodeMarker('6YWS6aaG6aKE6K6+'), decodeMarker('5Y+M5Lq65Lmm5oi/')].join('|'), 'i');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--kit': args.kit = next(); break;
      case '--desktop-dir': args.desktopDir = next(); break;
      case '--work': args.work = next(); break;
      case '--out': args.out = next(); break;
      default: throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const KIT = path.resolve(args.kit ?? path.join(__dirname, '..'));
const PKG = path.join(KIT, 'plugin');
const WORK = path.resolve(args.work ?? path.join(KIT, '.verify-work'));
const OUT = path.resolve(args.out ?? path.join(WORK, 'cold-load.json'));
const desktopDir = path.resolve(args.desktopDir ?? process.env.DSH_DESKTOP_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'));
const base = path.join(desktopDir, 'resources', 'app.asar', 'dsh', 'package.json');
const ID = '@dsh-external/dsh-moss-draw';
const MODE = 'portable';
const EXPECTED_VERSION = '0.9.0';

const evidence = {
  schema: 1, mode: MODE, kit: KIT, packageDir: PKG, workDir: WORK, asarBase: base,
  node: process.version, electron: process.versions.electron ?? null,
  networkAttempts: [], serverAttempts: [], resourceReads: [], checks: {},
};
const sha = buffer => createHash('sha256').update(buffer).digest('hex');
const urlOf = target => pathToFileURL(path.resolve(target)).href;

if (!process.versions.electron) {
  console.error('cold-load: run this with the official Desktop executable and ELECTRON_RUN_AS_NODE=1, not with system node (the DSH SDK lives inside app.asar).');
  process.exit(3);
}
if (!fs.existsSync(base)) {
  console.error(`cold-load: DSH package not found in app.asar: ${base}`);
  process.exit(3);
}
if (!fs.existsSync(path.join(PKG, 'package.json'))) {
  console.error(`cold-load: plugin package not found: ${PKG}`);
  process.exit(3);
}

const seen = new Set();
let observedRoot = PKG;
const observe = (filename, result) => {
  let resolved;
  try { resolved = filename instanceof URL ? fileURLToPath(filename) : String(filename); } catch { return; }
  resolved = path.resolve(resolved);
  if (resolved.startsWith(observedRoot + path.sep) && !seen.has(resolved)) {
    seen.add(resolved);
    evidence.resourceReads.push({ path: path.relative(observedRoot, resolved), sha256: sha(result) });
  }
};
const readSync = fs.readFileSync;
fs.readFileSync = function interceptedReadFileSync(...callArgs) {
  const value = readSync.apply(this, callArgs);
  observe(callArgs[0], value);
  return value;
};
const readAsync = fsp.readFile;
fsp.readFile = async function interceptedReadFile(...callArgs) {
  const value = await readAsync.apply(this, callArgs);
  observe(callArgs[0], value);
  return value;
};

// Fail-closed observers: a real load path must not reach the network or open a server.
globalThis.fetch = async (...fetchArgs) => {
  evidence.networkAttempts.push(String(fetchArgs[0]));
  throw new Error('COLD_LOAD_NETWORK_FORBIDDEN');
};
for (const id of ['node:net', 'node:http', 'node:https']) {
  const mod = require(id);
  if (mod.request) mod.request = (...a) => { evidence.networkAttempts.push(id); throw new Error('COLD_LOAD_NETWORK_FORBIDDEN'); };
  if (mod.get) mod.get = mod.request;
}
const net = require('node:net');
net.Socket.prototype.connect = function forbiddenConnect() {
  evidence.networkAttempts.push('Socket.connect');
  throw new Error('COLD_LOAD_NETWORK_FORBIDDEN');
};
net.Server.prototype.listen = function forbiddenListen() {
  evidence.serverAttempts.push('listen');
  throw new Error('COLD_LOAD_SERVER_FORBIDDEN');
};
syncBuiltinESMExports();

(async () => {
  // ---------------------------------------------------------------- fresh work tree
  // Windows occasionally refuses Node's rmSync on a directory that still holds a
  // junction or a just-released handle (EPERM/EBUSY). cmd's rmdir handles those,
  // so fall back to it rather than failing the whole acceptance run.
  const removeDir = dir => {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
      return;
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(error.code)) throw error;
    }
    try {
      execFileSync('cmd.exe', ['/d', '/c', 'rmdir', '/s', '/q', dir], { stdio: 'ignore' });
    } catch { /* fall through to the existence check */ }
    if (fs.existsSync(dir)) throw new Error(`could not clear ${dir}; close any process using it and retry`);
  };
  for (const name of ['home', 'workspace', 'data', 'renewal-fixture', 'package']) {
    removeDir(path.join(WORK, name));
  }
  fs.mkdirSync(WORK, { recursive: true });
  fs.cpSync(PKG, path.join(WORK, 'package'), { recursive: true });
  const packageDir = path.join(WORK, 'package');
  observedRoot = packageDir;
  const workspaceRoot = path.join(WORK, 'workspace');
  const dataRoot = path.join(WORK, 'data');
  const renewalRoot = path.join(WORK, 'renewal-fixture');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(renewalRoot, { recursive: true });

  // ---------------------------------------------------------------- shipped package assertions
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  assert.equal(pkg.name, ID);
  assert.equal(pkg.version, EXPECTED_VERSION, 'shipped version');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.license, '(MIT AND CC-BY-NC-ND-4.0)');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-sidebar-right', '@deepseek-ai/dsh-client-ui-conversation', '@deepseek-ai/dsh-api-session-controller']);
  evidence.checks.package = { name: pkg.name, version: pkg.version, files: pkg.files, clientInject: pkg.dsh.client.inject };
  evidence.checks.noCredentials = !/apiKey|password|Bearer\s|sk-[A-Za-z0-9]{8}/.test(JSON.stringify(pkg));

  // The kit ships placeholders; a real deployment runs install/adapt.mjs. Exercise
  // that same tool here so the acceptance covers the configured file, not an
  // untested template.
  const pristinePatch = fs.readFileSync(path.join(PKG, 'cordis.patch.yml'), 'utf8');
  assert(pristinePatch.includes('__MOSS_WORKSPACE_ROOT__'), 'kit must ship the workspace placeholder');
  const personalPath = /(?:^|[^A-Za-z])(?:[A-Za-z]:[\\/](?:Users|agent|ComfyUI|DSH)|100\.\d+\.\d+\.\d+)/im;
  assert(!personalPath.test(pristinePatch) && !privateMarker.test(pristinePatch), 'pristine bundle patch leaked personal/private data');
  const adapt = await import(urlOf(path.join(KIT, 'install', 'adapt.mjs')));
  const adaptResult = adapt.adapt({ pluginDir: packageDir, workspaceRoot, comfyUrl: 'http://127.0.0.1:9', dataRoot });
  evidence.checks.adapt = adaptResult.receipt;
  const patchText = fs.readFileSync(path.join(packageDir, 'cordis.patch.yml'), 'utf8');
  assert(!patchText.includes('__MOSS_'), 'cordis.patch.yml still contains unresolved placeholders after adapt');
  assert(patchText.includes("id: moss-draw") && patchText.includes("id: moss-workbench-query"), 'bundle patch must insert both plugin ids');
  assert(patchText.includes(workspaceRoot), 'bundle patch does not carry the adapted workspace root');
  assert(!privateMarker.test(patchText), 'adapted bundle patch leaked a private style or provider name');
  evidence.checks.bundlePatch = { adapted: true, ids: ['moss-draw', 'moss-workbench-query'], pristine: 'clean', config: adaptResult.config };

  // ---------------------------------------------------------------- fake profile
  const home = path.join(WORK, 'home');
  const profileDir = path.join(home, 'profiles', 'portable-verify');
  fs.mkdirSync(path.join(profileDir, 'node_modules', '@dsh-external'), { recursive: true });
  const link = path.join(profileDir, 'node_modules', '@dsh-external', 'dsh-moss-draw');
  fs.symlinkSync(packageDir, link, 'junction');
  const fixtureManifest = path.join(profileDir, 'package.json');
  fs.writeFileSync(fixtureManifest, JSON.stringify({
    name: 'portable-moss-draw-cold-profile', private: true,
    dependencies: { [ID]: `link:${packageDir.replaceAll('\\', '/')}` },
    dsh: { profile: { bundles: [ID] } },
  }, null, 2));

  const r = createRequire(base);
  const { Context } = r('@deepseek-ai/cordis');
  const { Loader } = r('@deepseek-ai/cordis-plugin-loader');
  const { loadProfileDirectory, createRuntimeResolution, PluginPackages } = r('@deepseek-ai/dsh-app-boot');
  const profile = loadProfileDirectory('dsh', profileDir, base, { userLayer: false });
  assert.equal(profile.skippedBundles.length, 0);
  const resolution = await createRuntimeResolution({ installAnchor: base, profile, home });
  evidence.profile = {
    dir: profileDir,
    linkedRoots: resolution.linkedRoots,
    installationEntries: resolution.entries.filter(entry => entry.scope === 'installation').length,
  };
  assert(resolution.linkedRoots.some(entry => entry.name === ID && path.resolve(entry.realPath) === packageDir), 'profile resolution must link the kit package');

  const ctx = new Context();
  const loader = new Loader(ctx, { baseUrl: pathToFileURL(fixtureManifest).href });
  await ctx.plugin(PluginPackages, { resolution }).await();
  assert.equal(loader.internal.version, 'v2');
  const resolveName = (specifier, parent = pathToFileURL(fixtureManifest).href) => loader.internal.resolveSync(parent, { specifier, attributes: {} }).url;
  evidence.resolved = {};
  for (const spec of [ID, `${ID}/scope`, `${ID}/client`, `${ID}/package.json`]) {
    const url = resolveName(spec);
    evidence.resolved[spec] = url;
    assert(fileURLToPath(url).startsWith(packageDir + path.sep), `${spec} must resolve inside the kit package`);
  }
  assert.throws(() => createRequire(path.join(packageDir, 'src/sdk.mjs')).resolve(`${ID}/src/tools.mjs`), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  evidence.checks.closedExports = true;

  // ---------------------------------------------------------------- official loader boot
  const rows = [
    ['typert', '@deepseek-ai/dsh-typert-registry', {}],
    ['query', `${ID}/query`, {}],
    ['system-prompt', '@deepseek-ai/dsh-system-prompt', {}],
    ['tools', '@deepseek-ai/dsh-tools', {}],
    ['commands', '@deepseek-ai/dsh-commands', {}],
    ['sessions', '@deepseek-ai/dsh-session', {}],
    ['session-projections', '@deepseek-ai/dsh-session-projection', {}],
    ['presets', '@deepseek-ai/dsh-agent-preset-registry', { default: 'ai-draw' }],
    ['credentials', '@deepseek-ai/dsh-credentials-local', { dshHome: home, watch: false }],
    ['attachments', '@deepseek-ai/dsh-attachment-local', { dshHome: home }],
    ['candidate', ID, { workspaceRoot, dataRoot, comfyUrl: 'http://127.0.0.1:9' }],
  ].map(([id, name, config]) => ({ id, name, config }));
  await loader.root.update(rows);
  await loader.await();
  for (const entry of loader.entries()) {
    assert(entry.fiber, `${entry.options.name} has no fiber`);
    await entry.fiber.await();
    assert.equal(entry.fiber.state, 2, `${entry.options.name} not ACTIVE`);
  }
  evidence.checks.fibers = loader.entries().map(entry => ({ name: entry.options.name, state: entry.fiber.state }));
  const roster = await ctx.agentPresets.list();
  evidence.roster = roster;
  assert.equal(roster.length, 1);
  assert.equal(roster[0].id, 'ai-draw');
  assert.equal(roster[0].broken, undefined);
  evidence.compositions = ctx.agentPresets.inspectCompositions();
  assert(evidence.compositions[0].modules.some(module => module.moduleName === `${ID}/scope`));
  assert.deepEqual(evidence.compositions[0].leakedServices, []);

  const { createScope } = r('@deepseek-ai/dsh-scope');
  const agent = { id: 'portable-cold-session' };
  let scope;
  await ctx.plugin({
    inject: ['sessions', 'agentPresets'],
    async apply(owner) {
      scope = createScope(owner, agent);
      agent.ctx = scope.ctx;
      await owner.agentPresets.mount(agent.ctx, 'ai-draw');
      agent.session = agent.ctx.sessions.create(agent.id, { meta: { cwd: workspaceRoot, agentPreset: 'ai-draw' } });
    },
  }).await();
  assert.equal(ctx.sessions.get(agent.id), agent.session);
  assert.equal(ctx.agentPresets.composedPreset(agent.ctx), 'ai-draw');
  agent.session.append('user/message', { id: 'portable-cold-human', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Inspect tools without generating' }] }, { surfaceOp: 'append' });
  const authState = ctx.sessionProjections.stateOf(agent.session, 'moss-draw.authorization');
  assert.equal(authState.message_id, 'portable-cold-human');
  assert(!Object.hasOwn(ctx.sessionProjections.snapshot(agent.session).values, 'moss-draw.authorization'));
  evidence.checks.authorizationProjection = { nativeRegistered: true, hostOnly: true };

  const assembly = await ctx.systemPrompt.assemble({ scope: agent });
  evidence.session = {
    id: agent.id,
    preset: ctx.agentPresets.composedPreset(agent.ctx),
    header: agent.session.header,
    tools: assembly.tools.map(tool => tool.name),
    personaSections: assembly.sections.length,
  };
  assert.deepEqual(evidence.session.tools.slice().sort(), ['art_context', 'art_deliver', 'art_generate', 'art_guide', 'art_review', 'art_run', 'art_view'].sort());

  const nativeCall = async (name, toolArgs) => {
    const callId = randomUUID();
    agent.session.append('tool/call', { callId, name, arguments: JSON.stringify(toolArgs) });
    const result = await ctx.tools.execute({ name, arguments: toolArgs, agent, callId, signal: new AbortController().signal });
    agent.session.append('tool/result', { message: { id: randomUUID(), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, isError: result.isError, content: result.content } }, { surfaceOp: 'append' });
    return result;
  };
  const call = async (name, toolArgs) => {
    const result = await nativeCall(name, toolArgs);
    assert.equal(result.isError, false, JSON.stringify(result));
    return JSON.parse(result.content.find(part => part.type === 'text').text);
  };

  // ---------------------------------------------------------------- searchable guidance
  evidence.guides = [];
  for (const topicName of ['quick', 'index', 'moss-modes', 'k2', 'qwen', 'regions', 'workbench', 'studio', 'promptcraft']) {
    const out = await call('art_guide', { topic: topicName, limit: 9000 });
    assert(out.text.length > 0, `${topicName} guide is empty`);
    assert(!privateMarker.test(out.text), `${topicName} guide leaked a private style/provider name`);
    evidence.guides.push({ topic: topicName, chars: out.text.length, total: out.total_chars, source: out.source, sha256: sha(out.text) });
  }
  evidence.checks.guideTopics = evidence.guides.map(guide => guide.topic);

  const context = await call('art_context', {});
  evidence.context = {
    backendIds: context.catalog.backends.map(backend => backend.id),
    runCount: context.runs.length,
    mossStyles: context.catalog.backends.find(backend => backend.id === 'moss').styles.map(style => style.id),
    mossDefaultStyle: context.catalog.backends.find(backend => backend.id === 'moss').defaults.style,
    k2DefaultStyle: context.catalog.backends.find(backend => backend.id === 'k2').defaults.style,
    qwenStyles: context.catalog.backends.find(backend => backend.id === 'qwen').styles.map(style => style.id),
  };
  assert.deepEqual(evidence.context.backendIds, ['moss', 'k2', 'qwen']);
  assert.deepEqual(evidence.context.mossStyles, ['none']);
  assert.equal(evidence.context.mossDefaultStyle, 'none');
  assert.equal(evidence.context.k2DefaultStyle, 'none');
  assert.deepEqual(evidence.context.qwenStyles, ['none']);
  const badStyle = await nativeCall('art_generate', { request_id: 'cold-style-reject', prompt: 'x', style: 'legacy-style' });
  assert.equal(badStyle.isError, true, 'a private style name must be rejected');
  evidence.checks.rejectedPrivateStyle = true;
  for (const template of ['characters', 'edit-multi', 'edit-single', 'inpaint', 'k2-t2i', 'qwen-edit', 'moss-native-edit']) {
    assert(evidence.resourceReads.some(read => read.path === path.join('templates', `${template}.json`)), `${template} was not actually read`);
  }
  evidence.checks.templatesRead = true;

  // ---------------------------------------------------------------- workbench RPC + studio flows
  const command = async request => {
    const value = await ctx.commands.execute(agent, `/art-workbench ${JSON.stringify(request)}`, [], new AbortController().signal);
    assert.equal(value.result.kind, 'success', JSON.stringify(value));
    return JSON.parse(value.result.text);
  };
  const series = await call('art_generate', { mode: 'workbench', workbench: { action: 'studioCreateSeries', title: 'Portable cold-load' } });
  const doc = {
    kind: 'layout',
    layout: {
      width: 1024, height: 1024, bbox_coord_space: 'abs', bbox_format: 'xyxy', summary: { caption: 'Two boxes' },
      items: [{ id: 'a', label: 'object', caption: 'First box', bbox: [100, 100, 300, 300] }, { id: 'b', label: 'object', caption: 'Second box', bbox: [500, 300, 700, 600] }],
    },
    caption: { caption: 'Alternate caption' },
  };
  const page = await call('art_generate', { mode: 'workbench', workbench: { action: 'studioCreatePage', series_id: series.series_id, title: 'Portable page', doc_json: JSON.stringify(doc) } });
  const studio = await command({ action: 'studioState', series_id: series.series_id });
  assert.deepEqual(studio.features, { proposal_order: true, history_preview: true });
  const modified = structuredClone(doc);
  modified.layout.items.reverse();
  modified.layout.items.find(item => item.id === 'a').caption = 'Changed first box';
  const proposed = await call('art_generate', { mode: 'workbench', workbench: { action: 'studioPropose', page_id: page.page_id, expected_revision: page.revision, doc_json: JSON.stringify(modified), summary: 'Independent order and item' } });
  const accepted = await command({ action: 'studioResolve', page_id: page.page_id, expected_revision: proposed.revision, proposal_id: proposed.proposals.at(-1).proposal_id, accept: ['item:a'] });
  assert.deepEqual(accepted.doc.layout.items.map(item => item.id), ['a', 'b']);
  assert.equal(accepted.doc.layout.items[0].caption, 'Changed first box');
  assert.equal(accepted.proposals.at(-1).status, 'partial');
  const snapshot = await command({ action: 'studioHistory', page_id: page.page_id, revision: 1 });
  assert.deepEqual(snapshot.snapshot.doc, doc);
  const readBack = await command({ action: 'studioGetPage', page_id: page.page_id });
  const compiled = await command({ action: 'studioCompile', doc: readBack.doc });
  assert.equal(compiled.compiled, true);
  const archive = await command({ action: 'studioArchiveAdd', title: 'Cold archive', category: 'verification', doc: readBack.doc, prompt: compiled.prompt });
  const archiveRead = await command({ action: 'studioArchiveGet', archive_id: archive.archive_id });
  assert.deepEqual(archiveRead.doc, readBack.doc);
  assert.equal((await command({ action: 'studioArchiveList', limit: 20 })).total, 1);
  assert.equal((await command({ action: 'studioRenameSeries', series_id: series.series_id, expected_title: series.title, title: 'Renamed portable series' })).title, 'Renamed portable series');
  const studioRuns = await call('art_context', {});
  assert.equal(studioRuns.runs.length, 0);
  evidence.studio = { features: studio.features, pageRevision: readBack.revision, partial: accepted.proposals.at(-1).status, historyReadOnly: true, compiled: true, archiveReadback: true, seriesRename: true, runs: 0 };

  const started = await call('art_generate', { mode: 'workbench', workbench: { action: 'studioStart', page_id: page.page_id, expected_revision: readBack.revision, intent: 'Cold no-GPU task', mode: 'auto', max_runs: 0 } });
  assert.equal(started.task.presentation.status, 'queued');
  const inspected = await call('art_context', { studio_page_id: page.page_id, studio_inspect: true });
  assert.equal(inspected.compilation.compiled, true);
  assert.equal((await call('art_view', { studio_page_id: page.page_id, expected_revision: started.revision })).preview_kind, 'layout-blockout');
  const plan = await call('art_generate', { mode: 'workbench', workbench: { action: 'studioPrepare', page_id: page.page_id, expected_revision: started.revision, request_key: 'cold-plan', settings: { backend: 'moss', mode: 't2i', seed: 42 }, references: [] } });
  assert.equal(plan.page_revision, started.revision);
  const forbidden = await ctx.tools.execute({ name: 'art_generate', arguments: { mode: 'workbench', workbench: { action: 'studioExecute', plan_id: plan.plan_id } }, agent, callId: 'cold-budget', signal: new AbortController().signal });
  assert.equal(forbidden.isError, true);
  assert(JSON.stringify(forbidden).includes('STUDIO_BUDGET_EXHAUSTED'));
  const lease = await command({ action: 'studioTakeover', page_id: page.page_id, expected_revision: started.revision, client_id: 'cold-ui' });
  assert.equal(lease.page.task.control, 'manual');
  const resumed = await command({ action: 'studioResume', page_id: page.page_id, expected_revision: lease.page.revision, lease_token: lease.lease_token });
  assert.equal(resumed.task.control, 'auto');
  assert.equal((await command({ action: 'studioAckOpen', page_id: page.page_id, request_id: started.task.presentation.request_id, client_id: 'cold-ui', surface: 'sidebar' })).task.presentation.status, 'opened');
  evidence.agentTask = { compiled: true, preview: true, planBound: true, budgetDenied: true, humanTakeover: true, resumed: true, acknowledged: true, submissions: 0 };

  // ---------------------------------------------------------------- chat consent path (host-only projection)
  {
    const human = text => agent.session.append('user/message', { id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, { surfaceOp: 'append' });
    const question = text => agent.session.append('assistant/message', { message: { id: randomUUID(), role: 'assistant', source: { kind: 'model', provider: 'cold-fixture', model: 'cold-fixture' }, content: [{ type: 'text', text }] } }, { surfaceOp: 'append' });
    const action = workbench => call('art_generate', { mode: 'workbench', workbench });
    human('Ask before adding one run, do not generate.');
    const current = await command({ action: 'studioGetPage', page_id: page.page_id });
    const asked = await action({ action: 'studioRequestConsent', page_id: current.page_id, expected_revision: current.revision, request_key: 'cold-add-one', operations: { proposal: null, resume: false, exit_text_only: false, generation: { mode: 'add_to_active', runs: 1, backend: 'moss', intent: '' }, continue_generation: false } });
    question(asked.consent.question);
    human('可以。');
    const deniedBefore = await nativeCall('art_generate', { mode: 'workbench', workbench: { action: 'studioPrepare', page_id: current.page_id, expected_revision: current.revision, request_key: 'cold-preapply-bypass', settings: { seed: 1 }, references: [] } });
    assert.equal(deniedBefore.isError, true);
    assert(JSON.stringify(deniedBefore).includes('STUDIO_CONSENT_'));
    const applied = await action({ action: 'studioApplyConsent', consent_id: asked.consent.consent_id });
    assert.equal(applied.consent.status, 'applied');
    assert.equal(applied.page.task.max_runs, 1);
    assert.equal(applied.page.task.claimed_runs, 0);
    assert.deepEqual(await action({ action: 'studioApplyConsent', consent_id: asked.consent.consent_id }), applied);
    const deniedAfter = await nativeCall('art_generate', { request_id: 'cold-raw-bypass', prompt: 'Forbidden' });
    assert.equal(deniedAfter.isError, true);
    assert.match(JSON.stringify(deniedAfter),/STUDIO_LAYOUT_REQUIRED/, 'even applied consent cannot bypass the strict Layout pipeline');
    human('Ask to return the clean manual owner, without generating.');
    const owner = await command({ action: 'studioTakeover', page_id: page.page_id, expected_revision: applied.page.revision, client_id: 'consent-cold-owner' });
    const handoffRequest = await action({ action: 'studioRequestConsent', page_id: page.page_id, expected_revision: owner.page.revision, request_key: 'cold-handoff', operations: { proposal: null, resume: true, exit_text_only: false, generation: { mode: 'none', runs: 0, backend: null, intent: '' }, continue_generation: false } });
    question(handoffRequest.consent.question);
    human('同意');
    const pendingHandoff = await action({ action: 'studioApplyConsent', consent_id: handoffRequest.consent.consent_id });
    assert.equal(pendingHandoff.consent.status, 'awaiting_handoff');
    await command({ action: 'studioConsentHandoff', consent_id: handoffRequest.consent.consent_id, page_id: page.page_id, expected_revision: owner.page.revision, client_id: 'consent-cold-owner', lease_token: owner.lease_token, nonce: pendingHandoff.consent.handoff.nonce });
    const handed = await action({ action: 'studioApplyConsent', consent_id: handoffRequest.consent.consent_id });
    assert.equal(handed.page.task.control, 'auto');
    assert.equal(handed.page.task.claimed_runs, 0);
    assert(!JSON.stringify(handed).includes(owner.lease_token));
    assert(!Object.hasOwn(ctx.sessionProjections.snapshot(agent.session).values, 'moss-draw.consent-authority'));
    evidence.chatConsent = { nativeToolResult: true, exactQuestion: true, nativeHumanReply: true, atomicIdempotentBudget: true, preApplyDenied: true, noGenerationDenied: true, cleanManualHandoff: true, hostOnlyProjection: true, submissions: 0 };
  }

  // ---------------------------------------------------------------- store-level renewal / policy contracts
  const { createStudioStore } = await import(urlOf(path.join(packageDir, 'src/studio-store.mjs')));
  const store = createStudioStore({ dataRoot: renewalRoot });
  const renewalSeries = await store.createSeries({ title: 'Renewal fixture' });
  const renewalPage = await store.createPage({ series_id: renewalSeries.series_id, title: 'One page', doc });
  const first = await store.startTask({ page_id: renewalPage.page_id, expected_revision: renewalPage.revision, intent: 'First', max_runs: 1 }, { message_id: 'user-one' });
  const frozenPlan = await store.preparePlan({ page_id: renewalPage.page_id, expected_revision: first.revision, request_key: 'first', settings: { seed: 1 }, assets: [] });
  await store.claimPlan({ plan_id: frozenPlan.plan_id });
  await store.finishPlan({ plan_id: frozenPlan.plan_id, run_id: '00000000-0000-4000-8000-000000000010', status: 'succeeded' });
  await store.notePlan({ plan_id: frozenPlan.plan_id, stage: 'delivered' }, { message_id: 'user-one' });
  assert.equal((await store.taskState({})).tasks[0].binding_active, false);
  const second = await store.startTask({ page_id: renewalPage.page_id, expected_revision: first.revision, intent: 'Second', max_runs: 1 }, { message_id: 'user-two', message_ids: ['user-one', 'user-two'] });
  assert.equal(second.page_id, first.page_id);
  assert.notEqual(second.task.task_id, first.task.task_id);
  assert.equal((await store.taskHistory({ page_id: renewalPage.page_id })).tasks[0].claimed_runs, 1);
  assert.equal((await store.getPlan({ plan_id: frozenPlan.plan_id })).status, 'succeeded');
  evidence.renewal = { samePage: true, historyRetained: true, completedBindingReleased: true, submissions: 0 };

  const seriesProfile = await store.updateSeriesProfile({ series_id: renewalSeries.series_id, expected_revision: 0, style: 'Ink', cast: [] });
  const humanLease = await store.takeover({ page_id: second.page_id, expected_revision: second.revision, client_id: 'cold-human' });
  const shared = await store.applySeriesProfile({ page_id: second.page_id, expected_revision: humanLease.page.revision, lease_token: humanLease.lease_token, profile_revision: seriesProfile.revision, bindings: [], caption_cast_ids: [] });
  assert.equal(shared.doc.shared.style, 'Ink');
  const protectedPage = await store.setEditPolicy({ page_id: second.page_id, expected_revision: shared.revision, lease_token: humanLease.lease_token, policy: { mode: 'descriptions', item_ids: null, summary: true, caption: true, text: false }, editing_only: true });
  const resumedText = await store.resumeTask({ page_id: second.page_id, expected_revision: protectedPage.revision, lease_token: humanLease.lease_token, editing_only: true });
  await assert.rejects(store.preparePlan({ page_id: second.page_id, expected_revision: resumedText.revision, request_key: 'text-block', settings: { seed: 1 }, assets: [] }), { code: 'STUDIO_TEXT_ONLY' });
  evidence.integration = { sharedProfilePinned: true, descriptionPolicyPersisted: true, textOnlyGpuDenied: true, submissions: 0 };

  // ---------------------------------------------------------------- client bundle discovery + zero network
  await loader.root.create({ id: 'client-modules', name: '@deepseek-ai/dsh-client-modules' });
  await loader.await();
  await loader.resolve('client-modules').fiber.await();
  const graph = ctx.clientModules.graph();
  const row = graph.entries.find(entry => entry.id === ID);
  assert(row, 'client entry not discovered');
  assert.equal(ctx.clientModules.clientPath(ID), path.join(packageDir, 'client', 'lib', 'client.js'));
  const response = await ctx.clientModules.fetchBundle({ method: 'GET', url: `http://fixture.invalid/${row.url}` });
  assert.equal(response.status, 200);
  const code = await response.text();
  assert(code.includes('window.__ModuleLoader__.load'));
  evidence.client = { graph, row, path: ctx.clientModules.clientPath(ID), served: { status: response.status, bytes: Buffer.byteLength(code), sha256: sha(code) } };
  fs.writeFileSync(path.join(WORK, 'discovered-client.js'), code);
  fs.writeFileSync(path.join(WORK, 'boot-graph.json'), JSON.stringify(graph, null, 2));

  evidence.sdkResolution = {};
  for (const name of ['schemastery', 'cordis', 'dsh-tools', 'dsh-scope']) {
    const specifier = `@deepseek-ai/${name}`;
    const filename = createRequire(path.join(packageDir, 'src/sdk.mjs')).resolve(specifier);
    assert(filename.toLowerCase().includes('app.asar'), `${specifier} must resolve from the official app.asar SDK`);
    evidence.sdkResolution[specifier] = filename;
  }
  const loadCache = loader.internal.loadCache;
  const loadedUrls = loadCache && typeof loadCache.keys === 'function' ? [...loadCache.keys()] : [];
  evidence.candidateModuleUrls = loadedUrls.filter(url => typeof url === 'string' && url.startsWith(pathToFileURL(packageDir + path.sep).href));
  assert(evidence.candidateModuleUrls.length >= 18, 'too few plugin modules were loaded from the packaged directory');
  assert(!loadedUrls.some(url => typeof url === 'string' && url.includes('/plugins/dsh-moss-draw/')), 'the original source tree leaked into this process');
  assert.deepEqual(evidence.networkAttempts, []);
  assert.deepEqual(evidence.serverAttempts, []);
  await scope.dispose();
  await ctx.fiber.dispose();
  evidence.checks.zeroNetwork = true;
  evidence.pass = true;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({
    pass: evidence.pass,
    version: pkg.version,
    roster: roster[0].id,
    tools: evidence.session.tools,
    guides: evidence.guides.length,
    mossStyles: evidence.context.mossStyles,
    k2DefaultStyle: evidence.context.k2DefaultStyle,
    clientBytes: evidence.client.served.bytes,
    loadedModules: evidence.candidateModuleUrls.length,
    network: evidence.networkAttempts.length,
    servers: evidence.serverAttempts.length,
    out: OUT,
  }));
})().catch(error => {
  evidence.pass = false;
  evidence.error = { message: error.message, stack: error.stack };
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(evidence, null, 2)}\n`);
  } catch { /* best effort */ }
  console.error(error);
  process.exitCode = 1;
});
