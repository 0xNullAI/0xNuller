<div align="center">

# 0xNuller

**DG-Lab 设备的统一控制平台**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/npm-%40dg--kit%2F*-cb3837)](https://www.npmjs.com/org/dg-kit)
[![Demo](https://img.shields.io/badge/demo-online-success)](https://0xnullai.com)

中文 | [English](./README.en.md)

> 交流 QQ 群：**628954471**

</div>

## 这是什么

0xNuller 将设备控制、AI 对话、实时语音、多人互动、游戏和社区内容整合在一个网页与安卓应用中。

| 模块           | 功能                 |
| -------------- | -------------------- |
| **Control**    | 手动控制设备         |
| **Agent**      | 通过文字与 AI 交互   |
| **Voice**      | 实时语音交互         |
| **Chat**       | 房间、私聊与远程互动 |
| **Playground** | 游戏互动             |
| **Market**     | 浏览和分享场景与波形 |

第一次使用建议从 Control 开始，并先在软件设置中确认设备安全上限。

## 快速开始

```bash
git clone https://github.com/0xNullAI/0xNuller.git
cd 0xNuller
npm install
npm run build:kit
npm run dev -w @0xnullai/web
```

网页版蓝牙连接请使用 Chrome 或 Edge。

## 常用命令

```bash
npm run build:kit
npm run build
npm run typecheck
npm run test
npm run lint
npm run format
```

## 开发入口

- [`apps/web`](./apps/web/README.md) — 统一网页应用与内置文档
- [`apps/agent`](./apps/agent/README.md) — 文字 Agent
- [`apps/chat`](./apps/chat/README.md) — 房间、私聊与远程互动
- [`apps/voice`](./apps/voice/README.md) — 实时语音
- [`apps/playground`](./apps/playground/README.md) — 游戏互动
- [`apps/market`](./apps/market/README.md) — 场景与波形社区
- [`android/app`](./android/app/README.md) — 安卓应用
- [`apps/mcp`](./apps/mcp/README.md) — MCP 服务（迁移与对外发布待确认）
- `packages` — 共享功能包
- [`workers`](./workers/README.md) — 后端服务

维护者文档位于 [`docs`](./docs)。

兼容发布只替换 `0xnullai.com` 主站；旧子域继续运行历史版本。DG-Kit 与 DG-MCP 的迁移及
对外发布在单独确认后进行。

## 致谢

- [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE)
- [openclaw-plugin-dg-lab](https://github.com/FengYing1314/openclaw-plugin-dg-lab)
- [sse-dg-lab](https://github.com/admilkjs/sse-dg-lab)

## 协议

[MIT](./LICENSE)
