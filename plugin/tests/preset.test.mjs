import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

// Dependency doubles use the 0.2.1-rc.2 public scope/registry/waterfall signatures.
const subject = () => import('../src/preset.mjs');
function context() {
  const handlers = new Map(), denied = [], guards = [];
  const ctx = {
    tools: {
      schemas: () => [{ name: 'pwsh' }, { name: 'skill' }, ...names.map(name => ({ name }))],
      restrict: filter => denied.push(filter), guard: fn => guards.push(fn), presentAs: mode => { ctx.mode = mode; },
    },
    on(event, fn, options) { const list = handlers.get(event) ?? []; options?.prepend ? list.unshift(fn) : list.push(fn); handlers.set(event, list); },
    sessionProjections: { stateOf: session => session.selection ?? { pending: null } },
  };
  const invoke = async (event, args, value) => {
    const list = handlers.get(event) ?? [];
    const call = i => i === list.length ? Promise.resolve(value) : list[i](...args, () => call(i + 1));
    return call(0);
  };
  return { ctx, denied, guards, invoke };
}
const names = ['art_guide','art_context','art_generate','art_run','art_review','art_view','art_deliver'];
const sdk = { scope: { scopeOf: () => ({}) }, pluginUrl: name => `file:///sdk/${name}.js` };
const config = { workspaceRoot: path.resolve('fixture-workspace'), dataRoot: path.resolve('fixture-workspace/moss-draw'), comfyUrl: 'http://localhost:8188' };

test('native preset eagerly composes complete persona and its own scope, never a global skill loader', async () => {
  const { registerPreset } = await subject();
  let definition;
  await registerPreset({ agentPresets: { register: async value => { definition = value; return () => {}; } }, effect: fn => fn() }, { sdk, config });
  assert.equal(definition.id, 'ai-draw');
  assert.equal(definition.name, 'AI 画画');
  assert.equal(definition.plugins.length, 2);
  assert.equal(definition.plugins[0].name, '@deepseek-ai/dsh-persona');
  assert.equal(definition.plugins[0].config.complete, true);
  assert.equal(definition.plugins[0].config.includeRuntimeContext, false);
  assert.match(definition.plugins[0].config.prefix, /art_guide/);
  assert.equal(definition.plugins[1].name, '@dsh-external/dsh-moss-draw/scope');
  assert.deepEqual(definition.plugins[1].config, config);
  assert.ok(!JSON.stringify(definition).includes('dsh-skill'));
});

test('registered short workbench persona keeps seven native tools and on-demand guidance',async()=>{
  const {registerPreset,TOOL_NAMES}=await subject();let definition;
  await registerPreset({agentPresets:{register:async value=>{definition=value;return()=>{};}},effect:fn=>fn()},{sdk,config});
  // The persona stays a short execution contract: it names the guide entry, the one
  // routed page and the drawing chain, and pushes no workbench trivia into every turn.
  const text=definition.plugins[0].config.prefix;assert(text.length<1200);assert(text.includes('art_guide'));assert(!text.includes('unrestricted'));assert(text.includes('loras'));assert(text.includes('art_deliver'));assert.deepEqual([...TOOL_NAMES],names);
  assert(text.includes('用户')&&text.includes('采纳'));assert(!text.includes('默认已切native'));
});

test('standing scope denies inherited maintenance tools, blocks late same-agent tools and filters schemas', async () => {
  const { installScopePolicy } = await subject();
  const { ctx, denied, guards, invoke } = context();
  installScopePolicy(ctx, { sdk });
  assert.equal(ctx.mode, 'native');
  assert.deepEqual(denied, [{ deny: ['pwsh', 'skill'] }]);
  assert.equal(guards[0]({ name: 'art_generate' }), undefined);
  assert.match(guards[0]({ name: 'schedule_create' }), /MOSS_TOOL_DENIED/);
  assert.match(guards[0]({ name: 'skill', args: { name: 'moss-prompt' } }), /MOSS_TOOL_DENIED/);
  const assembly = { sections: [{ name: 'persona', text: 'x' }], contexts: [{ name: 'required-safety', text: 'keep' }], tools: [...names.map(name => ({ name })), { name: 'spawn_teammate' }, { name: 'schedule_create' }], variables: {} };
  const agent = { session: { requestHeader: () => undefined } };
  const out = await invoke('system-prompt/assemble', [assembly, { scope: agent }], assembly);
  assert.deepEqual(out.tools.map(x => x.name), names);
  assert.deepEqual(out.contexts, assembly.contexts, 'required runtime facts are not erased');
  assert.equal(assembly.tools.length, 9, 'never mutate caller assembly');
});

test('scope removes automatic global skill and AGENTS messages but preserves human text, pixels and safety context', async () => {
  const { installScopePolicy } = await subject();
  const { ctx, invoke } = context();
  installScopePolicy(ctx, { sdk });
  const human = { source: { kind: 'user' }, content: [{ type: 'text', text: 'AGENTS.md and skill-catalog are words I typed' }, { type: 'image', attachment: { id: 'reference' } }] };
  const safety = { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'required sandbox safety' }] };
  const messages = [human, safety, ...['agent-instructions', 'skill-catalog', 'skill-invocation'].map(kind => ({ source: { kind }, content: [] }))];
  const result = await invoke('agent/pre-step', [{ agent: { session: { deriveMessages: () => [] } } }], { kind: 'enter', messages });
  assert.deepEqual(result.messages, [human, safety]);
  const reject = { kind: 'reject', reason: 'safety' };
  assert.equal(await invoke('agent/pre-step', [{}], reject), reject);
});

test('Moss never secretly overrides native model selection or attachment admission route', async () => {
  const { installScopePolicy } = await subject();
  const { ctx, invoke } = context(); installScopePolicy(ctx, { sdk });
  const defaultAgent = { session: { requestHeader: () => undefined } };
  const value = { provider: 'host-default', model: 'coding-model', reasoningEffort: 'high' };
  assert.deepEqual(await invoke('agent/request', [{ agent: defaultAgent }], value), value);
  const assembly = { tools: [], variables: { provider: 'host-default', model: 'coding-model' } };
  assert.deepEqual((await invoke('system-prompt/assemble', [assembly, { scope: defaultAgent }], assembly)).variables, assembly.variables);
  const explicit = { session: { selection: { pending: { provider: 'chosen', model: 'vision' } }, requestHeader: () => undefined } };
  assert.deepEqual(await invoke('agent/request', [{ agent: explicit }], value), value);
  const resumed = { session: { requestHeader: () => ({ config: value }) } };
  assert.deepEqual(await invoke('agent/request', [{ agent: resumed }], value), value);
});

test('scope refuses resumed foreign skill instructions rather than silently sending contaminated history', async () => {
  const { installScopePolicy } = await subject();
  const { ctx, invoke } = context(); installScopePolicy(ctx, { sdk });
  await assert.rejects(invoke('agent/pre-step', [{ agent: { session: { deriveMessages: () => [{ source: { kind: 'skill-invocation', name: 'maintenance' } }] } } }], { kind: 'enter', messages: [] }), /MOSS_CONTEXT_HISTORY/);
});
