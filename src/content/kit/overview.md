# DG-Kit · 项目概述

DG-Lab 郊狼 2.0 / 3.0 的共享 TypeScript 中台。npm 上发布为 `@dg-kit/*`，被 [DG-Agent](https://github.com/0xNullAI/DG-Agent) / [DG-Chat](https://github.com/0xNullAI/DG-Chat) / [DG-MCP](https://github.com/0xNullAI/DG-MCP) 共同消费。

> [GitHub](https://github.com/0xNullAI/DG-Kit) · [npm @dg-kit/core](https://www.npmjs.com/package/@dg-kit/core)

## 五个包

| 包 | 用途 |
|---|---|
| `@dg-kit/core` | 基础类型与抽象接口：`DeviceState`、`DeviceCommand`、`WaveformDefinition`、`DeviceClient` 等 |
| `@dg-kit/protocol` | 郊狼 V2 / V3 蓝牙协议适配器（与传输层解耦） |
| `@dg-kit/waveforms` | 内置波形、`ramp / hold / pulse / silence` 段落编译器、`.pulse` 文件解析器 |
| `@dg-kit/tools` | LLM 工具定义（`start` / `stop` / `adjust_strength` / `change_wave` / `burst` / `design_wave`），可注入限速策略 |
| `@dg-kit/transport-webbluetooth` | 浏览器端 `DeviceClient` 实现，基于 Web Bluetooth |

五个包通过 changesets 的 `fixed` 设置同步版本号——任何一个 bump，五个一起出新版。

## 安装

```bash
npm install @dg-kit/core @dg-kit/protocol @dg-kit/waveforms
```

按需取用。三个下游分别用了不同子集。

## 设计哲学

**一份代码，三个产品**。蓝牙协议、波形数据、工具定义这些会反复用到的核心，永远只写一次发到 npm 上让所有消费者拿去——这是 DG-Kit 存在的全部理由。

**传输无关**。`@dg-kit/protocol` 操作的是抽象的 `BluetoothRemoteGATTCharacteristicLike` 接口，所以浏览器（Web Bluetooth）和 Node（noble）都能复用。

**消费者注入**。需要"回合"概念的 DG-Agent 注入回合限速；不需要的 DG-MCP 注入时间窗口限速。中台不耦合"回合"概念。

**安全在协议层**。强度上限、冷启动钳制、紧急停止、回合限速都嵌在中台代码里——下游 UI / LLM / MCP 客户端绕不过。

## 架构一图流

```
              @dg-kit/core
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
@dg-kit/protocol  waveforms  tools
       │
       ▼
@dg-kit/transport-webbluetooth   ⟷   @dg-mcp/device-noble (DG-MCP 内部)
       │                                 │
   浏览器 Web BT                      Node.js noble
```

## 怎么用？

如果你的目标是：

- **写一个新的浏览器 UI** 控制郊狼 → 看 [开发者文档](#/kit/developer) 的「在浏览器项目中用」一节
- **写一个 Node CLI 或后端** 控制郊狼 → 看「在 Node 项目中用」一节
- **给 DG-Kit 加协议层新方法** → 看「贡献 / 发布流程」
- **看完整 API 列表** → [API 参考](#/kit/api)

## 状态

`1.0.0` 正式版，已在 npm 上稳定运行。三个下游消费者（DG-Agent / DG-Chat / DG-MCP）都跑在同一份 `@dg-kit/*@^1.0.0` 上，无破坏性变更将以 minor / patch 释放。

## 协议

[MIT](https://github.com/0xNullAI/DG-Kit/blob/main/LICENSE)
