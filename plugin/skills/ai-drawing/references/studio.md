# 工作台：Layout默认能力地图

Heal 默认用 KBlueLeaf 官方示例 16 步、CFG 3、shift 5、seed 0；Euler 走作者的 1000 步训练网格。详细参数、负面词和官方链接见 `art_guide({topic:"moss-modes"})`。

## 用分镜、批注和人偶编辑当前页

先取当前页及修订。用户在已有 Layout 页启用富布局后，`schema_version:2` 可使用
`art_generate({mode:"workbench",workbench:{action:"studioEdit",page_id,expected_revision,mode,edit:{family,command}}})`。
普通授权用 `mode:"auto"`，用户要求先审用 `mode:"review"` 并写简短 `summary`。续改使用返回的新修订；
遇人工接管、锁、仅文字范围或过期修订应重读并遵守该页。编辑不会创建生图请求。

- `family:"panel"`：空白分镜层一刀斜切可用 `{op:"knife",target_id:null,start:[0,0],end:[800,600],gutter_px:8}`；
  有分镜时指定实际的 `role:"panel"` 项 ID。多边形、四角和套索分别用 `polygon/quad/lasso`，传文档像素 `points`，套索加 `tolerance_px`。
  人物与对白保留独立对象。矩形角色框不能充当切割目标。
- `family:"annotation"`：`{op:"bubble_create",bbox:[16,16,280,112],style:"oval",text:"我们走吧",tail:{speaker_id:"hero",anchor:[0.5,0.2]}}`。
  说话人必须来自当前页；`bubble_edit` 只改指定气泡。草线用 `sketch_stroke`，传 `layer_id`（新建用 null）、像素 `points`、`color` 和 `width`。
- `family:"rig"`：角色先 `{op:"enable",id:"hero",build:"standard"}`，再用 `{op:"pose",id:"hero",preset:"reach"}` 或 `mirror`。
  道具可 `{op:"attach",id:"umbrella",holder_id:"hero",joint:"wristR",offset:[0,0,0]}`。相机/二维预览只读，显式 `bake` 才固化投影。
  使用真实对象 ID，每次按回执继续。本地 FK、编辑轮廓与草线用于构图，MOSS 原生 Layout 接收已编译的文字和边界框。

示例句“人物就这样，只补右格车灯”：先读取人工保存的版次，保留该人物、所属分镜、气泡指向及机位，只更新车灯对应的对象。
若用户要看效果，只准备同版冻结预览。继续绘稿不会追加 GPU 预算。

所有新t2i先构图→Layout→检查/冻结预览→生成；单主体、空会话、赶时间均不例外。raw/Caption新生图仅由操作者可信workflowMode=compat开放，Agent不能切配置。旧Caption页与已冻结计划保留。Layout是结构化文本条件，不是像素mask、ControlNet或精确区域保证。

## 最小完整页：先series/page，再Start

以下UUID是合成占位，实际调用必须替换为上一步真实回执。外层恰好mode/workbench，不混request_id或prompt。
```json
{"mode":"workbench","workbench":{"action":"studioCreateSeries","title":"静物练习"}}
```
```json
{"mode":"workbench","workbench":{"action":"studioCreatePage","series_id":"00000000-0000-4000-8000-000000000001","title":"白瓷杯","doc_json":"{\"kind\":\"layout\",\"layout\":{\"width\":1024,\"height\":768,\"bbox_coord_space\":\"abs\",\"bbox_format\":\"xyxy\",\"summary\":{\"caption\":\"An ivory cup on a pale green background.\",\"canvas\":\"single\"},\"items\":[{\"id\":\"cup\",\"label\":\"object\",\"caption\":\"An ivory ceramic cup with one handle.\",\"bbox\":[128,128,640,640]}]},\"caption\":{\"caption\":\"\"}}"}}
```
```json
{"mode":"workbench","workbench":{"action":"studioStart","page_id":"00000000-0000-4000-8000-000000000002","expected_revision":1,"intent":"画一个杯子","mode":"auto","max_runs":1}}
```

studioStart不创建page。新页用kind=layout并同时保留caption分支；Doc最多128对象、≤512KiB，每项caption≤12000字符。bbox是左上原点像素[x1,y1,x2,y2]，不能用编译后的中心化yxyx写回Doc。空页可编辑但不够生成；先补主体、合法框和描述。

## 同版闭环

