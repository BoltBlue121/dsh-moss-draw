# dsh-moss-draw · 「AI 画画」DSH 桌面插件

`@dsh-external/dsh-moss-draw` 是 DeepSeek Harness（DSH）Desktop 的一个 bundle 插件：它在 Host 侧注册预设 `ai-draw`（显示名「AI 画画」）、7 个 `art_*` agent 工具和一组按需指南，在客户端注册右侧栏页签「AI画画工作台」。所有图像生成与编辑都由**部署方自己的 ComfyUI** 通过 HTTP 执行；仓库只含插件代码与文档，不含模型权重、不含 LoRA 文件、不含生成物、不含任何凭据。

- 包名 `@dsh-external/dsh-moss-draw`，版本 `0.9.0`。原创代码适用 MIT，随包分发的第三方参考资料另有 CC BY-NC-ND 4.0 条件，见 [第三方说明](plugin/THIRD_PARTY_NOTICES.md)。
- 0.8.0 基线已验证 DSH Desktop `0.2.1-rc.2` / `0.2.1-rc.3` / `0.2.1-rc.5`，矩阵外未验证，见 [docs/05-版本兼容矩阵.md](docs/05-版本兼容矩阵.md)。
- 仓库地址：https://github.com/BoltBlue121/dsh-moss-draw

本文用四个占位符：`<repo>` 表示本仓库根目录，`<DshHome>` 表示 DSH home（默认安装下是 `%USERPROFILE%\.dsh`），`<workspaceRoot>` 表示允许插件读图的绝对目录，`<comfy-host>` 表示 ComfyUI 的主机名或地址。命令默认在 `<repo>` 下执行，均在 Windows PowerShell 5.1 或 PowerShell 7 中有效。


## 0.9.0 工作台

在同一个 DSH 会话里，Agent 可以按需求创建分镜，用户可接手修改，再从保存的修订继续。工作稿支持分镜边框、气泡和草图、可摆姿的人偶与道具。

选用 MOSS-Image-heal 时，KBlueLeaf 的示例预设为 16 步、CFG 3、shift 5、种子 0 和无内置 LoRA。采样采用 KohakuMoss 的 Euler，将 sigma 对齐到 1000 级训练网格，负向分支跳过第 22 层。模型卡及作者实现可从插件的模型选择区打开。

## 功能

7 个工具全部由预设作用域限制，会话里只会出现这 7 个：

| 工具 | 用途 |
|---|---|
| `art_guide` | 按 topic 读本插件自带的按需指南；单次最多 9000 字符，返回 `next_offset` 时继续读 |
| `art_context` | 读本会话的 run 账本、后端/参数目录、工作台文档与 Studio 页/任务状态 |
| `art_generate` | 生成与编辑：`t2i` / `edit` / `inpaint` / `characters` / `regions`；工作台动作走 `art_generate({mode:"workbench",workbench:{action,...}})` |
| `art_run` | 等待某个 run 结束；只查询不重提 |
| `art_review` | 记录对成图的观察、问题与下一版唯一改动 |
| `art_view` | 看结果图、区域计划预览图，或用户在工作区里给出的图片 |
| `art_deliver` | 交付原始生成字节并附预览 |

- **右侧栏工作台「AI画画工作台」**：系列 / 页 / 修订（revision）、Layout 与 Caption 文档、区域（region）绑定与执行、相机与 3D 体块投影、提案与采纳。工作台文档与页由工作台服务读写，不是第二套聊天页面。
- **多后端**：MOSS t2i / edit / inpaint / characters / regions；K2（Krea2）t2i；Qwen-Image-2.1 edit（1–2 张参考图，整图编辑）。
- **多 LoRA 叠加**：`loras: [{file, strength, trigger}]`，最多 4 个，按列表顺序叠加在内置画风链之后，触发词按同一顺序接在正文前。本包内置画风只有 `none`、`lora_strength` 固定 0，LoRA 权重由部署方自备。
- **按需指南**：9 个 topic（`quick`、`index`、`moss-modes`、`k2`、`qwen`、`regions`、`workbench`、`studio`、`promptcraft`），不预载进上下文。
- **可恢复的运行账本**：每个请求有稳定 `request_id` 与落盘的 run 记录，超时只查询同一 run，不重复提交。

