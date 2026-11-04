# Changelog

## 0.9.0 工作台

在同一个 DSH 会话里，Agent 可以按需求创建分镜，用户可接手修改，再从保存的修订继续。工作稿支持分镜边框、气泡和草图、可摆姿的人偶与道具。

选用 MOSS-Image-heal 时，KBlueLeaf 的示例预设为 16 步、CFG 3、shift 5、种子 0 和无内置 LoRA。采样采用 KohakuMoss 的 Euler，将 sigma 对齐到 1000 级训练网格，负向分支跳过第 22 层。模型卡及作者实现可从插件的模型选择区打开。


## 0.7.0-rc.4 — candidate

- 统一新文生图的Layout默认：单主体也先设计文档；raw/Caption仅操作者compat配置。
- 冻结计划原生预览与可信回执接线、尺寸和描述一致性检查；旧页/旧计划兼容，不覆盖历史。
- GBC结构转换为Layout；发起Agent模型快照、取消/预算/安全错误与zero-call preflight回落约束。
- 同包本地/可信远端ComfyUI与只读连接诊断，工作区来自Session可信cwd。
- 用户/Agent双受众README、按需指南、隐私清理及自有MIT/第三方NC-ND分区说明。

以上是候选变更范围，不代表所有运行环境、GPU、GUI或视觉质量已验收。发布结论以实际发行物验证为准。

## Earlier releases

保留七工具、原生工作台、Moss/K2/Qwen适配、原生参考交接及持久防重账本。旧私有开发报告已在维护者私有证据中保存，不把个人路径/机器/任务记录带入公开包；用户稿件和本地历史不删除。
