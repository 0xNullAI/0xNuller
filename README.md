<div align="center">

# 0xNuller

**DG-Lab 设备的统一控制平台**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit/core](https://img.shields.io/npm/v/%40dg-kit%2Fcore?label=%40dg-kit%2Fcore&color=cb3837)](https://www.npmjs.com/package/@dg-kit/core)
[![dg-mcp](https://img.shields.io/npm/v/dg-mcp?label=dg-mcp&color=cb3837)](https://www.npmjs.com/package/dg-mcp)
[![Demo](https://img.shields.io/badge/demo-online-success)](https://0xnullai.com)

中文 | [English](./README.en.md)

> 交流 QQ 群：**628954471**

</div>

## 这是什么

0xNuller 将设备控制、AI 对话、实时语音、多人互动、游戏和社区内容整合在一个网页与安卓应用中。

| 模块           | 功能                 |
| -------------- | -------------------- |
| **Control**    | 手动控制设备         |
| **Chat**       | 房间、私聊与远程互动 |
| **Agent**      | 通过文字与 AI 交互   |
| **Voice**      | 实时语音交互         |
| **Video**      | 摄像头视觉控制       |
| **Market**     | 浏览和分享场景与波形 |
| **Playground** | 游戏互动             |

第一次使用建议从 Control 开始，并先在软件设置中确认设备安全上限。

## 开发包与 MCP

- **DG-Kit**：用于自行开发设备连接、协议、安全限制、工具和波形功能的 TypeScript 包集合。查看
  [DG-Kit 使用指南](./packages/kit/README.md)与
  [npm 包](https://www.npmjs.com/package/@dg-kit/core)。
- **DG-MCP**：让支持 MCP 的桌面客户端调用 DG-Lab 设备工具。查看
  [DG-MCP 安装与配置](./apps/mcp/README.md)或直接运行 `npx dg-mcp`。

两者使用同一套 Changesets 规则持续发布：改动附带 changeset，`dev` 自动生成版本 PR，
版本 PR 进入 `main` 后在 `npm-production` 环境统一构建、验证并发布。

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
npm test          # 当前分支受影响的测试
npm run test:full # 完整测试，CI/交付前使用
npm run lint
npm run check:structure
npm run format
```

## 开发入口

- [`apps/web`](./apps/web/README.md) — 统一网页应用与内置文档
- [`apps/control`](./apps/control/README.md) — 直接设备控制
- [`apps/agent`](./apps/agent/README.md) — 文字 Agent
- [`apps/chat`](./apps/chat/README.md) — 房间、私聊与远程互动
- [`apps/voice`](./apps/voice/README.md) — 实时语音
- [`apps/playground`](./apps/playground/README.md) — 游戏互动
- [`apps/market`](./apps/market/README.md) — 场景与波形社区
- [`android/app`](./android/app/README.md) — 安卓应用
- [`apps/mcp`](./apps/mcp/README.md) — MCP 服务，作为 [`dg-mcp`](https://www.npmjs.com/package/dg-mcp) 发布
- [`packages/kit`](./packages/kit/README.md) — DG-Kit 公共包与独立使用指南
- [`workers`](./workers/README.md) — Cloudflare 后端服务

维护者文档从 [`docs/README.md`](./docs/README.md) 进入。
产品分支职责与唯一 Release 流程见 [`docs/platform-release.md`](./docs/platform-release.md)。
仓库分层、代码归属和测试规范见 [`AGENTS.md`](./AGENTS.md)、
[`docs/architecture.md`](./docs/architecture.md) 与 [`docs/testing.md`](./docs/testing.md)。

当前产品统一运行在 `0xnullai.com`；旧子域只保留到对应模块的永久跳转。DG-Kit 与 DG-MCP 已迁入本仓库，
并分别通过 [`@dg-kit/*`](https://www.npmjs.com/package/@dg-kit/core) 与
[`dg-mcp`](https://www.npmjs.com/package/dg-mcp) 在 npm 发布。

## 致谢

- [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE)
- [openclaw-plugin-dg-lab](https://github.com/FengYing1314/openclaw-plugin-dg-lab)
- [sse-dg-lab](https://github.com/admilkjs/sse-dg-lab)

## 协议

[MIT](./LICENSE)
