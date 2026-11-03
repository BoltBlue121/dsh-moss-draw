# 用户与Agent配置

## 用户/操作者

使用已有本地或远端ComfyUI，插件不安装/启动它，不下载模型或自动开端口。默认origin候选http://127.0.0.1:8188；远端用你批准的HTTP(S) origin，并自行配置访问控制/TLS，不能把任意URL交给绘图Agent。

[本地配置](<../config/examples/local.json>)和[远端配置](<../config/examples/remote.json>)提供comfyUrl、workflowMode:'layout'与editEngine:'native'。配置以实际schema校验为准；不在示例里放明文凭据。原生Session的workspaceRoot来自workingDirectory.get(session)，显式root优先；缺可信目录就报告配置错误，不猜开发者路径。

操作者只读检查：
```text
node scripts/check-connection.mjs --workspace <absolute-workspace> --config <trusted-config.json> --mode moss-t2i
```
可选`--comfy-url <origin>`，可重复`--mode moss-t2i|moss-edit|k2-t2i|qwen-edit`，`--help`看完整用法。仅GET /object_info；exit0表示所查Comfy要求满足，exit2表示缺项/不可达/配置错误。没有GBC doctor hook时只报告configured/unchecked，不能由Comfy ready推导GBC ready。

## Agent

选择AI画画预设或声明对应scope，只有七个art_*工具。先art_guide quick，再按需setup/studio/analysis。候选只读诊断是独立形状：art_context({connection:true})；旧Host不认识字段应升级/报告，不换业务路径假成功。

新t2i先设计最小Layout（单杯也一样），series/page后Start，再写稿/同版检查/prepare冻结native预览/execute；保留用户明确参数，Moss省略cfg默认4。无每步人工确认，但先审、锁、manual/paused、仅文字、提案与预算优先。

参考图新生图走GBC→Layout提案/编辑，不直接用扁平generation.prompt出图；明确编辑原图走edit/regions。GBC需要获准Python、依赖、本地detector/embedder模型与可用视觉路由；缺项报告not_ready，不安装/下载/索要Key。

## 迁移与专家模式

默认workflowMode='layout'；仅操作者明确选'compat'才允许旧Caption/raw新t2i，Agent不能自己切。旧Doc和旧冻结计划保留，不为迁移改写unknown或退预算。保存配置前确认长作业的目标归属；目标变化时不把旧run发送到另一ComfyUI。

安装/更新使用官方Plugin Manager，按application/warnings决定是否重新加载/正常重启。新会话验证新preset；旧会话可能保持旧revision。没有当前实页/实图证据时明确未验证，不把配置正确当生成成功。
