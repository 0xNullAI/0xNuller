# DG-Voice · 开发者文档

面向想给 DG-Voice 加功能、接新 provider、或理解它跟 DG-Agent 关系的人。

> 状态：v0.1.0。设备层与安全链已完成并有测试覆盖；实时语音连接（`RealtimeSession`/`VoiceToolBridge`）、设置面板、安卓壳尚未开工。本文档描述已落地和已定的架构决策，标注清楚哪些还是设计而非实现。

## 仓库形状

独立仓库，不是 DG-Agent 的一部分——DG-Agent 是 `packages/*` 全 `private` 的 workspaces 单体仓，外部无法消费；DG-Voice 照 DG-Chat 的形状，独立仓库直接消费已发布的 `@dg-kit/*`：

```
DG-Voice/
  src/
    lib/            纯 TS——设备层、安全链、实时语音客户端（无 React 依赖）
      device-session.ts       统一四设备连接（@dg-kit/transport-webbluetooth）
      policy-engine.ts        PolicyEngine / OpossumPolicyEngine
      default-policies.ts     冷启动钳制、强度上限、burst 上限、权限门
      device-command-queue.ts 串行命令队列 + emergencyStop 优先中断
      permissions.ts          BrowserPermissionService（confirm / timed / allow-all）
      tool-registry.ts        @dg-kit/tools 接线 + 滑动窗口限速
      tool-executor.ts        把一次 ToolCall 过完整安全链
      waveform-library.ts     design_wave 用的 IndexedDB 波形库
      types.ts                ActionContext / PolicyDecision / PermissionService
    hooks/          对 lib/ 的 React 绑定
    components/     UI（ui/ 是从 DG-Agent 逐字拷贝的 shadcn 组件）
    services/       有状态单例（theme.ts）
    styles/         设计 token，逐字拷自 DG-Agent，不要单独改这里的值
  worker/           Cloudflare Worker，纯静态资源托管，无服务端代码
```

## 为什么没有服务端中转

每个受支持 provider 的临时票据接口都做了真实的 `curl -i -X OPTIONS` 预检验证（不是猜测），确认返回 `Access-Control-Allow-Origin: *`——所以浏览器可以直接用用户自带的 key 换实时会话票据。智谱 GLM 更进一步：key 本身可以在浏览器本地签 HS256 短时 JWT，连网络换票这一步都不需要。

**不要"以防万一"加一个中转 Worker。** 如果未来真的出现一个必须服务端换票的 provider，那才是加中转的触发条件——不要提前加。

## 核心设计：不写 Agent 循环

DG-Agent 的 `AgentRuntime.runToolLoop()` 是请求/响应式的回合制循环：转录一句话 → 跑工具循环 → 按句子边界喂 TTS。这套东西**完全不适用**于"打开就一直连着，模型自己决定何时说话"的实时语音形态——两者在 loop 层不兼容，这正是 DG-Voice 独立成仓的直接原因。

DG-Voice 因此：

- **不实现任何调度循环**。工具定义从 `registry.listDefinitions()` 拿，塞进 provider 的 `session.update`；什么时候说话、调不调工具、调哪个，全部由 provider 服务端决定
- **`ToolExecutor` 是唯一的本地逻辑**，且只在 provider 已经决定调用工具之后运行——它不知道语音的存在，就像 DG-Agent 的 `RuntimeToolExecutor` 不知道 LLM 的存在
- `VoiceToolBridge`（未实现）不是循环，是事件处理器：监听 provider 的 `function_call_arguments.done` 之类事件，转给 `ToolExecutor`，再把结果喂回去

## 设备层：直接消费 `@dg-kit/*` 1.13.0

不重新实现——`WebBluetoothOpossumClient` / `WebBluetoothPawPrintsClient` / `WebBluetoothCivetEdgingClient` 和 aux-connect 辅助函数是专门为了让 DG-Voice（和其他未来消费者）不需要写第四份实现，才从各仓库分散实现中抽取进 `@dg-kit/transport-webbluetooth` 的。如果发现自己在这个仓库里写新的按设备类型分的 BLE client，大概率写错了层——应该进 `@dg-kit/*`。

## 安全链：从 DG-Agent 移植，语义必须保持一致