## 环境要求

| 项 | 要求 |
|---|---|
| DSH | Desktop `0.2.1-rc.2` / `0.2.1-rc.3` / `0.2.1-rc.5`；已验证环境为 node 24.21.0、pnpm 11.28.5、Electron 44.x |
| 平台 | Windows（安装与验收脚本为 PowerShell，已验证范围仅 Windows Desktop profile） |
| ComfyUI | 部署方自建，裸 origin（如 `http://127.0.0.1:8188`），**从 DSH Host 进程可达** |
| 模型与节点 | 由部署方自备，清单见 [docs/01-适配清单.md](docs/01-适配清单.md) |
| 模型渠道 | 一个能看图的模型渠道（在原生模型栏选择）；插件不内置聊天渠道或 API Key |
| PowerShell | 5.1 或 7（脚本声明 `#Requires -Version 5.1`，不使用 PS7 专有语法） |

ComfyUI 服务可以是本机也可以是内网另一台机器，但必须是 **Host 进程**能直连的地址：插件在 Host 侧发请求，浏览器的网络位置不影响它。URL 不允许带路径、查询串、片段或 userinfo。

## 安装

### 路径 A：安装脚本（推荐，Windows）

脚本做五件事：探测版本与 SDK → 备份 → 拷贝 `plugin\` 到安装根 → 用 `install/adapt.mjs` 写三个配置值 → 在 profile 里建 junction 并登记 bundle。它不重启 DSH，也不会启动第二个实例。

```powershell
# 先演练，不改任何文件
.\install\install.ps1 `
  -DshHome "$env:USERPROFILE\.dsh" `
  -WorkspaceRoot 'D:\work' `
  -ComfyUrl 'http://127.0.0.1:8188' `
  -DryRun

# 演练输出无误后正式安装
.\install\install.ps1 `
  -DshHome "$env:USERPROFILE\.dsh" `
  -WorkspaceRoot 'D:\work' `
  -ComfyUrl 'http://127.0.0.1:8188'
```

参数（`-DshHome`、`-WorkspaceRoot`、`-ComfyUrl` 必填）：

| 参数 | 默认 | 说明 |
|---|---|---|
| `-DshHome` | 无（必填） | 含 `profiles\` 的目录；默认桌面安装是 `%USERPROFILE%\.dsh`，由首次启动 DSH Desktop 创建 |
| `-WorkspaceRoot` | 无（必填） | 绝对路径，必须已存在 |
| `-ComfyUrl` | 无（必填） | 裸 origin，如 `http://127.0.0.1:8188` |
| `-Profile` | `desktop` | profile 名 |
| `-DataRoot` | `<workspaceRoot>\private\workspace\moss-draw` | 数据根，绝对路径 |
| `-DesktopDir` | `%LOCALAPPDATA%\Programs\DeepSeek Harness` | 官方 Desktop 安装目录 |
| `-InstallRoot` | `<DshHome>\plugins\dsh-moss-draw` | 插件源码副本的位置 |
| `-NodeExe` | 官方 Desktop 可执行文件 | 供 `adapt.mjs` 使用的 node；`probe.mjs` 始终通过 Desktop 二进制运行 |
| `-Force` | 关 | 备份后替换已存在的安装根或真实目录链接 |
| `-AllowUnverifiedVersion` | 关 | 版本在矩阵外时继续安装，此后只能标注 experimental |
| `-DryRun` | 关 | 只打印将要做的事，不写文件 |

