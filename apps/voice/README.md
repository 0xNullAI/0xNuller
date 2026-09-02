# 0xNuller Voice

中文 | [English](README.en.md)

实时语音 AI 模块。模型负责语音对话和工具请求，设备命令由本地安全与权限层执行。

- 统一主站：<https://0xnullai.com/voice>

## Provider

- xAI Realtime
- OpenAI Realtime 与兼容服务
- Azure OpenAI Realtime
- 智谱 GLM Realtime
- 由 `0xnullai-voice` Worker 计量的体验模式

自带密钥模式直接连接所选服务；体验模式通过主站 `/api/realtime` 建立短期会话。文本模型
和语音模型在统一设置中独立管理。

## 功能

- 免按键的双向实时语音与字幕记录。
- 与 Agent 共用场景，与其他模块共用设备连接、波形和安全设置。
- 支持郊狼与负鼠控制；只读传感器由全局设备层展示。
- 工具请求确认、命令串行执行、通话结束停止与全局紧急停止。
- 网页与安卓共用主要 UI 和业务逻辑。

## 使用

1. 在「软件设置 → AI → 语音模型」配置 provider，或选择体验模式。
2. 从顶部设备横栏连接设备。
3. 选择场景并开始通话。
4. 挂断、切换模块或使用顶部停止操作结束输出。

## 本地开发

```bash
npm install
npm run dev -w 0xnullai-voice
npm run test -w 0xnullai-voice
npm run typecheck -w 0xnullai-voice
npm run build -w 0xnullai-voice
npm run cf:dev -w 0xnullai-voice   # 体验模式 Worker
```

统一外壳开发使用 `npm run dev -w @0xnullai/web`。

## 代码结构

```text
src/lib/realtime/       Realtime provider 适配
src/lib/                音频、设备与工具桥
src/hooks/              React 状态绑定
src/components/         通话与设置 UI；共享设备面板来自 @0xnullai/ui
worker/                 体验模式入口与 TrialSession DO
```

体验 Worker 的账户票据、额度和部署配置见 [worker/README.md](worker/README.md)。正式发布前仍需
用真实 provider 完成浏览器与安卓端到端通话、工具调用和挂断停止验收。

Voice Realtime 不复用文本 HTTP client：WebSocket 事件、双向音频、换票/Azure/Zhipu 鉴权和音色
目录均属实时协议。统一设置只复用 catalog-driven 字段渲染；通用设备则复用
`@0xnullai/device-runtime` 的 AI schema、调用适配器和输出权限分类，Voice 保留自己的通话权限与
结束停止生命周期。

## AI 设备目标边界

- Realtime 会话只向模型声明当前已连接且可用的设备。连接、断开或通用设备拓扑变化时，Voice 会
  在原会话中一起更新说明和工具列表；断开、故障或仅保存过设置的设备不会留在 AI 上下文中。
- 郊狼使用与 Agent 相同的 `MultiCoyoteDeviceClient` 和 exact-target router，可同时连接多台同类型
  甚至同名设备。每个连接实例拥有独立的 opaque `targetId`、协议 client、命令队列与停止路径；
  模型工具必须逐字指定一个当前 `targetId`，不会按名称选择、合并或广播。Web 与 Android 使用同一
  组合方式。
- 负鼠底层 transport 当前仍为单实例 client，因此 Voice 同一时间只连接一台负鼠；断开重连会生成
  新的本地 opaque 身份，旧身份不能迁移到新硬件。
- 通用设备运行时支持多个设备和多个振动功能。模型看到的是每个实例独立的 opaque `deviceId` 与
  `featureId`，每次工具调用必须精确指定一对 ID；名称不进入模型状态，命令不会广播或 fan-out。
- 输出命令在进入对应目标的独立队列前会重新检查连接身份、权限结果和当前模块租约。身份或租约在
  确认期间发生变化时，本次增加输出会失败关闭；停止与全局紧急停止不受普通输出权限或租约阻断。

## 部署

主站的 `0xnullai-voice` 接管 `/api/realtime`；历史独立子域已下线。完整步骤见
[部署文档](../../docs/deploy.md)。

## 协议

[MIT](../../LICENSE)
