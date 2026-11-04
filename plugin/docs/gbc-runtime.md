# GBC独立运行环境

GBC adapter随现有插件提供；Python环境、视觉依赖与合法本地权重由操作者配置，不修改全局Python/ComfyUI，不自动下载模型或启动GPU服务。当前候选代码能力与本机真实验收须分开报告。

## 前提与检查

使用明确选定的Python3.13、固定GBC/Togeari依赖及获准detector/embedder checkpoint。核心与构建锁分别在 [runtime lock](<../worker/gbc/requirements.lock.txt>)、[build lock](<../worker/gbc/build-requirements.lock.txt>)；版本/来源从实际metadata和安装receipt报告，不硬编码假验收。

[setup脚本](<../scripts/setup-gbc.ps1>)默认plan/check。环境由用户自行准备；只有操作者明确授权才运行其显式安装选项，新root必须独立，不能覆盖既有环境。模型gate、权重与Torch extras不是自动安装范围。

操作者可用自己的已批准路径运行：
```powershell
& $ApprovedPython -X utf8 -I (Join-Path $Package 'worker/gbc/bridge.py') --doctor --config $AbsoluteTrustedConfig
```
所有参数必须是实际的受信本地路径；不要照示例猜机器目录。doctor ready仅说明所查前提，不是VLM端点、权重正确性或GPU视觉质量证明。仅配置字段存在时必须报告configured/unchecked。

## 配置与路由

最小禁用配置：
```json
{"schema_version":1,"enabled":false}
```
启用配置由操作者提供vlm、detector、embedder和limits，模型路径是获准的绝对本地目录，密钥只用引用/环境变量名称，不能把值写进文档或快照。

- host-agent：同步冻结**发起分析Agent实际请求**的provider/model/推理选项，经受控loopback代理运行；不使用全局default冒充当前模型。缺可信选择或图像能力直接诊断。
- http：显式可信VLM协议/model/base_url与凭据引用，不能假称和主Agent同一账户。HTTPS或受控loopback要求按schema验证，不开放Agent任意URL。
- fallback=false全路径有效；允许回落也仅zero-call preflight的可恢复路由故障。已有模型调用不能移动claim/整worker重跑，不重置总调用预算/截止时间。
- 拒绝、截断、非JSON、算法错误、取消不属于可换模型绕过的网络故障。真实finish reason/usage如实返回，缺usage记未知。

## wire与生命周期

Host冻结获准图片的实际bytes、SHA256、尺寸、MIME、base Doc/revision、detail/fit及配置身份，独占claim后单次启动固定bridge。Python请求schema_version=1；PNG/JPEG/WebP输入经过Host规范化，限制尺寸/字节，并拒绝不安全路径/链接。graph内部可能有私有路径，公开status只出有界安全摘要。

成功或degraded返回受校验的graph；degraded须披露warnings。failed/not_ready不得伪造graph；stdout为空/进程退出0不等于成功，以合法回执与实际状态为准。正常analysis成功exit0，受控执行失败exit3，参数/边界错误exit2；doctor合法报告exit0可仍是not_ready。

取消/客户端断开/代理close应停止新dispatch并中止上游等待，不能只关HTTP连接；但不能保证远端费用撤销。永久claim、原result和已用额度保留，超时/缺结果/unknown不得自动重放。日志采用安全码，脱敏先于tail截断，不保留原始敏感traceback。

profiles为quick/balanced/detailed（工具默认balanced），调用次数和时限由可信limits约束。总调用预算是node invocation上限，不是token/金额保证；CPU/CUDA设备由获准环境提供，不承诺所有模型可在CPU运行。

## 结构落页与验证

Agent按analysis指南：一次start→一次wait→有界详情→studioAnalysisPropose映射为Layout；generation.prompt只辅助描述。保留Caption/shared/锁/人工修改；revision变化不得拿新版本强套旧图。GBC不是精确3D/分割/遮挡真值或画质证明。

replay可验证调度/图构造，不等于当前图片真实推理；stats.model_calls或版本号也不能单独排除replay。每次发行分别列源码/SDK、故障注入、真实依赖、live模型、GUI和GPU验证范围，未运行的明确未验证。

GBC/Togeari及依赖各自许可保留；EmbeddingGemma、SAM3等模型条款/门槛须操作者核实，不因本插件MIT而自动取得模型许可。