退出码：`0` 成功；`2` 版本在已验证矩阵之外；`3` 参数或探测失败；`4` 拷贝或写配置失败；`5` 链接失败（目标位置是真实目录且未给 `-Force`，或 junction 创建失败）；`6` profile 的 `package.json` 缺少 `dsh.profile`。

脚本被执行策略拦截时，在该窗口内放行，或对下载的 zip 解包文件解除锁定：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
Unblock-File .\install\install.ps1
```

从下载的 zip 解包可能给文件打上 Mark-of-the-Web，`Unblock-File` 用于清掉它。改执行策略只影响当前窗口，不改机器级配置。

### 路径 B：插件市场 / `dsh plugin add`

DSH 插件管理器（市场 UI）或 `dsh plugin add` 只会把包装进 profile，**不会替换三个占位符**。本仓库是 monorepo 式布局（市场条目指向 `plugin\` 子目录），所以从 GitHub 直接 `dsh plugin add` 不是文档给出的安装路径；用市场 UI 或本地 tgz 装完后，必须补跑一次适配，否则预设不会出现，Host 会报 `MOSS_CONFIG_WORKSPACE` / `MOSS_CONFIG_COMFY_URL` / `MOSS_CONFIG_DATA_ROOT`。

```powershell
# 1) 找到已安装包的实际目录（含 package.json 与 cordis.patch.yml）
# 2) 写入三个配置值：用 Desktop 二进制的 Node 模式，或任意 node 24
$env:ELECTRON_RUN_AS_NODE = '1'
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\DeepSeek Harness.exe" `
  .\install\adapt.mjs `
  --plugin-dir '<已安装的包目录>' `
  --workspace-root '<workspaceRoot>' `
  --comfy-url 'http://127.0.0.1:8188'

# 3) 若用 dsh plugin add（pnpm 只改 dependencies），手工把包名加进 profile 的 bundle 列表
#    <DshHome>\profiles\desktop\package.json 的 dsh.profile.bundles 数组
# 4) 正常重启 DSH
```

`adapt.mjs` 会校验 `<workspaceRoot>` 是已存在的绝对路径、`comfyUrl` 是裸 origin；对已经适配过的文件它会拒绝猜测，需要重新拷贝一份原始 `plugin\` 再适配。

### 路径 C：预编译 tarball

发布产物由仓库脚本生成，构建与校验都在本地完成。**新机器上通常没有 `node` 在 PATH 里**，用官方 Desktop 的 Node 模式即可（装了 node 24 也可以直接 `node`）：

```powershell
$Desktop = "$env:LOCALAPPDATA\Programs\DeepSeek Harness"   # 换成实际安装目录
$env:ELECTRON_RUN_AS_NODE = '1'
& "$Desktop\DeepSeek Harness.exe" .\dist\build-package.mjs
# 产出 dist\dsh-external-dsh-moss-draw-0.9.0.tgz、dist\package-manifest.json、dist\SHA256SUMS.txt

