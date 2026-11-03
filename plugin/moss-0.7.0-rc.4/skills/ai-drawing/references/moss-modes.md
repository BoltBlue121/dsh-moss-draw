# Moss：模式、参数与真实边界

新t2i默认Layout→同版检查→studioPrepare冻结native预览→studioExecute；没有任务也不能走raw捷径。可信workflowMode=compat才允许专家兼容入口。先看art_context目录，参数以实际模式为准，不把t2i的50步套给编辑。

- t2i：Base+FymriE默认；显式model/style按目录支持值选择。默认steps50、CFG4、shift5、euler/sgm_uniform、SLG22；用户明确参数优先。尺寸由Layout决定，16对齐/像素上限及尺寸特例以validator/catalog为准，settings不能偷偷改画布。sampler/scheduler/steps可选，名字从目录读取，不猜。
- edit：1–4张有序参考，输出尺寸不暗缩；原生Edit用独立编辑权重与可选画风，典型30步CFG4 shift5，无t2i SLG。已有claim保持原engine，不迁移未知请求。换背景/部件不保证其余像素不变。
- inpaint：用户明确准备的RGBA mask；不从透明边缘猜mask。按实际有效mask和像素检查保护范围。
- characters：文本角色分区，不是参考角色放到底图。兼容/专用模式须按目录支持使用，不用它绕过新t2i的Layout要求。
- regions：PNG底图+角色参考，1–4原图像素框；draft预览无推理，execute授权已冻结阶段。每child预算独立计数，读regions，不手写workflow。

## 提交前免费核对

studioPrepare不提交GPU。检查plan.request与plan.effective的backend/model/style/LoRA、尺寸、seed、steps/cfg/shift/sampler/scheduler和cost；读冻结native预览，确认同一plan/revision再studioExecute。有效计划不是视觉成功证据。

明确选择SFT+kieed时，可将以下作为工作台settings；尺寸仍来自Doc：
```json
{"backend":"moss","mode":"t2i","model":"sft","style":"kieed","lora_strength":1,"steps":50,"cfg":4,"shift":5,"seed":42,"prefix":"","negative":""}
```
省略cfg使用目录默认4，显式值不硬改。编辑模式的固定sampler/scheduler遵从该模式，不手塞不兼容字段。

## 显式原图编辑示例

先art_view查看用户已提供的真实参考；此例是编辑，不是新t2i默认入口：
```json
{"backend":"moss","mode":"edit","request_id":"native-edit-example-1","references":["visible/canvas.png"],"prompt":"Edit the first image: replace only the central subject with one small robot. Preserve the framing, floor and soft daylight. Output only the edited first image.","model":"sft","style":"fymrie","lora_strength":1,"steps":30,"cfg":4,"shift":5,"width":768,"height":512}
```

## 像素验收与预算

检查数量与归属、朝向/遮挡、动作接触、取景、家具支撑、光线和留白；不知道写UNKNOWN。locked只保护Doc，不证明成图保真。风格可选不等于已在所有模式完成真实验收。regions接缝、复杂遮挡和身份一致性需逐图判断；整图Qwen不能保证框外不变。

生成按当前用户授权和预算，不从历史测试推导本轮额度。unknown只查原run，不换key/后端重提；明确failed也不自动加一次。候选版源码、fixture或编译测试不代表本地/远端GPU及视觉质量全部验收。
