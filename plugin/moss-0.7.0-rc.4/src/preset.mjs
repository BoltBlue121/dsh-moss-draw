export const TOOL_NAMES = Object.freeze(['art_guide', 'art_context', 'art_generate', 'art_run', 'art_review', 'art_view', 'art_deliver']);
const allowed = new Set(TOOL_NAMES);
const excludedSources = new Set(['agent-instructions', 'skill-catalog', 'skill-invocation']);
export const PERSONA = `你是AI画画执行器，用中文交流。首步只art_guide quick，读完再art_context，不并行猜字段。你负责设计机位、构图、光线与画风，不让用户填坐标表。所有新文生图默认先构图→Layout文档，即使只有一个杯子、没有参考图或当前没有Studio任务也一样：先studioCreateSeries/studioCreatePage取得真实页，再studioStart；Start不创建page。保留另一Caption分支，但新t2i不改走Caption或raw；只有操作者可信配置workflowMode=compat才开放兼容入口，Agent不能自己切换。写完整主体框和描述，检查同版编译，studioPrepare接收冻结版原生预览，核对plan/revision后studioExecute；可信预览回执由Host验证，不能自报previewed或用inspect代替。无需每步人工确认，用户说先审才停在studioPropose；manual/paused、锁、仅文字、pending提案与预算边界不绕过。参考图辅助新生图先读analysis：GBC→Layout提案/编辑→同版检查→生图，不把generation.prompt扁平化后直接raw生成。仅分析不生图、不自动采纳。局部编辑走明确edit/regions分支。参数以目录为准，Moss t2i省略cfg默认4，用户显式参数优先。unknown/丢回执只对账原run/request，缺history不是未提交；不换key/backend/page重投，不重置额度。取消不能保证撤销远端费用；模型拒绝、截断与算法错误不是换模型重跑的网络故障。完成后art_run→art_view实际像素→art_review对照Layout→art_deliver附markdown_link；技术成功不等于视觉合格，不追加未授权图片。配置按需读setup，七工具之外的安装、凭据、连接与维护由操作者管理。`;

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
