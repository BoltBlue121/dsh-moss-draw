# @dsh-external/dsh-moss-draw（运行时包）

本目录是插件包本体。它随 `dsh.bundle.patch` 与 `dsh.client` 声明被 DSH Desktop 加载：Host 侧注册 agent 预设 `ai-draw`（显示名「AI 画画」）与 7 个 `art_*` 工具，客户端侧注册右侧栏页签「AI画画工作台」。图像生成与编辑由部署方自己的 ComfyUI 通过 HTTP 执行；包内没有模型权重、没有 LoRA 文件、没有生成物、没有凭据。

本包版本 `0.8.0`，许可 MIT。**安装、配置、验证与回滚请回仓库根目录的 [README](../README.md)**（那是指定入口，本文件不重复安装步骤，只有这一行说明）。

## Host 侧加载什么

`package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`，该补丁插入两个 loader 条目：

| loader id | 入口 | 作用 |
|---|---|---|
| `moss-draw` | `@dsh-external/dsh-moss-draw`（`host.mjs`） | 注册预设、作用域与 7 个工具、工作台 Host、数据存储 |
| `moss-workbench-query` | `@dsh-external/dsh-moss-draw/query`（`src/workbench-query-host.mjs`） | 客户端只读查询通道（Studio 任务状态等） |

`exports` 映射：`.` → `host.mjs`；`./scope` → `src/tools.mjs`；`./query` → `src/workbench-query-host.mjs`；`./client` → `client/lib/client.js`；`./package.json`。

### 预设

`registerPreset` 注册预设 `ai-draw`，显示名「AI 画画」，其内部组合为：

- `@deepseek-ai/dsh-persona`（`moss-persona`）：preset persona，规定「首步 `art_guide quick`、再 `art_context`」的读取顺序与工作台动作路由。
- `@dsh-external/dsh-moss-draw/scope`（`moss-scope`）：在该作用域内只保留 7 个 `art_*` 工具，屏蔽继承来的其它工具，并从系统提示与历史里过滤全局 skill 目录/instructions 消息来源。

### 7 个工具

预设作用域内只有这 7 个工具：

| 工具 | 契约要点 |
|---|---|
| `art_guide` | `{topic, offset, limit}`；topic 见下；单次最多 9000 字符，`next_offset` 非 null 时继续读 |
| `art_context` | 单形状查询：空对象 / `{limit}` / `{run_id}` / `{documents:true}` / `{document_id}` / `{studio_pages:true}` / `{studio_tasks:true}` / `{studio_consent:true}` / `{studio_page_id}`（可加 `studio_status` 或 `studio_inspect`）。不混用形状 |
| `art_generate` | `backend` ∈ `moss`/`k2`/`qwen`；`mode` ∈ `t2i`/`edit`/`inpaint`/`characters`/`regions`/`workbench`。原始生成必须带稳定 `request_id` 与 `prompt`；工作台动作只能写成 `art_generate({mode:"workbench",workbench:{action,...}})` |
| `art_run` | `{run_id}`；只查询与等待，不重复提交 |
| `art_review` | `{run_id, observations, issues, next_change}`；观察 ≤12 条×500 字符，问题 ≤12 条×160 字符，下一改动 ≤500 字符 |
| `art_view` | `{run_id}` 或 `{path}` 或 `{studio_page_id}` 三选一；`variant` 仅用于 run（`result`/`preview`） |
| `art_deliver` | `{run_id}`；交付原始生成字节并附预览 |

工作台动作（`art_generate` 的 `workbench.action`）共 15 个：`create`、`propose`、`materialize`、`importPlan`、`studioCreateSeries`、`studioCreatePage`、`studioPropose`、`studioResolve`、`studioStart`、`studioAgentUpdate`、`studioOpen`、`studioPrepare`、`studioExecute`、`studioRequestConsent`、`studioApplyConsent`。

## 客户端加载什么

`dsh.client` 声明 `platform: web`，注入 `@deepseek-ai/dsh-client-ui-sidebar-right`、`@deepseek-ai/dsh-client-ui-conversation`、`@deepseek-ai/dsh-api-session-controller`。运行时入口是构建产物 `client/lib/client.js`（由 `scripts/build-client.mjs` 从 `client/*.mjs` 生成，随包分发，不手改）。

- 页签：`sidebarRightTabs.register({id:'@dsh-external/dsh-moss-draw/workbench', title:'AI画画工作台', keepMounted:true, guide:[{id:'workbench',...}]})`。
- 面板：`sidebar.right.pane.tab` 槽位挂工作台主体；`conversation.view` 另注册一个「MOSS工作台」视图（order 35）。
- 查询：通过官方 Client Remote 挂载只读命名空间，客户端不写库、不调用工具。
- 工作台能力：系列、页、修订（revision）、Layout 与 Caption 文档、区域（region）绑定与执行、相机（orbit/pitch/roll/distance/fov/pan）与 3D 体块投影、提案与采纳、档案与参考图。

## 配置键

`cordis.patch.yml` 随包只有三个占位符，必须由部署流程替换成真值；未替换时 Host 的配置校验直接失败：