1. art_context单独查询studio_tasks或studio_pages，摘要可能陈旧，以实际页/revision/plan/run为准。
2. studioStart的max_runs只取用户授权次数；queued是待展示，opened才表示Client可见。已有manual/paused或review控制，不强行接管。
3. studioAgentUpdate提交完整Doc（doc对象或doc_json），不传summary；用户说先审才studioPropose。几何+文案一起改时不带descriptions_checked；保存后重读revision，再以几何不变且真实文字修改的一次update标descriptions_checked:true。
4. art_view({studio_page_id,expected_revision})看blockout；art_context({studio_page_id,studio_inspect:true})检查编译与descriptions_status。这些不是生成图也不耗生成预算。
5. studioPrepare冻结当前Doc、编译prompt、参数/seed、参考hash、目标身份和预算，并返回冻结版**native预览**。核对这份plan_id/digest/revision的构图后，才studioExecute。可信回执来自成功tool/result；模型自报previewed、旧版art_view或只读inspect不能替代，不伪造字段。
6. 改画布尺寸先在Doc同步框；settings不能覆盖尺寸却沿用旧坐标。有变动则旧plan失效；这不同于结果未知时换key重提。
7. 只执行真实返回的plan；一次art_run等待，成功art_view像素→art_review对照Layout→art_deliver。无需每步人工确认，但不能越过用户“先看”、人工接管或预算。

```json
{"mode":"workbench","workbench":{"action":"studioPrepare","page_id":"00000000-0000-4000-8000-000000000002","expected_revision":3,"request_key":"cup-layout-r3","settings":{"backend":"moss","mode":"t2i","seed":42},"references":[]}}
```
```json
{"mode":"workbench","workbench":{"action":"studioExecute","plan_id":"00000000-0000-4000-8000-000000000003"}}
```

便携包的 Base/SFT 文生图沿用 50 步、CFG 3；Heal 使用作者示例的 16 步、CFG 3。用户显式选择优先；不要无依据改参数。没有参考图references可省略。检查plan.request/plan.effective中的实际值，准备用途不能被解读成已提交。

## 能力地图

- 系列/页/修订：同一页多轮续画，旧任务与计划留档；历史恢复创建新revision，不重写旧结果。
- 图层items：object/character/text，每人/物独立；hidden不编译，locked不可改删调序，group/name是编辑metadata。文字层逐字写text。
- 画布summary.canvas支持single/multi_panel/collage；尺寸16对齐。prompt_options.depth表达前中后层次。
- 相机/体块body：构图预览，不是精确3D或真实遮挡；投影只改编译副本，不直接覆盖原2D框。camera.distance默认1。
- shared：系列画风/角色卡显式pin快照；源变化不偷偷改旧页/计划。
- 参考图：analysis指南走GBC→Layout提案，用contain/cover/stretch映射；generation.prompt不是几何替代。局部编辑走regions的region_bindings，不冒充新t2i。

## 提案与范围

用户本条明确要求的编辑可由studioAgentUpdate完成；先审用studioPropose。仅分析成功不自动采纳；待审提案按真实选择处理，不能让新任务忽略它。采纳不等于生图。示例：
```json
{"mode":"workbench","workbench":{"action":"studioResolve","page_id":"00000000-0000-4000-8000-000000000002","expected_revision":43,"proposal_id":"00000000-0000-4000-8000-000000000004","accept":["layout.summary"],"reject":false}}
```
selector以proposal.changed_selectors为准，切分支须含kind；丢弃用reject:true、accept:[]。manual/paused、dirty/conflict、locked、descriptions-only/editing_only都不能靠新页/raw绕过。STUDIO_TEXT_ONLY或STUDIO_EDIT_SCOPE先读真实策略，保留相机、框、IDs、层序和shared。

studioRequestConsent是用户要求每次询问时的罕见兜底，不是常规流程：
```json
{"mode":"workbench","workbench":{"action":"studioRequestConsent","page_id":"00000000-0000-4000-8000-000000000002","expected_revision":43,"request_key":"ask-each-time-r43","operations":{"proposal":null,"resume":true,"exit_text_only":false,"generation":{"mode":"none","runs":0,"backend":null,"intent":""},"continue_generation":false}}}
```
continue_generation=false不能prepare/execute或新建任务绕过；apply只传consent_id，真人证据不能由模型自报。只授权一个backend不授权其它子阶段。

## 同一页续画与故障

已交付或明确failed且全部提交已结算，新的用户消息才可同一页studioStart开启下一轮；旧任务、旧预算与原稿保留。binding_active=false不是默认raw权限；仍遵循可信workflowMode。STUDIO_BUDGET_EXHAUSTED不通过新页重置。

- unknown/NOT_FOUND_YET：缺history不等于未提交；只对账原run/request，不换key、后端、页或raw重抽。持续未知交维护。
- PRE_SUBMIT_FAILED是确认未到提交点；明确failed是终止，两者都不是成功，也不自动重投；claimed次数留档。
- cancelled不保证远端取消/退款；abandoned需明确人工操作，不能伪装succeeded/failed。
- 连接目标已变时保留原任务归属，诊断后交维护，不能把旧请求发往新地址。
