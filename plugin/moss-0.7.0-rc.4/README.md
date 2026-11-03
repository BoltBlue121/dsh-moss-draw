# AI 画画工作台 · 0.7.0-rc.4 候选

一个DSH插件包：**AI画画预设 + 七工具 + 原生工作台 + 可选GBC参考分析**。连接你已有的本地或远端ComfyUI，不替你安装/启动ComfyUI、不自动下载模型，也不创建第二个绘图GUI。

> 本页描述候选接口与使用流程，不是当前机器已经全部实测通过的声明。正式验收以该发行物的测试/实页/实图记录为准；源码测试、fixture、replay、配置存在均不能代替真实GPU或视觉验证。

## 能做什么

- 默认新文生图：设计→Layout文档→编辑/同版检查→冻结计划的原生预览→执行→审图→交付。**单主体也走Layout**，空会话不是raw捷径。
- 原生工作台：系列/页/修订、对象与文字图层、框/层序/组/锁/隐藏、画布、相机体块、shared角色/画风快照、提案与历史。
- GBC：参考图对象/部件/关系转换为Layout提案，保留另一Caption分支与人工编辑。仅分析不生图、不自动采纳；generation.prompt不是布局替代。
- Moss/K2新图；明确原图编辑保留Moss edit/inpaint/regions及Qwen后处理。模式和实际节点/模型能力以目录为准。
- request/plan防重、CAS/人工接管/文字范围/预算守卫，以及只读诊断。

**真实限制**：Layout编译为带坐标的结构化文本条件，不是像素mask、ControlNet或严格位置保证。相机体块不是实物3D重建。GBC不是分割或视觉质量证明。区域编辑仍需检查接缝/身份，整图Qwen不能保证未改区域逐像素不变。

## 用户快速开始

1. 在官方Plugin Manager安装/更新本bundle；保留原数据备份。选择“AI画画”预设，在原生模型栏选择可用模型。不要复制开发者profile或旧DSH核心包。
2. 提供已有ComfyUI：默认候选`http://127.0.0.1:8188`；远端由你明确配置可信origin和网络访问控制。不自动开放端口/搭隧道。
3. 工作区从真实Session可信cwd解析，或显式设workspaceRoot/dataRoot。节点、模型、LoRA需已合法安装；GBC另有Python和本地模型前提。
4. 让Agent先做只读连接诊断，再说“画一只白瓷杯放浅绿色桌面”。Agent负责构图与最小Layout，不需要你填写坐标。说“先给我看方案”时才停审。
5. 想微调可在原工作台接管；人工锁/暂停/仅文字范围不能被Agent绕过。额外图片需要明确额度。

完整配置：[用户与Agent设置](<docs/agent-setup.md>)；[本地示例](<config/examples/local.json>) / [远端示例](<config/examples/remote.json>)。

## Agent快速开始

仍只有七工具：`art_guide / art_context / art_generate / art_run / art_review / art_view / art_deliver`。其它DSH Agent通过声明的scope与按需guide使用，不承诺未实现的通用MCP远控。

- 先`art_guide({topic:'quick'})`，再按需studio/analysis/setup；不要预载全部原文。
- 无页：studioCreateSeries→studioCreatePage(kind=layout)→studioStart。Start不创建页。完整可校验最小Doc见 [studio指南](<skills/ai-drawing/references/studio.md>)。
- 工作台请求外层恰好`{mode:'workbench',workbench:{action,...}}`，不夹raw prompt/request_id。收到prepare的冻结native预览后再execute；Host验证plan/digest绑定的可信回执，不能自报“已看”或用旧图代替。
- 参考图新生图：GBC→studioAnalysisPropose→按授权审查/编辑Layout→生图，非扁平Caption。局部修原图明确走edit/regions。
- Moss t2i省略CFG默认4；用户明确参数优先，其余目录默认按模式读取。settings尺寸不能覆盖Layout却保留旧框。
- raw/Caption新t2i仅操作者可信`workflowMode:'compat'`开放；模型不能加skip开关。旧稿/旧冻结计划不被强制迁移。

## 失败与恢复

unknown、丢POST回执或history未找到：保留原run/request/key/后端与已占预算，只对账，不换ID补抽。长期不可达交维护；明确failed也不自动增加次数。取消本地等待/进程不保证远端费用撤销。目标连接改变不能把旧run发给另一台。

host-agent参考分析冻结发起Agent的实际模型选择，不使用全局默认冒充。HTTP回落仅配置允许、zero-call preflight可恢复故障；已调用模型就不整任务重跑。拒绝、截断、非JSON、图算法错误、取消不能当网络故障换模型。

## 安装、升级与数据

目标运行环境为Node24、DSH Desktop 0.2.1对应的精确SDK；manifest声明版本不等于全部版本已实测。GBC独立Python3.13与锁定依赖由操作者配置，权重不入包。包资源不包含venv、node_modules、会话数据库、作品或凭据。

官方Plugin Manager的application/warnings决定生效方式；已打开会话可能pin旧revision。Host更新与Client构建不能靠另开server冒充生效。正常升级/回滚须保留数据与unknown记录，不重置claim。详见 [维护手册](<docs/plugin-maintenance.md>)。

## 许可：必须分区理解

**自有代码采用MIT；整包不能因此宣称自由商用。** [LICENSE](<LICENSE>)仅覆盖有权授权的自有实现。随附Moeblack原始资料及署名保持原样，适用**CC-BY-NC-ND-4.0**：非商业、不得分发改作；见 [第三方通知](<THIRD_PARTY_NOTICES.md>) 与 [原许可](<vendor/moeblack/LICENSE>)。模型、LoRA及依赖各有独立许可/门槛，操作者自行核实。没有获得许可的其它编辑器源码/图标不纳入本包。

## 文档索引

- [变更记录](<CHANGELOG.md>)
- [配置与Agent接入](<docs/agent-setup.md>)
- [GBC环境与预算](<docs/gbc-runtime.md>)
- [维护/迁移/回滚](<docs/plugin-maintenance.md>)
- [隐私与安全](<docs/privacy-and-security.md>)
- [Worker配套节点](<worker/README.md>)

旧私有开发/机器/任务日志已先备份并移出公开正文，不删除用户资产。构建成功不等于发布验收；本候选仍须独立复审、实际包扫描与明确的未验证项清单。
