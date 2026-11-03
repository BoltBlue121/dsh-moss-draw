# 插件维护与回滚

同一bundle包含Host、scope预设、原生Client、七工具、指南与固定GBC adapter，不维护另一套GUI或通用远控。配置与运行前提见 [设置](<agent-setup.md>)、[GBC](<gbc-runtime.md>)。

## 变更生效

官方Plugin Manager的application/warnings是准据。Host模块、preset与schema需要加载新revision；旧会话可pin旧scope。指南正文按需读取，但新增topic enum同样需要新Host。Client源码需构建为实际bundle；页面刷新或启动另一个server不能替代现有Host更新。不得擅自重启用户共享Host。

## 维护顺序

1. 备份操作者配置与数据根，记录包版本/hash；不在忙碌队列中修改推理环境。
2. 在隔离源码树测试、构建、打包，解包cold-import并检查实际exports/资源与隐私。
3. 只部署明确选择的目标；部署脚本须提供显式路径，不能内置私人盘符或复制开发者profile。
4. 按管理器结果正常重载/重启，使用新会话验证七工具、只读连接、Layout预览与错误路径。真实图像测试必须单独授权与记账。
5. 回滚原包与配置时保留Doc/修订、未知run、claim和已占预算；不要删记录来让任务“重试成功”。

## 诊断

Comfy诊断只GET /object_info；GBC doctor只验证声明的本地前提，不保证权重内容、设备或端点可推理。host-agent使用发起Agent实际选择，不用全局默认；无视觉能力要显式失败。

超时/失联先读取安全状态，保留原job身份。不得移动`.gbc-claim`、覆盖result、换request_key或强行删除租约以重跑未知工作。需处理遗留进程/连接时由操作者核对真实所有者和子进程树，不能按文档中的示例PID杀任意进程。

## LoRA元数据维护

仅操作者运行侧车CLI，必须显式提供`--data-root <absolute-data-root>`或MOSS_DRAW_DATA_ROOT，不能从cwd猜根。维护前用`--help`核对用法，真实文件/触发词来自获准worker目录；绘图Agent不编辑注册表或下载权重。

## 公开发行

当前候选验收范围必须与实际结果一起发布；fixture/replay不是live图像，源码测试不是真实GUI。所有私有开发记录保留在维护者自己的证据区，公开历史页只保留说明链接。没有发布目标授权，不执行push/publish。许可见 [README](<../README.md>)：MIT仅自有代码，原样NC-ND资料仍受其限制。
