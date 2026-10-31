#!/usr/bin/env node
/*
 * Client-bundle acceptance for the portable AI drawing workbench plugin.
 *
 * Reuses the artifacts written by verify/cold-load.cjs (boot-graph.json and
 * discovered-client.js) and loads the REAL official browser module runtime from
 * the Desktop app.asar against an in-memory transport. Proves the shipped
 * client bundle parses, honours its declared inject list, waits for injection,
 * registers the workbench tab and slots, disposes cleanly, and never needs the
 * network or a real browser.
 *
 * Run under the official Desktop executable in Node mode:
 *   $env:ELECTRON_RUN_AS_NODE = '1'
 *   & "<DesktopDir>\DeepSeek Harness.exe" "verify\client-load.cjs" --kit "<kit>"
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
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
const WORK = path.resolve(args.work ?? path.join(KIT, '.verify-work'));
const OUT = path.resolve(args.out ?? path.join(WORK, 'client-load.json'));
const ID = '@dsh-external/dsh-moss-draw';
const desktopDir = path.resolve(args.desktopDir ?? process.env.DSH_DESKTOP_DIR ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness'));
const base = path.join(desktopDir, 'resources', 'app.asar', 'dsh', 'package.json');

if (!process.versions.electron) {
  console.error('client-load: run with the official Desktop executable and ELECTRON_RUN_AS_NODE=1.');
  process.exit(3);
}
if (!fs.existsSync(path.join(WORK, 'boot-graph.json')) || !fs.existsSync(path.join(WORK, 'discovered-client.js'))) {
  console.error(`client-load: cold-load artifacts not found in ${WORK}; run verify/cold-load.cjs first.`);
  process.exit(3);
}

const result = { schema: 1, kit: KIT, workDir: WORK, network: 0, server: 0, uiRender: false, checks: {} };
const r = createRequire(base);

(async () => {
  const graph = JSON.parse(fs.readFileSync(path.join(WORK, 'boot-graph.json'), 'utf8'));
  const row = graph.entries.find(entry => entry.id === ID);
  assert(row, 'plugin client entry missing from boot graph');
  const pkg = JSON.parse(fs.readFileSync(path.join(WORK, 'package', 'package.json'), 'utf8'));
  assert.deepEqual(row.inject, pkg.dsh.client.inject, 'client inject declaration drifted from package.json');
  const deps = new Map();
  const visit = id => {
    if (deps.has(id)) return;
    const dep = r(id + '/package.json');
    deps.set(id, dep.dsh?.client ?? {});
    for (const next of dep.dsh?.client?.inject ?? []) visit(next);
  };
  row.inject.forEach(visit);
  assert(deps.has('@deepseek-ai/dsh-client-ui-renderer'));
  assert(deps.has('@deepseek-ai/dsh-api-gateway'));
  result.metaInject = {
    declared: row.inject,
    transitive: [...deps.keys()],
    providers: {
      sidebarRightTabs: '@deepseek-ai/dsh-client-ui-sidebar-right',
      slots: '@deepseek-ai/dsh-client-ui-renderer',
      remote: '@deepseek-ai/dsh-api-gateway',
      sessions: '@deepseek-ai/dsh-api-session-controller',
    },
  };

  const bootCode = fs.readFileSync(r.resolve('@deepseek-ai/dsh-client-modules/client'), 'utf8');
  const candidateCode = fs.readFileSync(path.join(WORK, 'discovered-client.js'), 'utf8');
  let createElementReads = 0;
  const ReactSeed = {
    get createElement() {
      createElementReads += 1;
      return () => { throw new Error('RENDER_NOT_IN_SCOPE'); };
    },
  };
  function setup(staticModules) {
    const facade = { mode: 'queue', pendingQueue: [], load(registration) { this.pendingQueue.push(registration); } };
    const context = vm.createContext({ window: { __ModuleLoader__: facade }, console, URL, AbortController, structuredClone, setTimeout, clearTimeout });
    vm.runInContext(bootCode, context);
    const bootstrap = facade.pendingQueue.shift();
    const exports = bootstrap.factory(() => { throw new Error('unexpected bootstrap require'); });
    const urls = [];
    const modules = exports.createClientModuleSystem(facade, { id: bootstrap.id, exports }, {
      boot: graph,
      staticModules,
      loadBundle: async url => {
        urls.push(url);
        assert(url.includes(ID));
        vm.runInContext(candidateCode, context, { filename: 'official-discovered-candidate.js' });
      },
    });
    return { modules, context, urls };
  }

  const negative = setup({});
  let requireError;
  try { await negative.modules.import(ID); } catch (error) { requireError = error.message; }
  assert.match(requireError, /require\("react"\) missed the module table/);
  result.checks.noReactSeedReject = requireError;

  const { modules, urls } = setup({ react: ReactSeed });
  const plugin = await modules.import(ID + '/client');
  assert.equal(await modules.import(ID), plugin);
  assert.deepEqual(Array.from(plugin.inject), ['sidebarRightTabs', 'sidebarRight', 'slots', 'remote', 'remote.commands', 'sessions']);
  result.factory = { requests: ['react'], aliasSameInstance: true, exportedInject: Array.from(plugin.inject), urls };

  const { Context } = r('@deepseek-ai/cordis');
  const { Loader } = r('@deepseek-ai/cordis-plugin-loader');
  const ctx = new Context();
  const loader = new Loader(ctx, { baseUrl: 'file:///portable-client/' });
  loader.internal = modules;
  const tabs = [];
  const slots = [];
  let disposals = 0;
  ctx.reflect.provide('sidebarRightTabs', { register(tab) { tabs.push(tab); return () => { disposals += 1; }; } });
  ctx.reflect.provide('slots', {
    inject(name, callback) { assert.ok(['sidebar.right.pane.tab', 'conversation.view'].includes(name)); return callback(); },
    register(spec, body) { slots.push({ spec, body }); return () => { disposals += 1; }; },
  });
  ctx.reflect.provide('remote', { get() { throw new Error('REMOTE_NOT_IN_SCOPE'); } });
  ctx.reflect.provide('remote.commands', {});
  ctx.reflect.provide('sidebarRight', { mounted: { getSnapshot: () => undefined }, openTab() { throw new Error('NO_OPEN_EXPECTED'); } });
  await modules.entries.start(loader, modules.manifest);
  await loader.await();
  const entry = [...loader.entries()].find(candidate => candidate.options.name === ID);
  assert(entry?.fiber);
  assert.notEqual(entry.fiber.state, 2);
  assert.equal(tabs.length, 0);
  result.injectGate = { missing: 'sessions', stateBefore: entry.fiber.state };
  ctx.reflect.provide('sessions', { binding() { return undefined; } });
  await ctx.fiber.await();
  await loader.await();
  await entry.fiber.await();
  assert.equal(entry.fiber.state, 2);
  assert.equal(tabs.length, 1);
  assert.equal(slots.length, 2);
  assert.ok(createElementReads > 0, 'the workbench tab must render at least once');
  result.injectGate.stateAfter = entry.fiber.state;
  result.registrations = { tab: tabs[0].id, slot: slots[0].spec.name, bodyType: typeof slots[0].body, createElementReads };
  await ctx.fiber.dispose();
  assert.equal(disposals, 3);
  result.disposals = disposals;

  // The served candidate must not contain the private style registry that the
  // portable build removed.
  assert(!privateMarker.test(candidateCode), 'client bundle still mentions a private style or provider');
  result.checks.noPrivateStrings = true;
  result.pass = true;
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({
    pass: result.pass,
    tab: result.registrations.tab,
    slots: slots.length,
    injectGate: result.injectGate.missing,
    createElementReads,
    disposals,
    bundleBytes: Buffer.byteLength(candidateCode),
    out: OUT,
  }));
})().catch(error => {
  result.pass = false;
  result.error = error.stack;
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  } catch { /* best effort */ }
  console.error(error);
  process.exitCode = 1;
});
