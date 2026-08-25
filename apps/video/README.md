# 0xNuller Video

Video 是主站与独立部署共用的短时视觉闭环模块，使用「软件设置 → AI → Video」中的独立本地配置。Video 的服务商、API 凭据和模型不会从 Agent 或 Voice 复制，也不会随产品账户同步。

## 行为

- 进入模块先显示简洁的目标与授权设置；开启后切换为单一摄像头画面。
- 页面只显示最新处理画面，不显示容易混淆的原始画面副本。
- 画面固定为居中 16:9、最长边 768 px 和产品预设处理，用户不能修改裁剪、旋转、尺寸或画质参数。
- 摄像头每秒刷新内存中的最新帧；模型按 5、10、15 或 30 秒节奏保持单飞，请求期间的新帧会替换待处理旧帧。
- 仅可选择浏览器支持且模型 ID 明确列入图片输入清单的服务商与模型；未知、自定义、纯文本和免费模型均不可启动。
- 控制前必须在内存中授权本次连接的物理目标 ID、设备类型、通道、强度上限、时长、模型节奏以及增强/脉冲能力；单次最长 15 分钟。断开后的 ID 永久失效，同名设备重连不会继承授权。
- 原有郊狼/负鼠授权与运行时保持不变。NativeBridge 提供共享通用设备运行时时，Video 另行显示「通用嵌入设备」，并精确授权一个振动功能及归一化强度上限。
- 郊狼/负鼠模型复用 Agent 的工具定义、策略、权限执行器与安全队列，不直接访问设备传输。通用设备模型只获得快照、单功能振动、单功能停止与全局紧急停止；扫描由用户操作触发，模型看不到扫描、断开或 Raw 能力。
- 工具效果异步执行，不阻塞下一次观察；每次写入仍会检查授权代次和模块设备租约。
- 暂停、停止、模块隐藏、卸载、摄像头结束、设备断开、授权到期、观察看门狗或连续两次模型失败都会中止推理并停止授权目标。
- Web 可同时连接并逐一选择多个郊狼；无法证明多设备身份的原生传输仅暴露一个带临时 ID 的郊狼连接。
- 紧急停止会停止所有已连接输出目标、锁定当前授权并抢占队列；普通生命周期停止只操作授权的物理目标，目标身份失效时升级为全局停止。通用设备在每次最终写入前重新核验运行时、租约、授权和振动功能身份，并限制强度与输出租期。停止确认失败同样进入锁定状态，重新开始前必须重新授权。
- 图片不写入存储、同步、导出、会话历史或日志；文字回应也只存在于当前页面内存。

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
packages/agent/runtime/src/video-control-*.ts    内存授权与安全工具执行
packages/agent/agent-browser/src/create-browser-video-control.ts
                                                  Web/Android 共用设备组合边界
apps/web/src/modules/video.tsx                   统一外壳入口
```

Video 不依赖其他产品 app；模型输入合同与设备执行组合位于 `packages/agent`。
设置面板不持有授权、租约或设备安全决策；`App` 计算有效上限、目标可用性与启动行为后，
通过显式 view model 和 action 回调交给面板展示。