| 键 | 必填 | 默认 | 校验失败 |
|---|---|---|---|
| `workspaceRoot` | 是 | 无 | `MOSS_CONFIG_WORKSPACE` |
| `comfyUrl` | 是 | 无 | `MOSS_CONFIG_COMFY_URL` |
| `dataRoot` | 否 | `<workspaceRoot>/private/workspace/moss-draw` | `MOSS_CONFIG_DATA_ROOT` |
| `editEngine` | 否 | `native` | `MOSS_CONFIG_EDIT_ENGINE` |

占位符：`__MOSS_WORKSPACE_ROOT__`、`__MOSS_COMFY_URL__`、`__MOSS_DATA_ROOT__`。`workspaceRoot` 是插件唯一允许读取用户图片的根；`comfyUrl` 必须是裸 http(s) origin（不带 path/query/hash/userinfo）；`dataRoot` 必须是绝对路径。

## 版本与依赖

- `engines.node`: `>=24 <25`；`engines.dsh`: `0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.5`。
- peer 依赖：`@deepseek-ai/schemastery` `3.18.5`、`@deepseek-ai/cordis` `4.0.5` 精确版本；`@deepseek-ai/dsh-tools`、`dsh-commands`、`dsh-typert-protocol`、`dsh-typert-registry`、`dsh-scope`、`dsh-persona`、`dsh-agent-preset-registry`、`dsh-attachment`、`dsh-session`、`dsh-system-prompt` 均为 `0.2.1-rc.2 || 0.2.1-rc.3 || 0.2.1-rc.5`。
- 已验证 DSH Desktop `0.2.1-rc.2`、`0.2.1-rc.3`、`0.2.1-rc.5`（node 24.21.0、pnpm 11.28.5、Electron 44.x）。矩阵外版本未验证，判定与豁免语义见 [docs/05-版本兼容矩阵.md](../docs/05-版本兼容矩阵.md)。

## 按需指南

`art_guide` 从 `skills/ai-drawing/` 读取 9 个 topic，不预载进上下文：

| topic | 来源 |
|---|---|
| `quick` | `SKILL.md` |
| `index` | 内置索引（各页用途） |
| `moss-modes` | `references/moss-modes.md` |
| `k2` | `references/k2.md` |
| `qwen` | `references/qwen.md` |
| `regions` | `references/regions.md` |
| `workbench` | `references/workbench.md` |
| `studio` | `references/studio.md` |
| `promptcraft` | `references/promptcraft.md` |

分页：`offset` 从 0 起，`limit` 默认 6000、最大 9000；`next_offset` 为 null 表示读完。

## 数据根布局

运行数据全部落在 `dataRoot`，不写回包目录：

```text
<dataRoot>\
├─ sessions\<sessionId>\            每个会话独立的账本（工具不跨会话扫描）
│  ├─ requests\<sha256>.json        请求占位（防重复提交）
│  ├─ runs\<runId>\run.json         运行记录与状态
│  ├─ runs\<runId>\graph.json       实际提交的 ComfyUI 图
│  ├─ runs\<runId>\review.json      art_review 记录
│  ├─ runs\<runId>\image.png        生成结果（正式产物）
│  └─ region-pipelines\             区域执行的调度与中间图
│     ├─ scheduler.sqlite           跨进程锁
│     └─ runs\<planId>\             run.json、preview.png、crop-N.png、mask-N.png、canvas-N.png
├─ workbench\
│  └─ documents.sqlite              工作台文档（Layout/Caption、提案）
└─ studio\
   ├─ editor.sqlite                 系列、页、修订、提案与任务
   └─ archive.sqlite                档案
```

生成图只按 run 记录引用，`art_view`/`art_deliver` 会校验 sha256 与尺寸；账本与工作台数据不随包分发，换机器或换工作区必须重新配置。

## 多 LoRA 契约

生成参数与工作台区域都接受 `loras`：

```json
{"loras":[{"file":"style/a.safetensors","strength":0.8,"trigger":"moss style"},{"file":"b.safetensors","trigger":"x"}]}
```

- 最多 4 条，按列表顺序叠加；在内置画风链之后依次插入 `LoraLoaderModelOnly`。
- `file`：相对于 ComfyUI `loras/` 目录的 `.safetensors` 路径（≤240 字符，不得以 `/` 开头、不得含 `..`）。插件不下载、不复制、不在本地解析该文件。
- `strength`：0–2，默认 1；为 0 的条目不会插入节点。
- `trigger`：≤500 字符；非空且强度非 0 的触发词按同一顺序接在正文前，用换行分隔。
- 同名（大小写不敏感）的 `file` 会被拒绝；Qwen 后端不接受 `loras`。
- 区域（region）支持同一份 `loras`，工作台区域编辑器可逐行增删。
- 本包**不含 LoRA 权重、也不含内置画风 LoRA**：`style` 只有 `none`，`lora_strength` 必须为 0，`worker/moss-draw-style/` 只是部署方以后自加画风时的可选节点源码（二次开发，不在本包支持范围）。

## 边界

- 生成质量、多人/多参考身份一致性、四参考、复杂遮挡与长时运行不在已验证范围；`regions` 与多参考 native edit 仍属 experimental，需逐图审。
- 不内置聊天渠道或 API Key；模型渠道由部署方在原生模型栏选择，且该渠道必须能看图。
- 不是模型作者或任何第三方节点的官方发行版；模型、自定义节点与 LoRA 各自的许可证仍适用。
