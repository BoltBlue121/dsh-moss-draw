# 可选Worker配套节点

moss-draw-style提供独立MossDrawEditStyleLoader，接现有编辑链，不覆写第三方原节点。适用于相应legacy CPU full-transformer/style merge路径；原生Edit是否需要它以所选模式和object_info为准。节点存在不证明权重可用或画质合格。

操作者在自己的既有ComfyUI环境安装前先核对依赖/许可、备份、队列与其它维护者状态，不启动第二个GPU服务，不自动升级Torch/CUDA。回退只处理明确安装的配套节点，不删除原编辑链或用户作品。

本地CPU微型模型测试（使用操作者已批准Python，不下载模型）：
```text
python -B -m unittest discover -s worker/tests -p test_style_lora.py -v
```
GBC为另一独立adapter，见 [GBC环境](<../docs/gbc-runtime.md>)。运行环境、模型权重、ComfyUI核心、上游runtime副本及用户图片不在本包内。单元测试不是GPU身份/风格/视觉验收。
