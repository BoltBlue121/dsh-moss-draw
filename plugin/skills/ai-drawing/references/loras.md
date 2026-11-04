# LoRA：真实目录与触发词

先调用art_context查询，不猜文件名或作者触发词：
```json
{"lora_catalog":true}
```
entries是worker可见文件与操作者侧车注册表合并的结果；unregistered缺少已登记说明，missing表示登记文件不可见。名字/trigger/strength按实际返回值用，不从示例推断本机已安装。

内置style由工具加载；自有额外LoRA走loras，最多4条、按顺序叠在内置画风之后。不要把内置权重重复挂载，Qwen不支持该叠加参数。合成参数示例（仅真实目录有此文件时可用）：
```json
{"loras":[{"file":"example-style.safetensors","strength":1,"trigger":""}]}
```
file必须是ComfyUI loras下.safetensors相对路径；strength范围0–2，默认1。触发词未知就保持未知/空，不编造。模型和权重来源许可由操作者核实。

注册表是操作者维护的元数据，不是绘图Agent可执行的配置接口。改坏JSON会报告warning，不能宣称所有文件/触发词已验证。不要自动安装权重或扫描私有路径。

调强度属于新内容设计，只在用户授权、原提交已结算后制作新计划。unknown或失败不能为了试强度换request_key重投。编译后的实际触发词与有效参数以受控plan/graph为准，原prompt文本不是唯一证据。