`policy-engine.ts`、`default-policies.ts`、`device-command-queue.ts` 移植自 `DG-Agent/packages/runtime/src/{policy-engine,default-policies,device-command-queue}.ts`，只调整了独立仓库的 import 路径——冷启动钳制、强度上限、burst 上限、权限门顺序这些**安全语义必须跟 DG-Agent 保持一致**。如果 DG-Agent 的安全规则以后变了，这几个文件不会自动同步，需要手动对齐（DG-Kit 自己的 CLAUDE.md 明确说策略是运行时注入、故意不烘进 kit，所以这次没有把它们提升进 `@dg-kit/*`——如果这个实验做成了，这是一个待办的收敛点）。

`resolvePolicy`/`resolveOpossumPolicy` 在每次钳制后都会重新求值（上限 4 次迭代）——一次钳制不能短路掉后面的 `permission-gate` 规则。这是改 `tool-executor.ts` 时最容易出错的一点。

## 限速：滑动窗口而不是回合制

`tool-registry.ts` 注入 `createSlidingWindowRateLimitPolicy`（跟 DG-MCP 同一个选择），因为实时会话没有"回合"边界。`caps` 的 key 必须用注册表当前的主名（`shock_adjust`/`shock_burst`/`vibrate_adjust`/`vibrate_burst`），用错历史别名会静默失效而不是报错——这个 bug 在 DG-MCP 出现过一次，不要重蹈。

## 多 Provider 抽象（设计，`RealtimeSession` 尚未实现）

xAI 的 realtime API 本身就是 OpenAI-Realtime 事件形状兼容的，所以计划只写一套 `openai-realtime` 方言的客户端，覆盖 xAI/OpenAI/Azure 三家；智谱 GLM 单独一个 `glm-realtime` 方言（约 200 行差异：wav 而非 pcm16、`client_vad`/`server_vad` 命名、`.done` 需要按 `call_id` 聚合等）。

抽象层预留了两个各家分歧最大的口子：

- `requestResponse()`（对应 OpenAI 系的 `response.create`）是**可选钩子**，不是必经步骤——某些 provider 收到工具结果后自动续说，没有这一步
- 工具定义能否运行时下发，是选 provider 的硬性筛选条件（不是要适配的差异点）——不支持运行时声明工具的 provider（比如需要预先在服务端注册工具的那些）结构上就不适合 DG-Voice，因为 DG-Voice 的工具集取决于当前连了哪些设备

## 安卓（未实现）

计划复用 DG-Agent/DG-Chat 已验证过的 `apps/tauri-android` 壳形状。已确认可行、无需自己写 Rust/Kotlin：wry 0.54.4 的 `onPermissionRequest` 能处理 `getUserMedia` 的麦克风权限，但要求 manifest 同时声明 `RECORD_AUDIO` **和** `MODIFY_AUDIO_SETTINGS`——wry 的权限回调是全有或全无的，漏一个都会导致整体被拒（DG-Chat 的语音消息功能就踩过这个坑，本次已修复，见 [DG-Chat 开发者文档](#/chat/developer)）。

安卓锁屏会挂起 WebView，`setInterval`/Worker 全停——v1 采取安全解：锁屏就挂断 + `emergencyStop`。真正的后台续航需要前台服务，且上游 Tauri 有一个未修复的白屏 bug（tauri#15671），所以明确排除在 v1 之外。

## 测试

已实现部分的测试直接照搬 DG-Agent 对应模块的测试语义（安全语义照搬，测试也照搬，防止两边漂移）：

```bash
npm install
npm run test         # 策略引擎 / 命令队列 / 权限服务
npm run typecheck
npm run build
npm run lint          # 零警告策略，没有历史包袱
```

## 分支约定

跟 DG-Kit/DG-Agent/DG-Chat 一致的两层分支模型：`dev` 日常开发 → `main` 发布，`auto-tag.yml` 在 push 到 `main` 时自动打 tag + 建 Release，`release-guard.yml` 拦截没 bump 版本号的 PR。

## Sister Projects

| 项目 | 用途 |
|---|---|
| [DG-Kit](#/kit/overview) | 共享 TypeScript 中台（本项目消费） |
| [DG-Agent](#/agent/manual) | 浏览器版 AI 控制器（文字聊天，安全链的移植来源） |
| [DG-Chat](#/chat/manual) | 多人 P2P 房间 + 远程控制 |
| [DG-MCP](#/mcp/manual) | MCP 服务端，供 Claude Desktop 等使用 |
