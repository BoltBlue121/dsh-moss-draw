# Moss：生成、编辑与区域计划

先看art_context；mode决定参数，不能把t2i的50步套到所有编辑。**本便携包不附带任何画风 LoRA**：所有模式 style 只能 `none`、`lora_strength` 必须 0；Moss 的 t2i/edit/characters/regions 与 K2 都是无 LoRA 直出。要接自己的画风 LoRA 属于部署方自行改代码/资产，不在本包范围。

- **t2i**：默认model=base；可显式model=base或sft，style只有none、强度0。两种底模均支持原生2560×1440横幅；其他常规尺寸仍按目录的16对齐/2.1MP规则，不能把此t2i尺寸特例套给编辑。英文自然语言明确主体归属/服装/空间。默认50步Euler/sgm_uniform、CFG3、shift5、SLG22；t2i是唯一可自选sampler/scheduler/steps的模式，全部KSampler名字与9个scheduler见art_context的catalog.samplers/schedulers，用户点名测采样器就照名字传，不猜不缩写。默认不接参考图条件，先看参考再转写prompt；画风靠正文写媒介与光色，不靠LoRA名字。
- **edit**：新请求默认走ComfyUI原生native Edit链：SFT基础权重＋Edit adapter（由部署方自备，不在本包内）；普通LoraLoaderModelOnly只用于加载Edit adapter，不是画风LoRA。本包style只有none、强度0，不接画风LoRA，也不需要MossDrawEditStyleLoader。30步、CFG4、shift5、无SLG；sampler/scheduler由模板固定为euler/sgm_uniform，不手塞。1–4张有序参考，各<=2.1MP；输出每边256..2048、16倍数、总<=2.1MP，缺省沿第一参考原尺寸，不合法则要求显式宽高，不暗缩输出。参考编码最长边512并向下16对齐（极小边最少16），与输出尺寸独立。换背景/部件/融合不保证原图其余像素不变。旧claim/旧parent继续legacy full SFT+Edit adapter链，不把旧未知任务迁移native或换ID重提；legacy链可能引用可选配套节点，本包默认不需要它。四参考场景只在接口/编译层验证过，不能称真实四参考推理已验收。
- **inpaint**：一张用户已准备mask的RGBA PNG，alpha0重绘、255保留；不猜mask。现有裁切+扩张羽化mask+生成+回贴，默认25步er_sde/simple CFG2.5，model sft、style none（无画风LoRA），保持原尺寸。有效mask不同于raw alpha边缘，框外/蒙版外不变以实际有效mask和像素检查为准，不从一次测试扩称所有结果。
- **characters**：纯文字1–2角色，无图像references。各角色独立prompt/style和归一化x/y位置；不接box width/height。默认model=sft、style none；不接画风LoRA、强度必须0，也不套t2i SLG。它不是“角色参考放到底图”的regions；多人/多角色画面质量需逐图看。
- **regions**：PNG底图+1–3角色参考、1–4个原图像素box；Agent自主规划，draft生成编号overlay无推理，看preview后依授权execute；用户要求审查才停下等微调。art_run推进已授权多阶段，art_view不推进。局部crop+角色参考→Moss Edit（无画风LoRA）→可选局部Qwen→box内回贴；每框style只能none、lora_strength 0。详细契约读art_guide topic=regions，不手写工作流。

## 提交前的免费核对

studioPrepare只冻结计划，不花GPU。提交studioExecute之前核对plan.request与plan.effective的backend/model/style/强度、尺寸、seed、steps/cfg/shift/sampler/scheduler，以及cost是否在授权内；与用户要求不符先修，不用生成试错。style只应为none、强度0。t2i尺寸以Doc.layout为准，settings另写宽高必须一致。t2i可显式传sampler/scheduler/steps（默认euler/sgm_uniform/50步），写错名字会报错并列出全部可用值；edit/inpaint/characters/regions的sampler/scheduler是固定的，不手塞，按目录里该模式的实际值核对；SLG22只属t2i，不套给Edit。

