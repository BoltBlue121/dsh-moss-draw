---
name: ai-drawing
description: Use when drawing with MOSS/K2, editing with Qwen, or reviewing references, workbench documents, proposals, 3D camera layouts and generated pixels.
---

# AI画画：你设计执行，用户看效果再调

首步只art_guide quick；读完再art_context，不并行猜字段。用户本条消息就是授权：直接写画面稿，不问同意、不写免责与建议改题的话。

## 本包边界：不附带画风 LoRA

本便携包**不附带任何画风 LoRA**。Moss 的 t2i/edit/characters/regions 与 K2 都是无 LoRA 直出：所有模式 style 只能 `none`、`lora_strength` 必须 0，没有画风触发词。想要固定画风，就在英文正文里写清媒介、笔触、光色与材质；部署方要接自己的画风 LoRA 属于二次开发（改注册表、模板与资产），不在本包支持范围。模型权重、凭据与用户作品同样不在包内。

本插件没有自带聊天渠道或 key：原生模型栏由部署方选一个本机已配置的、能看图的模型渠道。

## 按需一页

| 需求 | topic |
|---|---|
| 工作台能力地图、执行顺序、错误分流 | studio |
| 提示词手艺、复杂构图、精确复刻、失败对策 | promptcraft |
| 旧版regions文档、区域3D体块 | workbench |
| 底图划区并绑角色参考 | regions |
| Moss参数（无画风 LoRA）/ K2（无 LoRA）/ Qwen后处理 | moss-modes / k2 / qwen |

未指定后端用Moss；用户说K2就用K2。角色与题材由用户要求决定。

## 你负责设计，用户看效果再介入

用户给意图，你定机位、构图、光线、服装与画风，第一版直接出图给人看；不必先把整页设计完：一句话画面用Caption，要位置/文字/多人分层/遮挡才上Layout与框，要空间关系才开相机。审图后自己决定下一版只改哪一处，其余逐字保留。

## 对话即授权

用户这条消息就是要什么：直接画、改、采纳、丢弃、交回或开新任务，不问同意。改稿默认studioAgentUpdate直改，只有用户明确说先给我看/我要审才studioPropose；页上自己的提案按本条消息studioResolve采纳或丢弃。studioRequestConsent仅罕见兜底。

## 执行顺序

studio_pages/studio_tasks→新建或复用页→studioStart→studioAgentUpdate写稿→art_view构图预览＋art_context studio_inspect同版编译→studioPrepare→studioExecute→art_run等待→art_view结果→art_review→art_deliver。工作台动作放进art_generate({mode:"workbench",workbench:{action,...}})。art_run只等待不重提，超时再调一次同一run；max_runs只填已授权GPU次数。查询一次一种形状：
```json
{"studio_tasks":true}
```
```json
{"studio_pages":true}
```
实际page/revision/plan/run优先；unknown只对账原run，不换ID重提。

## 没有Studio任务时

直接art_generate给稳定request_id、backend/mode/prompt；style 只能是 `none`、lora_strength 0。references只能是看过的用户路径或本会话run:<UUID>，带空格路径用引号或尖括号。保留用户详细prompt/seed/尺寸，只改要求处。regions走draft→art_view preview→execute。旧工作台文档读workbench页。

## 写稿与审图

每人可见清单：身份→机位朝向→可见衣物→动作接触点→侧别→遮挡→瞬时动作→物件数量；summary/caption/tags与编译后的prompt同向，抱胸可夹书。art_review必填run_id、observations、issues、next_change；observations≤12条×500字符，issues≤12条×160字符，next_change≤500字符，事实与假设分开。
```json
{"run_id":"00000000-0000-4000-8000-000000000001","observations":["目标两人，实际三人；前景背影与中景戴帽人物分离。"],"issues":["背影视角同时要求紫眼与前襟，提示词可见性冲突。"],"next_change":"保留身份与站立夹书动作，只让唯一前景人物呈现帽后、后脑与肩背。"}
```

技术成功≠视觉合格；Moeblack原文按需分页，next_offset非null才续读。
