# 0xNuller Voice

中文 | [English](README.en.md)

实时语音 AI 模块。模型负责语音对话和工具请求，设备命令由本地安全与权限层执行。

- 统一主站：<https://0xnullai.com/voice>

## Provider

- xAI Realtime
- OpenAI Realtime 与兼容服务
- Azure OpenAI Realtime
- 智谱 GLM Realtime
- 由 `0xnullai-voice` Worker 按 Credit 计量的 0xNullAI Voice

自带密钥模式直接连接所选服务；0xNullAI Voice 通过主站 `/api/realtime` 建立按 Credit 结算的会话。文本模型
和语音模型在统一设置中独立管理。

## 功能

- 免按键的双向实时语音与字幕记录。
- 已绑定私人角色关系的通话可按当前问题只读检索已确认 Memory 与同一聊天的较早原话；检索结果不写入记忆，也不授予设备权限。
- 与 Agent 共用场景，与其他模块共用设备连接、波形和安全设置。
- 支持郊狼与负鼠控制；只读传感器由全局设备层展示。
- 工具请求确认、命令串行执行、通话结束停止与全局紧急停止。
- 网页与安卓共用主要 UI 和业务逻辑。

## 使用

1. 在「软件设置 → AI → 语音模型」配置 provider，或选择 0xNullAI Voice。
2. 从顶部设备横栏连接设备。
3. 选择角色并开始通话；可在角色聊天中叠加已导入的场景。
4. 挂断、切换模块或使用顶部停止操作结束输出。

## 本地开发

```bash
npm install
npm run dev -w 0xnullai-voice
npm run test -w 0xnullai-voice
npm run typecheck -w 0xnullai-voice
npm run build -w 0xnullai-voice
npm run cf:dev -w 0xnullai-voice   # 托管 Voice Worker
```

统一外壳开发使用 `npm run dev -w @0xnullai/web`。

## 代码结构

```text
src/lib/realtime/       Realtime provider 适配
src/lib/                音频、设备与工具桥
src/hooks/              React 状态绑定
src/components/         通话与设置 UI；共享设备面板来自 @0xnullai/ui
worker/                 托管入口与 ManagedVoiceSession DO
```

托管 Worker 的账户票据、Credit 和部署配置见 [worker/README.md](worker/README.md)。正式发布前仍需
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

## 同一私人对话

从文字对话的「转语音」进入时，延续账户、会话、角色与私人关系。启动通话前必须成功打开
服务器会话，并读取最近文字、公开角色卡与已确认的私人记忆；首次直接进入 Voice 会为选定
角色创建新会话。场景不能单独创建聊天实体。最终字幕使用每次通话唯一且可重试的消息 ID 保存；
流式片段和音频不持久化。
同一次通话的最终字幕依接收顺序写入；若前一条保存失败，后续字幕暂停写入，用户在当前页面
重试后按原顺序补齐，避免先后颠倒。失败字幕仍只暂留当前页面，关闭页面前应完成重试。
若服务器会话绑定了可选场景，Voice 只叠加当前账户已导入的场景环境 Prompt，角色身份和
私人记忆仍由同一角色与关系持有；场景缺失时不会悄悄改用全局 Market 选择。
保存失败显示重试入口，未保存文本只暂留当前页面，离开前应重试。
当最终字幕尚在上传或保存失败时，浏览器刷新／关闭会触发原生离页确认；取消离开后可在本页重试。
浏览器或系统强制终止进程时无法保证提示或请求送达，因此不会声称此类字幕已备份，也不会
把聊天记录写入本地持久存储。
从 Voice 内的「继续文字对话」或「摄像头观察」跳转时，会先挂断并重试保存最终字幕；
若服务器仍无法保存，则停留在当前页显示错误，避免这两个入口直接丢失待保存字幕。
语音工具回执会校验最终字幕中的设备执行声明；未经证实的“已启动/已停止”不会作为
事实写进服务器聊天记录。有设备工具可用时，实时音频先缓冲到该回复结束，仅在最终字幕
存在且通过同一回执校验后播放；无字幕、用户打断或缓冲超限时不播放。这会增加设备通话
回复的播放延迟。仍需真实服务商通话验证其音频与字幕一致性；仅凭字幕无法证明逐字一致。
用户正常开始说话不会丢弃下一段回复；只有已经开始生成的回复被用户插话时才丢弃其未播放缓冲。

切换账户立即挂断并清空字幕，旧事件不能写入新账户。回到文字聊天可继续该会话。界面区分
平台语音使用现有 Credit 和自带密钥的服务商计费，不建立第二套钱包。

The call panel displays the same private relationship portrait as camera mode, with a visible ring
while the voice provider reports speaking. This is a 2D image, not lip-sync or a 3D avatar.
通话中头像成为主视觉；连接中、等待语音和 AI 正在说话均有文字状态，语音提供商报告说话时
显示光环，并遵循系统减少动态效果设置。头像仍为 2D，不进行口型同步。

新托管电话使用开始通话时的服务器会话与固定callId关联Credit消费；同一callId用于最终字幕
历史，切换页面/角色不重绑已进行的电话。仅managed transport携带账务上下文，BYOK不发送。
