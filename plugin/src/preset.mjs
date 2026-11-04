export const TOOL_NAMES = Object.freeze(['art_guide', 'art_context', 'art_generate', 'art_run', 'art_review', 'art_view', 'art_deliver']);
const allowed = new Set(TOOL_NAMES);
const excludedSources = new Set(['agent-instructions', 'skill-catalog', 'skill-invocation']);
export const PERSONA = `你是AI画画执行器，用中文交流。用户本条消息就是这次要画的东西：第一句直接进入画面设计并开始写稿，全程只说画面内容和下一步动作，不问同意也不推迟。设计权在你：用户只给意图时，你自己定机位、构图、光线、服装与画风，用能表达意图的最简稿件直接出图，用户看效果再介入调整。首步只art_guide quick，读完再art_context，不并行。要图时studioStart→studioAgentUpdate写稿→art_view＋studio_inspect→studioPrepare→studioExecute→art_run→art_view→art_review→art_deliver附markdown_link。对话即授权，绝不问同意：直接画、改、采纳、丢弃、交回、开新任务，页上自己的提案按本条消息studioResolve采纳或丢弃；只有用户明确说先给我看/我要审才studioPropose。生成参数可带 loras:[{file,strength,trigger}]（最多4个，file 是 ComfyUI loras/ 下的 .safetensors 相对路径；Qwen 不支持），按列表顺序叠加在内置画风之后，触发词按同一顺序接在正文前。新文生图先建立可编辑 Layout。用 studioCreateSeries/studioCreatePage 创建真实页，studioStart 开任务，studioEdit 编辑分镜、气泡、草图与人偶。人工接管或暂停后只按当前控制权和修订继续。studioPrepare 冻结当前版并检查原生预览，Host 验证回执后才执行。参考图结构识别按需读 analysis。旧任务丢回执只对账，不能重投。便携包 Base/SFT 默认 50 步、CFG 3。Heal 作者示例为 16 步、CFG 3、shift 5、种子 0，使用 Euler 官方训练网格。用户显式参数优先。`;

export async function registerPreset(ctx, { sdk, config }) {
  const dispose = await ctx.agentPresets.register({
    id: 'ai-draw', name: 'AI 画画', description: 'Layout优先的AI画画工作台：Moss/K2文生图、GBC参考结构、Qwen/区域编辑；使用操作者配置的ComfyUI与当前会话模型。',
    plugins: [
      { id: 'moss-persona', name: '@deepseek-ai/dsh-persona', config: { prefix: PERSONA, complete: true, includeRuntimeContext: false } },
      { id: 'moss-scope', name: '@dsh-external/dsh-moss-draw/scope', config },
    ],
  });
  ctx.effect(() => dispose, 'moss.preset');
}

// Registered in the standing preset scope BEFORE a native session joins it.
// No global event rewrite and no late agent/created mount.
export function installScopePolicy(ctx, { sdk }) {
  const scope = sdk.scope.scopeOf(ctx);
  if (scope === undefined) throw new Error('MOSS_SCOPE_REQUIRED');
  ctx.tools.presentAs('native');
  // A preset is an ancestor of each native agent: allow:[] here would also
  // suppress its own Moss tools as seen by a child. Deny current inherited
  // names, and close both late-registration surfaces below.
  const inherited = ctx.tools.schemas(scope).map(x => x.name).filter(name => !allowed.has(name));
  if (inherited.length) ctx.tools.restrict({ deny: inherited });
  ctx.tools.guard(exec => allowed.has(exec.name) ? undefined : 'MOSS_TOOL_DENIED');
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembled = await next();
    return { ...assembled, tools: assembled.tools.filter(t => allowed.has(t.name)) };
  }, { prepend: true });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    if (agent?.session.deriveMessages().some(message => excludedSources.has(message.source?.kind))) throw new Error('MOSS_CONTEXT_HISTORY: start a clean Moss session');
    // Source metadata, not text matching. Human requests and required safety
    // runtime context remain intact; global catalog/instructions never enter log.
    return { ...decision, messages: decision.messages.filter(message => !excludedSources.has(message.source?.kind)) };
  }, { prepend: true });
}
