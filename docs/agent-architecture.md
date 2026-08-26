# Agent 架构

Agent 是统一 Web/Android 产品内的功能模块，不再是独立产品 runtime。本文只补充
`docs/architecture.md` 中与模型驱动控制相关的边界。

## 当前链路

```text
apps/agent UI
  -> packages/agent/agent-browser 组合层
  -> packages/agent/client
  -> packages/agent/runtime
  -> @dg-kit tools / safety / protocol 契约
  -> 外壳提供的浏览器或 Tauri 设备 session
```

`apps/web` 装配 Agent 界面，`android/app` 提供 Android 生命周期与 Tauri BLE 能力。浏览器内嵌
runtime 仍是默认路径；CLI 或 daemon 目前不是交付物。

## 包职责

- `apps/agent`：React 渲染、用户输入、会话展示、界面专用 hook。
- `packages/agent/agent-browser`：不依赖 React 的浏览器服务组合。
- `packages/agent/client`：embedded/remote client 边界。
- `packages/agent/runtime`：轮次、工具执行、命令队列、策略、trace、触发器。
- `packages/agent/core`：建立在 `@dg-kit/core` 上的 Agent 契约。
- `packages/agent/providers-*`：模型 provider HTTP 适配。
- `packages/agent/audio-browser`：浏览器语音适配。
- `packages/agent/storage-browser`：设置、会话和 trace 持久化。
- `packages/agent/bridge`：远程消息桥接及其权限/队列边界。
- `packages/agent/waveforms`：Agent 面向共享波形库的适配层。

## 不变量

- UI 调用 Agent client，不自行构造协议帧，也不绕过安全层。
- `session.messages` 只存用户可见对话；工具结果、拒绝、失败、定时器进入 session trace；临时触发
  信息不持久化。模型上下文不得把缺少配对结果的历史工具叙述重新当成普通助手事实。
- runtime 和 provider 包不依赖 React 或 app 源码。
- 设备队列和播放状态按设备隔离；波形定义只按类型共享，与 Control、Chat、Voice 使用同一规则。
- 浏览器/Tauri 差异终止于组合或 transport 层，不进入工具语义。

## 多台郊狼如何由 AI 选择

Agent 会把每一台当前连接的郊狼作为独立目标展示给模型。即使两台设备名称完全相同，状态中也会
分别列出它们的 A/B 通道强度、上限、波形状态和一个临时 `targetId`。设备名称只帮助人阅读，
AI 的每个 `shock_*` 调用都必须逐字填写 `targetId`；应用不会把一个调用广播到多台设备，也不会
根据名称猜测目标。

`targetId` 是一次物理连接的临时身份，不是蓝牙地址、设备名称或可持久化标识。设备断开后，旧
身份立即失效；同一设备重新连接也会获得新身份。这样旧会话、延迟到达的模型调用或同名设备都
不能意外命中另一台仍在线的设备。

一次调用的实际路径是：模型选择当前 `targetId`，runtime 读取该实例的实时状态并执行安全策略，
需要时请求用户权限，再检查 Agent 的设备租约，最后由目标路由器重新确认身份和连接状态并写入
这一台设备。每个目标有独立的串行命令队列；停止仍保持可达，紧急停止仍可覆盖所有在线实例。

单台设备也使用同一套 `targetId` 规则，因此从一台增加到多台时不会改变工具语义。当前多实例
精确路由只覆盖郊狼；负鼠和两个只读传感器仍各自最多连接一台，通用实验设备使用其独立的
`deviceId`/`featureId` 能力路由。

## 测试

纯 runtime 状态与工具策略测试放在 `packages/agent/runtime` 源码旁；provider、storage、bridge、
浏览器组合测试各自留在所属包；React 交互测试放在 `apps/agent` 源码旁，`src/__tests__` 只用于
app 级组合契约。

新增设备工具必须覆盖 schema/registry、runtime 执行、安全拒绝、未连接行为及对应设备类型。
全仓规则见 `docs/testing.md`。
