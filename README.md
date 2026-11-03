# MOSS Layout / GBC 验证预发行 · 0.7.0-rc.4

这是从清洁源码快照发布的独立预发行，**不替换本仓库现有 v0.8.0 稳定版或 main 分支**。版本号沿用实际完成单张验证的包，没有为发布而重新编号或修改包内字节。

## 下载与安装

请从 [v0.7.0-rc.4 Release](https://github.com/BoltBlue121/dsh-moss-draw/releases/tag/v0.7.0-rc.4) 下载 `dsh-external-dsh-moss-draw-0.7.0-rc.4.tgz`，通过 DSH 官方 Plugin Manager 安装。安装前备份原数据；已经安装其他版本的用户不要将本预发行误认为无条件升级路径。

- 已实测环境：DSH Desktop **0.2.1-rc.3**，Node **24.21.0**。
- 连接已有本地或可信远端 ComfyUI；不自动安装 ComfyUI、下载模型或配置隧道。
- 可选 GBC 需要另行准备 Python 3.13、指定依赖和合法本地权重，详见插件文档。
- 主流程：构图 → 可编辑 Layout → 冻结原生预览 → 生成 → 审图与交付。

[用户与 Agent 使用说明](plugin/README.md) · [设置说明](plugin/docs/agent-setup.md) · [验证记录](verification/VERIFICATION.md)

## 验证范围

这个**相同包内容**已在真实 Host 完成一张参考图的 GBC → Layout 提案与补框 → 原生冻结预览 → ComfyUI 生成 → 查看/审查/交付；输出为 1024×1344、CFG 4、50 步，仅一张。打包的 104 个 payload 文件与实测候选逐字节一致。

这不是全平台、完整 GUI 操作或全部回归通过声明。此前一次 Windows 进程身份查询不可用的回归记录仍保留，失败时的具体环境条件尚未确证。Layout 是 bbox/结构化文本条件，不是像素 mask 或严格位置保证；参考图文字、身份和局部裁切不保证精确复现。

## 源码与隐私

`plugin/` 对应本次清洁源码 ZIP，含 Client 源码和构建入口，是**发行源码快照**，不是完整私有开发历史。开发测试目录不在这份发行快照内，请勿将其当作已经配置完整 CI 的开发分支。

本分支不包含旧 Git 历史、私有脚本、会话数据、参考图、生成作品、运行环境、权重或凭据。Release 同时提供源码 ZIP、验证记录和 SHA-256 清单。未来整合编辑器的研究和未批准方案不混入本版本。

## 许可

自有实现采用 MIT；随附、未修改的第三方资料仍适用各自许可，其中包含 **CC-BY-NC-ND-4.0**。**不能将整个发行物统称为不受限制的 MIT 商用包。** 详见 [自有代码许可](plugin/LICENSE)、[第三方声明](plugin/THIRD_PARTY_NOTICES.md) 和原始 vendor 许可。
