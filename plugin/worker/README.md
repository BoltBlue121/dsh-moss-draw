# 可选配套节点：MossDrawEditStyleLoader

`MossDrawEditStyleLoader` 是 ComfyUI 的**可选**自定义节点：在 MOSS native Edit 的编辑 adapter 安装之前，把部署方自己的**画风 LoRA** merge 进 SFT 浮点权重，再输出 `MOSS_EDIT_MODEL` 接回上游 `MossImageEdit`。

本便携包默认 `style=none`、不使用任何画风 LoRA，因此**默认部署不需要安装这个节点**：插件默认的 native Edit 链使用 ComfyUI 的 MOSS native 节点（基础权重 + 编辑权重 + `TextEncodeMOSSImageEdit` 等），不引用本节点。只有部署方以后自行接入自己的画风 LoRA（属于二次开发，不在本包支持范围）时才需要它，配合上游的 `MossImageEditLoader` / `MossImageEdit` 编辑链使用。

本目录只有节点源码，**不含权重、训练器、ComfyUI 核心、上游 runtime 副本或用户图**。

## 文件

```text
worker/moss-draw-style/
  __init__.py    导出 NODE_CLASS_MAPPINGS / NODE_DISPLAY_NAME_MAPPINGS
  nodes.py       节点实现：查找上游 runtime、校验 LoRA 路径、merge 与缓存
  style_lora.py  纯函数：读取/合并 LoRA 状态字典
```

## 与上游的关系

- 节点不修改、不覆盖上游 ComfyUI-Moss-Image-Edit 的任何文件，也不重复注册它的节点。
- 执行时才查找「唯一」已加载的兼容 runtime；找不到或发现多个兼容 runtime 会直接报错，不猜测。
- 与上游 `MossImageEditLoader` 的加载顺序不同：本节点先把画风 LoRA 合并进完整 SFT 浮点权重，再注入独立的编辑 adapter 并量化。上游节点不支持这个顺序，所以节点源码与 UI 描述里把它标为 experimental。

## 安装

1. 部署方的 ComfyUI 已安装并可正常使用上游 ComfyUI-Moss-Image-Edit（本节点复用它已加载的 runtime）。
2. 确认 ComfyUI 队列为空，且没有其它维护操作正在进行。
3. 把 `moss-draw-style` 目录**原样**复制到该 ComfyUI 的 `custom_nodes` 下的独立目录（例如 `ComfyUI/custom_nodes/moss-draw-style/`；实际路径以部署方安装位置为准）。
4. 正常重启 ComfyUI。节点在第一次执行时才查找上游 runtime，因此与上游节点的启动顺序无关。
5. 验证：打开 ComfyUI 的 object_info 或节点菜单，应能看到 `MossDrawEditStyleLoader`；上游 `MossImageEditLoader` 与 `MossImageEdit` 仍应存在且可用。
6. 节点入参：`snapshot_dir`、`adapter_dir`（与上游 `MossImageEditLoader` 一致）、`style_lora`（必须是 ComfyUI `loras` 目录中已注册的相对路径）、`strength`。输出接到 `MossImageEdit` 的 model 输入。

## 回退

1. 停止当前 ComfyUI 队列/任务；如需留档先备份要移除的目录。
2. **只**移除 `custom_nodes` 下本节点的独立目录；不要删除或改动上游 ComfyUI-Moss-Image-Edit。
3. 正常重启 ComfyUI，确认上游节点与既有工作流仍可用。
4. 插件默认的 `style=none` 链路本来就不引用本节点，回退不影响默认生成。

## 边界与已知限制

- 画风 LoRA 由部署方自行提供，并自行确认其许可证与来源；本包不附带任何 LoRA 权重。
- 节点会校验 `style_lora` 必须是 `loras` 目录内的 safetensors 相对路径，并在读取前后用 SHA256 校验文件未被替换。
- 缓存是单条有界缓存：换画风/换强度/换上游 runtime 都会新建管线，不会在旧实例上重复 merge。
- `worker/tests/` 是 CPU 微型模型与纯逻辑测试，用部署方自己的 ComfyUI Python 环境运行（在 `plugin/` 目录执行 `python -m unittest discover -s worker/tests -v`）。它**不是** GPU 画质、身份保真或任意画风效果的验收；没有真机试跑前不得宣称已经可用。
- 本节点只负责「画风 LoRA 合并」这一个环节；提示词、构图、审图与区域执行仍按插件指南与工具契约处理。
