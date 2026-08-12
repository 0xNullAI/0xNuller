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
- `session.messages` 只存正常对话；工具结果、拒绝、失败、定时器进入 session trace；临时触发
  信息不持久化成用户可见历史。
- runtime 和 provider 包不依赖 React 或 app 源码。
- 设备队列和播放状态按设备隔离；波形定义只按类型共享，与 Control、Chat、Voice 使用同一规则。
- 浏览器/Tauri 差异终止于组合或 transport 层，不进入工具语义。

## 测试

纯 runtime 状态与工具策略测试放在 `packages/agent/runtime` 源码旁；provider、storage、bridge、
浏览器组合测试各自留在所属包；React 交互测试放在 `apps/agent` 源码旁，`src/__tests__` 只用于
app 级组合契约。

新增设备工具必须覆盖 schema/registry、runtime 执行、安全拒绝、未连接行为及对应设备类型。
全仓规则见 `docs/testing.md`。
