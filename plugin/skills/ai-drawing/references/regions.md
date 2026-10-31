# Regions：Agent规划、角色参考绑定与区域编辑

用于“把参考角色放进底图指定位置”“分别修改几个区域、其他位置保留”。与characters纯文生图分区不同：regions确实将底图裁片和对应角色参考传入Moss Edit。先看所有输入像素和art_context，不需要用户手写坐标。本包style只有none、强度0（不附带任何画风LoRA）。

## 从自然语言到可执行计划

1. Agent按画面尺寸、人物比例、遮挡和构图提出1–4个框，逐框给id、对应角色参考、改动prompt。box=[left,top,right,bottom]是**原底图像素整数半开坐标**，包含left/top、不包含right/bottom；不是0–1归一化坐标。reference_index对应references数组：第0项是PNG底图，1..3才是角色图；一个角色图可被多个框引用。使用已查看的用户可见路径或同会话run:<UUID>，不猜文件。
2. art_generate mode=regions/action=draft固化计划并生成编号overlay，**不调用GPU**。返回status=draft和run_id；这个run_id也是后续plan_id。用art_view({run_id,variant:"preview"})查看编号框与参考对应关系，art_context({run_id})查冻结参数。查看preview/result只是读取，不推进生成。
3. 按已有授权决定下一步：用户要求“先给我看/让我确认”则展示preview和框/角色对照后停在draft；用户已说“你自己安排，直接做”则Agent看preview自行确认后execute，不要求每框再问用户。实质缺信息或计划超出授权才询问。用户微调框/绑定/提示词时创建新draft、新request_id，保留旧plan，不覆盖冻结记录。
4. execute仅给mode/action/plan_id，**不需要request_id或prompt**，也不重复references/regions。授权范围覆盖该计划所列全部阶段；execute返回running后调用一次art_run，由内部等待推进原父任务。draft不是排队任务，不对draft循环art_run。
5. 完成后art_view variant=result看真实最终像素，art_review记录观察，art_deliver交原PNG并在最终回复原样附markdown_link。技术完成不等于角色保真或视觉合格。已经提交的child取消只停本机等待，不取消GPU任务；首次POST前取消可能终止当前尝试（CANCELLED_BEFORE_SUBMIT，没有提交GPU），恢复查询会如实显示failed，需再次授权新计划才能重画。unknown只查同run对账，不能换ID重生。

## 参数与保护边界

- references共2–4张：PNG底图+1–3角色参考。底图最多4.5MP，角色图每张最多2.1MP；不暗缩用户原底图。框须在底图内且非空。参数验证只限制可执行技术条件。
- 每框字段：id、box、reference_index、prompt；可选style、**lora_strength**（不是strength）、seed、context_px、feather_px、steps、cfg、qwen_prompt。style只接受none、lora_strength必须0；默认context64、feather8、Edit30步CFG4；seed在draft固定。
- 每框从**当前画布**取crop，加上下文后以crop+指定角色图进入Moss Edit。context_px只增加推理上下文，不扩大允许改区；结果缩回crop，仅在box内部羽化回贴。框重叠时按数组顺序处理，后框覆盖前框，preview中说明重叠。
- 新parent使用native Edit：SFT基础权重＋Edit adapter（部署方自备，不在包内）；普通LoraLoaderModelOnly只加载Edit adapter，不是画风LoRA。默认30步、CFG4、shift5、无SLG，sampler/scheduler固定euler/sgm_uniform。参考编码最长边512；每张crop/角色输入<=2.1MP，stage输出256..2048/16倍数且<=2.1MP。区域runner会按阶段规则裁切/调整推理crop再缩回原crop，这不是暗缩原底图或放宽写区。旧parent/已有child claim仍用legacy链，恢复时不切图或重发。
- **native每crop只传本region.prompt及first image/crop、reference 2的角色关系说明，不再拼入全局prompt的人数。** 全局prompt是整体规划说明，不会在每crop重复“两个人”。Agent须把该框所需媒介、光线、服装、姿态、准确单框人数等完整写进每个region.prompt；不要以为全局写过就会继承。要求编辑/只输出第一图，不要参考对照拼图；参考2只是该框角色设计。
- 默认无Qwen。每框qwen_prompt是该框局部收尾，仍用同box/mask回贴；qwen_full_prompt是最后整图派生，会放弃框外逐像素不变，只有用户明确授权才填写。不要把Moss+Qwen合成结果称为Moss直出。
- 不启用full Qwen时，合成流程校验区域并集外RGBA逐像素差0；这不是模型自己保真，也不是框内身份保证。art_context/art_run返回的protection和实际像素是依据。full Qwen后不得沿用旧的框外不变结论。
- 预算按child计算：每框1次Moss Edit；有qwen_prompt的框再1次Qwen；qwen_full_prompt再1次整图Qwen。先按当前用户授权和预算规划，不无限追加。
- **真实结果边界**：多参考native Edit与regions仍是quality experimental；技术成功、outside_changed_pixels=0不等于视觉合格，实际出现过每crop重复主体与接缝，必须逐图验收，也不能偷偷退成t2i或风格参考图冒充。四参考场景只在接口/编译层验证过，不能称已验收。

## 例：1024×768底图，两个角色

示例路径仅示意；实际必须使用用户已提供、当前会话可见且已art_view看过的路径。实际使用时Agent根据真实画面自行定框，不照抄例子坐标。

```json
{
  "mode": "regions",
  "action": "draft",
  "request_id": "scene-layout-v1",
  "prompt": "Integrate the assigned characters into the scene with matching perspective and lighting.",
  "references": ["canvas.png", "character-left.png", "character-right.png"],
  "regions": [
    {"id": "left", "box": [80, 80, 440, 720], "reference_index": 1, "prompt": "Edit the first image as a soft painted illustration: place exactly one adult character from reference 2 in this crop, matching its perspective and warm daylight from the upper left. Preserve the floor and background, and output only the edited first image.", "style": "none", "lora_strength": 0},
    {"id": "right", "box": [580, 80, 940, 720], "reference_index": 2, "prompt": "Edit the first image as a soft painted illustration: place exactly one adult character from reference 2 in this crop, preserving the requested outfit and warm upper-left daylight. Keep the crop perspective, floor and background; output only the edited first image.", "style": "none", "lora_strength": 0}
  ]
}
```

每个child的reference 1是该框crop，reference 2是此框指定角色；上例全局reference_index=2也不意味着child有第三张图。

看preview并满足授权后，把plan_id替换为draft返回的run_id：

```json
{"mode":"regions","action":"execute","plan_id":"00000000-0000-4000-8000-000000000001"}
```

只有这一步授权多阶段执行。预览不通过就新建draft；不要通过art_view试图启动任务，也不要拿draft的overlay当生成底图。
