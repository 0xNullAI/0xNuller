# 0xNuller Video

Video 是主站与独立部署共用的短时视觉闭环模块，使用「软件设置 → AI → Video」中的独立本地配置。Video 的服务商、API 凭据和模型不会从 Agent 或 Voice 复制，也不会随产品账户同步。

## 使用

1. 在「软件设置 → AI → Video」配置明确支持图片输入的模型。
2. 在「软件设置 → 场景」选择或编写场景；Video 会把当前场景与内置连续观察规则一起发送。
3. 连接一台或多台输出设备。通用设备只使用「软件设置 → 关于」的全局本机开关。
4. 在 Video 选择摄像头、时长、观察间隔及是否允许增强/脉冲，然后点击「开启」。
5. AI 从只读能力列表中自行选择一台精确设备与通道。暂停、结束或紧急停止随时可用。

## 行为

- 进入模块先显示简洁的目标与授权设置；开启后切换为单一摄像头画面。
- 页面只显示最新处理画面，不显示容易混淆的原始画面副本。
- 画面固定为居中 16:9、最长边 768 px 和产品预设处理，用户不能修改裁剪、旋转、尺寸或画质参数。
- 摄像头每秒刷新内存中的最新帧；模型按 5、10、15 或 30 秒节奏保持单飞，请求期间的新帧会替换待处理旧帧。
- 仅可选择浏览器支持且模型 ID 明确列入图片输入清单的服务商与模型；未知、自定义、纯文本和免费模型均不可启动。
- 控制前把当前连接的郊狼、负鼠与通用振动 capability 复制进一次性的内存白名单；单次最长 15 分钟。页面只读展示这份能力列表，不要求用户预选输出。模型的每次工具调用都必须逐字提交白名单中的 exact target identity 与通道。
- Video 与 Control 复用 `UnifiedOutputTarget`；Control 使用交互式 `OutputTargetPicker`，Video 使用只读 `OutputCapabilityList`。Video AI 从同一白名单自行选择目标，但一次工具调用仍只路由到一个物理目标，绝不 fan-out。
- 所有目标的安全上限都读取「软件设置 → 设备与安全」的同一份共享设置：郊狼使用通道强度上限，负鼠使用通道振动强度上限，通用设备把共享振动上限映射到归一化 0..1，不维护 Video 私有安全配置。
- 郊狼/负鼠模型复用 Agent 的工具定义、策略、权限执行器与安全队列，不直接访问设备传输。通用设备模型只获得快照、单功能振动、单功能停止与全局紧急停止；扫描由用户操作触发，模型看不到扫描、断开或 Raw 能力。
- 每次写入仍会检查白名单、授权代次、模块设备租约、共享权限/策略与 stop fence。AI 从目标或通道 A 切到 B 前必须先确认 A 已停止；停止失败会撤销整个授权、全局停止且不执行 B。
- 暂停、停止、模块隐藏、卸载、摄像头结束、设备断开、授权到期、观察看门狗或连续两次模型失败都会中止推理并停止授权目标。
- Web 可同时连接多个郊狼；负鼠和每个通用振动 capability 也进入同一授权列表。任一白名单身份断开、同名重连或通用 runtime session 切换都会撤权并停止。无法证明多设备身份的原生传输仍只暴露一个带临时 ID 的郊狼连接。
- 紧急停止会停止所有已连接输出目标、锁定当前授权并抢占队列；普通生命周期停止只操作授权的物理目标，目标身份失效时升级为全局停止。通用设备在每次最终写入前重新核验运行时、租约、授权和振动功能身份，并限制强度与输出租期。停止确认失败同样进入锁定状态，重新开始前必须重新授权。
- 图片不写入存储、同步、导出、会话历史或日志；文字回应也只存在于当前页面内存。
- 当前选定场景会进入统一多目标模型请求；内置启动规则把模式固定为连续观察最新帧、每帧只推进
  一小步，并要求工具结果而非工具请求决定是否能声称执行成功。

Video 不是实验功能。实验边界仅是通用设备 backend，并且只使用「软件设置 → 关于」中的全局
本机开关；Video 不维护独立开关。关闭时 Video 不创建通用设备服务、不显示查找入口，也不把通用
设备放入模型目标列表；摄像头、郊狼和负鼠流程保持不变。开启后，Video 与 Control 共用同一运行时
和扫描语义，当前连接的多个设备 capability 进入一个只读列表，由 AI 在每次调用中精确选择一个。

摄像头在网页中需要 HTTPS 或 localhost。Android 壳继续通过原生桥请求 `CAMERA` 权限。

## 结构

```text
src/App.tsx                                      Video 授权、会话与生命周期组合
src/components/VideoSetupPanel.tsx               纯展示设置表单与 typed view model/action 边界
src/components/CameraWorkbench.tsx               单一处理后画面与结束操作
src/hooks/use-camera-preview.ts                  浏览器采集、预览资源和摄像头生命周期
src/services/camera-frame.ts                     帧几何、像素处理、压缩与大小限制
src/services/frame-preview-url.ts                处理后预览的对象 URL 生命周期
src/services/visual-session.ts                   最新值调度、单飞、看门狗与失败停止
src/services/device-runtime-video-control.ts     通用设备的会话授权、模型收窄与停止升级
src/services/video-ai-device-router.ts           多后端白名单、AI exact-target 路由与切换 stop
packages/platform/device-runtime/src/output-targets.ts
                                                  跨模块统一输出身份、列表与共享安全上限映射
packages/platform/ui/src/components/output-target-picker.tsx
                                                  Control / Video 共用的输出选择器
packages/agent/runtime/src/video-control-*.ts    内存授权与安全工具执行
packages/agent/agent-browser/src/create-browser-video-control.ts
                                                  Web/Android 共用设备组合边界
apps/web/src/modules/video.tsx                   统一外壳入口
```

Video 不依赖其他产品 app；模型输入合同与设备执行组合位于 `packages/agent`。
设置面板不持有授权、租约或设备安全决策；`App` 计算有效上限、目标可用性与启动行为后，
通过显式 view model 和 action 回调交给面板展示。

Video 的凭据 profile 继续与 Agent/Chat 隔离，但复用 platform provider 目录/scoped store 和
agent-browser client/model discovery。只有明确 image-capable 的 provider/model 能通过；视觉帧、
目标 grant、lease、授权代次和失效停止升级仍是 Video 专属边界。
