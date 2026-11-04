# 连接与工作区：用户配置，Agent只读诊断

同一个插件连接用户已有的本地或远端ComfyUI，不安装/启动ComfyUI，不自动下载模型。缺省连接候选为http://127.0.0.1:8188；远端地址由操作者通过可信配置显式设置，绘图工具不接受任意URL或凭据。

工作区取真实Agent/Session的可信workingDirectory服务；显式workspaceRoot/dataRoot优先。缺可信工作区返回可操作配置错误，不拿应用安装目录、process.cwd或开发者目录冒充。

候选版接线提供只读查询（不能混其它selector）：
```json
{"connection":true}
```
调用art_context。读取reachable、ready、missing_nodes、missing_models、warnings；没有对应查询的旧Host会拒绝字段，说明版本未加载，不编造ready。查询只GET/本地前提检查，不提交图片、不调用模型。

1. 确认可信工作区与本地/远端目标；地址和凭据只由操作者配置。
2. 检查需要模式的节点/模型及LoRA，缺项报告具体名称，不自动安装。
3. 参考分析另查GBC的Python/配置/合法本地权重与视觉模型选择。configured/unchecked不是可推理证明；没有doctor hook就保持未核验。
4. 用户授权后做一个最小Layout任务，按studio检查冻结预览与实际结果。诊断通过不等于GPU/视觉验收通过。

长作业固定原目标身份。更换连接不能让旧run到另一地址查询/重投；BACKEND_CHANGED等错误保留原run交维护。unknown不换ID、不退预算。

DSH其它Agent需通过该包声明的scope/七工具使用；不承诺任意跨平台MCP/远控。详细用户与Agent配置见 [配置手册](../../../docs/agent-setup.md)，模型/第三方许可由操作者核实。