Get-Content .\dist\SHA256SUMS.txt
Get-FileHash .\dist\dsh-external-dsh-moss-draw-0.9.0.tgz -Algorithm SHA256
```

用 `SHA256SUMS.txt` 与 `package-manifest.json`（逐文件 sha256）核对 tarball，然后装它（**GitHub Releases 发布页已附同一份 tgz、`SHA256SUMS.txt` 与源码 zip，不必自己构建**）：

- **推荐**：DSH 侧栏 → 插件 → **添加插件**，填 tarball 的**绝对路径**，装完在插件页启用。桌面 profile 由 Desktop 应用独占，`dsh plugin --profile desktop` 会被拒绝（`profile "desktop" is managed exclusively by the Electron application`），不要用命令行往桌面 profile 里装。
- 非桌面 profile（或 CLI 可用时）用：

```powershell
dsh plugin add ./dsh-external-dsh-moss-draw-0.9.0.tgz
```

接着按路径 B 的 2)–3) 执行：适配占位符、确认 `dsh.profile.bundles` 含 `@dsh-external/dsh-moss-draw`（插件管理器启用时会自己写；手工 `dsh plugin add` 只改 `dependencies`，要你补），再正常重启 DSH。

## 首次运行（冒烟，不需要 GPU）

1. 正常退出并重新启动 DSH Desktop（不要强杀正在运行的 Host）。
2. 新建一个空白会话。
3. Agent preset 选「AI 画画」（id `ai-draw`）。
4. 在原生模型栏选择一个能看图的模型渠道。
5. 发一句：「先读 `art_guide quick`，然后列出你注册的 7 个 `art_*` 工具名称」。

预期：`art_guide` 返回 quick 页文本；工具列表恰好是 `art_guide`、`art_context`、`art_generate`、`art_run`、`art_review`、`art_view`、`art_deliver`。这一步不提交任何 ComfyUI 任务，不需要 GPU。右侧栏应出现「AI画画工作台」页签。

## 配置

配置写在插件自带的 `plugin\cordis.patch.yml` 里，随包只有三个占位符；安装路径 A 会自动替换，路径 B/C 需要手工跑一次 `adapt.mjs`：

| 键 | 必填 | 默认 | 说明 | 校验失败错误码 |
|---|---|---|---|---|
| `workspaceRoot` | 是 | 无 | 绝对路径。插件只读取该根内、且在本会话消息里被用户点名过的本地图片 | `MOSS_CONFIG_WORKSPACE` |
| `comfyUrl` | 是 | 无 | 裸 http(s) origin，不带 path/query/hash/userinfo | `MOSS_CONFIG_COMFY_URL` |
| `dataRoot` | 否 | `<workspaceRoot>\private\workspace\moss-draw` | 绝对路径。工作台 SQLite、会话账本、run 记录与生成图都在这里 | `MOSS_CONFIG_DATA_ROOT` |
| `editEngine` | 否 | `native` | `native` 或 `legacy`；只有旧 ComfyUI 核心才考虑 `legacy` | `MOSS_CONFIG_EDIT_ENGINE` |

`cordis.patch.yml` 里的占位符是 `__MOSS_WORKSPACE_ROOT__`、`__MOSS_COMFY_URL__`、`__MOSS_DATA_ROOT__`。它们必须被替换成真实的本地绝对路径，这正是「只装包、直接启动 DSH」不成立的原因：插件需要部署方自己的目录与 ComfyUI 地址。

## 验证与回滚

```powershell
# 验收：探测、插件单测、真实 loader 冷加载、客户端 bundle 加载、个人信息扫描、包完整性
.\verify\run-verify.ps1 `
  -KitRoot . `
  -DesktopDir "$env:LOCALAPPDATA\Programs\DeepSeek Harness" `
  -DshHome "$env:USERPROFILE\.dsh"
```

证据 JSON 与日志写到 `-OutDir`（默认 `<repo>\verification`，属运行产物；仓库 `.gitignore` 已忽略 `verification/`、`.verify-work/`、`.work/`）。详见 [docs/03-验证与验收.md](docs/03-验证与验收.md)。

```powershell
# 回滚：从最新的 portable-moss-draw-* 备份恢复 profile，并移除 junction
.\install\rollback.ps1 -DshHome "$env:USERPROFILE\.dsh"
```

回滚恢复的是**上一次安装之前**的 profile 状态，不是完整卸载；它不会删除数据根（工作台 SQLite 与生成图）。退出码：`0` 成功；`3` 参数错误或找不到备份；`5` 期望移除 junction 但遇到真实目录且未给 `-Force`。

## 仓库结构

