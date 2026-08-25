# 0xNuller Video

Video 是主站与独立部署共用的短时视觉闭环模块，使用「软件设置 → AI → Video」中的独立本地配置。Video 的服务商、API 凭据和模型不会从 Agent 或 Voice 复制，也不会随产品账户同步。

## 行为

- 用户显式开启前置或后置摄像头，页面提供实时本地预览。
- 摄像头以 0.2–5 秒的独立频率刷新内存中的最新帧；模型按 5、10、15 或 30 秒节奏保持单飞，请求期间的新帧会替换待处理旧帧。
- 仅可选择浏览器支持且模型 ID 明确列入图片输入清单的服务商与模型；未知、自定义、纯文本和免费模型均不可启动。
- 控制前必须在内存中授权目标设备、通道、强度上限、时长、模型节奏以及增强/脉冲能力；单次最长 15 分钟。
- 模型复用 Agent 的工具定义、策略、权限执行器与安全队列，不直接访问设备传输。
- 工具效果异步执行，不阻塞下一次观察；每次写入仍会检查授权代次和模块设备租约。
- 暂停、停止、模块隐藏、卸载、摄像头结束、设备断开、授权到期、观察看门狗或连续两次模型失败都会中止推理并停止授权目标。
- 紧急停止会停止所有已连接输出目标、锁定当前授权并抢占队列；停止确认失败同样进入锁定状态，重新开始前必须重新授权。
- 图片不写入存储、同步、导出、会话历史或日志；文字回应也只存在于当前页面内存。

摄像头在网页中需要 HTTPS 或 localhost。Android 壳继续通过原生桥请求 `CAMERA` 权限。

## 结构

```text
src/App.tsx                                      Video 界面、授权与生命周期
src/hooks/use-camera-preview.ts                  浏览器采集和摄像头生命周期
src/services/camera-frame.ts                     单帧压缩与大小限制
src/services/visual-session.ts                   最新值调度、单飞、看门狗与失败停止
packages/agent/runtime/src/video-control-*.ts    内存授权与安全工具执行
packages/agent/agent-browser/src/create-browser-video-control.ts
                                                  Web/Android 共用设备组合边界
apps/web/src/modules/video.tsx                   统一外壳入口
```

Video 不依赖其他产品 app；模型输入合同与设备执行组合位于 `packages/agent`。