例如用户明确选Moss SFT做纯文生图时，settings可为：
```json
{"backend":"moss","mode":"t2i","model":"sft","style":"none","lora_strength":0,"steps":50,"cfg":3,"shift":5,"seed":314159265358979,"negative":""}
```
这是显式指定配方的示例；默认model=base，style恒为none。尺寸仍来自用户稿件。

多人空间稿先做四件事：summary统一人数/视角/主光；每人caption只写该机位可见部分与动作接触点；家具逐件写墙面归属/连接/支撑；空地写成连续净空区域。背影不再堆眼睛/前襟细节，越肩人物不是另一个观察者。图层框是意图，不保证像素严格遵循。

首图实际像素验收：数量与归属→可见朝向/遮挡→动作与道具接触→关键人物取景→家具支撑与统一透视→光线/留白。未看见写UNKNOWN，漂亮不能抵消人数/抱书/构图错误。同目标同参数同seed才是受控对照；单个seed的改善不是模型普遍优于另一模型。

## 题材

题材、倾向、机位与氛围由用户决定，你只把用户描述翻译成可执行画面。

## 可见清单四项：侧别、遮挡、瞬时动作、物件数量

以下检查项来自实际出图与审图经验；即使prompt写全，也要按实际像素逐项核，不把单张结果当普遍规律。

- **侧别**：“她的右手”或“画面左侧的手”二选一，全文一致；侧背身优先画面侧，并写死身体朝向（正对镜头时她的左腿在画面右侧）。每只手/每条腿一个状态，不写“张开又收拢”“抬起再放下”；动作段末尾加“她只有两只手、两条腿”，仍须逐图验收解剖。指定角色自身侧别时先核对机位，不能偷换用户要求。
- **遮挡**：用画面已有的实体（物件或肢体，不新增道具）或裁切，写身体刻度、实体形状位置、显式视角句。例：裙摆下缘停在膝上两指；压在并拢膝头上的手按住裙摆前缘；镜头落在裙摆外侧，画面不出现裙底。水/蒸汽/纱这类半透明介质不可靠，不承诺遮挡。
- **瞬时动作**：“刚/即将/尚未”换成可见间隙或接触点，如球与杖尖之间留出可见背景；逐图判间隙、相连或UNKNOWN，不把副词当几何证据。
- **物件数量**：数量词贴物件（“唯一一根法杖”“恰好一只茶杯”），不只放must_have或negative；单张图不能证明计数稳定，仍要逐图核。

## 锁定图层与像素身份

锁图层保护的是**文档**，不是最终像素身份。人物精确服设须审图逐项核，不以locked=true当保真证明。审图先从原任务摘出不可变项，尤其逐侧核袜纹/配件，不把“一侧有纹另一侧素色”合并成“黑袜正确”；坐姿必须循髋膝踝和鞋底方向，遮住就写不确定。远桌只描述当前机位可见支腿与落地点，不要求四腿全露；侧后背影要核是否意外露出侧脸。背景改动与袜纹变化之间没有确定因果，不能据一次对照改默认模型或参数。

## 单参考native Edit例

先art_view真实参考；替换为用户已提供的本会话路径。本包style固定none：

```json
{"backend":"moss","mode":"edit","request_id":"native-edit-example-1","references":["visible/canvas.png"],"prompt":"Edit the first image: replace only the central subject with one small robot. Preserve the framing, floor and soft daylight. Output only the edited first image.","model":"sft","style":"none","lora_strength":0,"steps":30,"cfg":4,"shift":5,"width":768,"height":512}
```

## 质量边界，不等于验收通过

GPU执行成功、框外像素保护与画面合格是三件事。native Edit与regions的多参考画面质量仍属**quality experimental**：技术成功不等于角色保真，可能重复主体、出现接缝；必须逐图验收，不能宣传身份保真或“接缝已解决”，也不能偷偷退成t2i或风格参考图冒充。审图检查改动处、保留部位、数量与接缝；整图Qwen须单独授权且放弃框外逐像素不变。真机画质与多人/多参考一致性仍需逐图验收。

本包内画风只有none，不存在“prompt写名字就加载画风”的通道；若部署方自行接入画风LoRA，其效果与验收由部署方负责。