```text
repo\
├─ README.md              本文件（GitHub 与插件市场入口）
├─ LICENSE                MIT
├─ plugin\                插件包（package.json 声明 dsh.bundle 与 dsh.client）
│  ├─ package.json        包元数据、DSH peer 依赖、files 白名单
│  ├─ host.mjs            Host 入口（注册预设）
│  ├─ cordis.patch.yml    bundle 补丁：moss-draw 与 moss-workbench-query 两条 insert + 三个占位符
│  ├─ src\                工具、后端适配、区域执行、工作台与存储
│  ├─ client\             右侧栏工作台前端（client\lib\client.js 为构建产物）
│  ├─ skills\ai-drawing\  art_guide 的按需指南页
│  ├─ templates\          ComfyUI 工作流模板
│  ├─ worker\             可选的自加画风 LoRA 配套节点源码（默认链路不引用）
│  └─ tests\              单元与集成测试
├─ install\               install.ps1、rollback.ps1、probe.mjs、adapt.mjs
├─ verify\                run-verify.ps1、cold-load.cjs、client-load.cjs、sanitize-scan.mjs、verify-package.mjs
├─ dist\                  打包脚本；运行后产出 *.tgz、package-manifest.json、SHA256SUMS.txt
└─ docs\                  01 适配清单 / 02 部署流程 / 03 验证与验收 / 04 内容与隐私 / 05 版本兼容
```

## 版本兼容

| DSH Desktop | 结论 | 证据 |
|---|---|---|
| `0.2.1-rc.2` | 已验证 | 1008 个单元测试 + real-loader cold load + client bundle load |
| `0.2.1-rc.3` | 已验证 | 1008 个单元测试 + real-loader cold load + client bundle load |
| `0.2.1-rc.5` | 已验证 | 1008 个单元测试 + real-loader cold load + client bundle load |
| 其它版本 | 未验证 | `install/probe.mjs` 退出码 `2`、`decision=refused`；`-AllowUnverifiedVersion` 后只能标注 experimental |

已验证环境为 node 24.21.0、pnpm 11.28.5、Electron 44.x。矩阵外版本要么先跑完整验收，要么明确接受「未验证」，见 [docs/05-版本兼容矩阵.md](docs/05-版本兼容矩阵.md)。

## 安全与隐私

- 仓库只含作者自己的代码与文档：没有第三方提示词库原文、没有模型权重、没有 LoRA 权重、没有生成图片、没有凭据、没有个人绝对路径。
- 插件只通过 HTTP 与部署方指定的 ComfyUI origin 通信；不上传图片或文本到任何第三方服务。它只读取 `<workspaceRoot>` 内、且在当前消息里被用户点名过的本地图片。
- 插件不内置聊天渠道、不保存 API Key；模型渠道由部署方在原生模型栏选择。
- 运行数据全部落在 `dataRoot`：`workbench\documents.sqlite`、`studio\editor.sqlite`、`sessions\<session>\` 下的请求账本、run 记录与生成图。换机器或换工作区须重新配置并从头开始。
- 提交前跑 `verify/sanitize-scan.mjs`（0 命中才发布），说明见 [docs/04-内容与隐私说明.md](docs/04-内容与隐私说明.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。模型权重、ComfyUI 自定义节点与部署方自备的 LoRA 各有自己的许可证，由部署方获取并遵守；本仓库不包含、也不转授这些资产。

## English

- `@dsh-external/dsh-moss-draw` 0.8.0 is a DeepSeek Harness Desktop bundle plugin: preset `ai-draw` ("AI 画画"), seven `art_*` tools, and a right-sidebar workbench tab.
- Text-to-image, edit, inpaint, character, and region pipelines run on a ComfyUI instance you host; the repository ships no model weights, no LoRA files, no generated artwork, and no credentials.
- Verified on Windows against DSH Desktop `0.2.1-rc.2`, `0.2.1-rc.3`, and `0.2.1-rc.5`; other versions are unverified.
- The package ships three `__MOSS_*__` placeholders that must be replaced with your absolute `workspaceRoot`, `comfyUrl`, and `dataRoot` (run `install/install.ps1`, or `install/adapt.mjs` after a marketplace install) before DSH can load the preset.
- Installation, verification, and rollback commands are in the Chinese sections above; documentation is Chinese-only. License: MIT.
