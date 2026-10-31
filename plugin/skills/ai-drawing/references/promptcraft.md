# 提示词手艺：好看、复杂构图、精确复刻

目标是一版就接近用户想要的，不是抽卡。写稿顺序：主体占位→光→色→层次→材质密度→镜头，最后才补形容词。英文自然语言，一段到底，别写成 tag 堆。画风写进媒介与光色描述，本包不附带画风LoRA。

## 六件让画面好看的事

1. **主体占比**：半身/立绘占画面高度 55–75%，全身 70–85%；头顶留 5–8% 呼吸，脸不贴边。写具体（`waist-up framing, head to hips filling two thirds of the frame`），别只写 close-up。
2. **一个主光**：写方向、色温、软硬，再补一句"暗部保留细节"。例：`single cool-white key light from the upper left, soft falloff, shadow side keeps texture`。双主光容易灰。
3. **色彩结构**：一个主色＋一个对比色＋低饱和环境，写颜色名和面积（`large muted blue-grey environment; skin and white cloth carry the highlight`）。`beautiful colors` 不产生像素。
4. **前中后三层**：前景放遮挡物或虚焦人物并压暗做画框，中景放主体，背景只留环境光与材质。没有前景的画面最平。
5. **细节密度差**：脸、眼、重点衣物写细，环境写粗。全画面同等细节会显脏、显 AI。
6. **镜头**：写景别＋机位高度＋焦段感＋景深（`low angle, 50mm feel, shallow depth of field`）。俯拍仰拍改变体积与气势，比形容词有效。

## 复杂构图

- **主次**：主角给黄金分割位和清晰轮廓；副角只露肩、手、背影等局部，并明写"只露…入画"。两人都写全套细节会互相抢细节、也更容易长出第三个人。
- **纵深**：把前后关系写死（`his hand is closest, fully blurred into a dark silhouette; she lies on the bed in the middle ground; the stone wall is furthest`）。只写"有两个人"模型会把人并排。
- **动作线**：动作要有起点、终点、接触点（手压在并拢的膝头、杖尖抵地）。"刚/即将/还没"无效，改写可见间隙或接触。
- **重心与留白**：主体偏一侧，另一侧留环境；正中构图只适合对称设定图。
- **人数**：数量词贴人物写（`exactly two people in frame`），negative 补 `extra people, duplicate character, crowd`。人数漂移多半是同一个人的描述被写了两遍。
- **同一空间多层**：先写一个地面、接触点和单一消失方向，再放家具；否则家具悬空、出现两套透视。

## 精确复刻

1. 先 art_view 看真实像素，把"像素上看到的"和"用户说的/元数据记的"分开记。
2. 复刻已出过的图：找回原 params/seed，在**原文上局部替换**，不整篇重写。整篇重写容易丢构图特征，倾斜镜头尤其明显；只改要求处、其余逐字保留更稳。
3. 复刻参考图服装：成对部件写数量和每侧位置（`one around each upper arm`），写覆盖范围与层次（`fully covers her throat up to just under her jaw`），不写名词清单。
4. 参考图尺寸≠目标画布要换算（contain/cover/stretch），位移写进稿。
5. 复刻验收逐项核：长度、颜色分布、配饰数量、左右不对称、发饰层级。

## 真实失败与对策（有据）

- **头脚出框**：只写"头在框外"不够。写`the top edge cuts him off above the neck; his face and hair do not appear in the image`，同时写他只有肩到腰一段入画，并以实际像素验收是否仍露出边缘。
- **前景虚焦不够**：写`extremely close to the lens, heavily out of focus, only a dark silhouette mass and one smeared white glove`，再加`much darker than the subject`。只写 blurry 常常无效。
- **"不要 X" 在 t2i 不生效**：把饰边写进负面仍可能出现。改成正面描述要的样子（`plain unadorned hem`），并以实际像素验收。
- **符号替换**：星环/星辰信仰要写成具体物件（`thin silver chain with a small ring-star pendant`）；只写"不用十字架"会冒出十字架。
- **体型**：写形状与承托关系（`fitted triangle top, clearly full, narrow waist`），不写"性感/很大"。
- **不对称袜纹**：每侧单独写（`one leg printed floral lace, the other plain`），不合并成"黑袜正确"。
- **手**：每只手写状态和数量，段末写`she has only two hands`，仍逐图验收。
- **场景背景**：先骨架后物件；成组物件按结构写（`one central candle and two arms on each side`），长细线让两端靠近。

## 每版只改一处

记录基线（当前 run_id / revision），只列要改的那一处，其余描述逐字保留。下一版只比这一处；多处同改不能证明单一因果。单张图的改善不是规律，至少两版同向才算。

## 审图十项

人数与归属 → 朝向/遮挡 → 动作与接触点 → 关键人物取景 → 家具支撑与统一透视 → 光线与留白 → 服装部件逐侧核对 → 手与解剖 → 文字水印 → 与用户不可变要求的差异。看不见就写 UNKNOWN，不猜。
