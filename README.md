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

### 路径 B　从源码目录安装

从本版源码 zip 中复制 `plugin` 到长期保留的新目录。在这个副本上填写作品根目录、ComfyUI 地址和数据根目录，然后通过官方插件管理器添加并启用它的 `link:` 源。[适配与链接步骤](docs/02-部署流程.md#install-verified-bundle)

### 路径 C　从 Release 安装

下载同一版本的 `dsh-external-dsh-moss-draw-0.9.0.tgz`、`SHA256SUMS.txt`、`package-manifest.json` 和 GitHub 的 Source code (zip)。在写入本机配置前校验归档及解包的 121 个文件，再将适配好的目录交给官方管理器。[逐步安装与冷升级](docs/02-部署流程.md#install-verified-bundle)

## 首次运行（冒烟，不需要 GPU）

1. 正常退出并重新启动 DSH Desktop（不要强杀正在运行的 Host）。
2. 新建一个空白会话。
3. Agent preset 选「AI 画画」（id `ai-draw`）。
4. 在原生模型栏选择一个能看图的模型渠道。
5. 发一句：「先读 `art_guide quick`，然后列出你注册的 7 个 `art_*` 工具名称」。

预期：`art_guide` 返回 quick 页文本；工具列表恰好是 `art_guide`、`art_context`、`art_generate`、`art_run`、`art_review`、`art_view`、`art_deliver`。这一步不提交任何 ComfyUI 任务，不需要 GPU。右侧栏应出现「AI画画工作台」页签。

## 配置

发行包用三个占位符表示作品根目录、ComfyUI 地址和数据根目录。路径 A 由安装脚本填写，路径 B/C 在独立副本上运行 `adapt.mjs` 后再链接。

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
# 仅路径 A，恢复 install.ps1 在安装前保存的 profile
.\install\rollback.ps1 -DshHome "$env:USERPROFILE\.dsh"
```

路径 A 的脚本恢复安装前的 profile 配置，并保留数据根。路径 B/C 通过管理器链接安装，在同一维护窗口重新链接此前保留的旧版适配目录，再核对启用状态、作品和历史。

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
| `0.2.1-rc.2` | 保留兼容声明 | 最近实测来自 0.8.0 |
| `0.2.1-rc.3` | 0.9.0 本轮实测 | 1013 项测试、真实加载、双会话隔离、接手与继续 |
| `0.2.1-rc.5` | 保留兼容声明 | 最近实测来自 0.8.0 |
| 其它版本 | 未验证 | `install/probe.mjs` 退出码 `2`、`decision=refused`；`-AllowUnverifiedVersion` 后只能标注 experimental |

已验证环境为 node 24.21.0、pnpm 11.28.5、Electron 44.x。矩阵外版本要么先跑完整验收，要么明确接受「未验证」，见 [docs/05-版本兼容矩阵.md](docs/05-版本兼容矩阵.md)。

## 安全与隐私

- 发行内容包括原创工作台、原样保留的 Moeblack 参考资料及其许可。模型权重、LoRA、生成图和凭据由部署者管理。
- 生成与编辑使用配置的 ComfyUI。明确发送注释或参考图时，图片会进入当前原生会话。启用可选 GBC 视觉分析时，图片和提示可能发送给为该任务配置的模型服务。[数据与凭据流向](plugin/docs/privacy-and-security.md)
- 插件不内置聊天渠道、不保存 API Key；模型渠道由部署方在原生模型栏选择。
- 工作台的页面、修订与执行记录保存在配置的数据根。DSH 单独管理原生会话及其附件。升级时保留原数据根，切换前备份页面和历史。
- 提交前跑 `verify/sanitize-scan.mjs`（0 命中才发布），说明见 [docs/04-内容与隐私说明.md](docs/04-内容与隐私说明.md)。

## 许可

原创代码和文档采用 MIT。`plugin/vendor/moeblack/` 下的原始参考资料采用 CC BY-NC-ND 4.0。模型、外部节点和 LoRA 依各自许可使用。[原创许可](LICENSE) · [第三方文件与许可范围](plugin/THIRD_PARTY_NOTICES.md)

## English

Version 0.9.0 adds shared drawing tools for agents and artists in the DSH workbench. The release was tested end to end on DSH Desktop 0.2.1-rc.3. Compatibility declarations for rc.2 and rc.5 carry forward from 0.8.0.

Verify the Release archive, extract it to a permanent versioned directory, and configure its workspace, ComfyUI origin and data root before linking it through Plugin Manager. Keep the previous configured directory and data root for rollback. Original code is MIT. The bundled Moeblack reference files are licensed under CC BY-NC-ND 4.0. [Deployment guide](docs/02-部署流程.md#install-verified-bundle) · [Third-party notices](plugin/THIRD_PARTY_NOTICES.md)
