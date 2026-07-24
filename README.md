<div align="center">

# DG-Voice

**打电话式的实时语音 AI，控制 DG-Lab 设备**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/built%20on-%40dg--kit%2F*-0a84ff)](https://github.com/0xNullAI/DG-Kit)

中文 | [English](./README.en.md)

</div>

## 这是什么

DG-Voice 打开就像打电话一样跟 AI 保持连线——不用按住说话，不用打字。模型跑在实时语音服务商那边
（xAI Grok / OpenAI Realtime / Azure OpenAI Realtime / 智谱 GLM-Realtime），自己决定什么时候开
口、什么时候调用设备工具；DG-Voice 负责接通音频、在每次工具调用前后守住安全链，其余不插手。

跟 [DG-Agent](https://github.com/0xNullAI/DG-Agent)（文字聊天）是姊妹项目，共享同一份
[`@dg-kit/*`](https://github.com/0xNullAI/DG-Kit) 协议层和同一套设计语言，但 Agent 循环完全不
同——这里没有"轮次"的概念，模型自己管调度。

## ⚠️ 当前状态：v0.1.0，语音尚未接通

**已经能跑、有测试覆盖的部分**：

- 四种设备（郊狼 / 负鼠 / 爪印 / 灵猫）统一连接入口，一个按钮全覆盖
- 完整安全链：策略引擎（强度上限、冷启动钳制、burst 上限）、权限确认、串行命令队列、紧急停止
- 与 DG-Agent 一致的视觉设计（配色、圆角、深浅主题）

**还没有的部分**：实时语音连接本身（`RealtimeSession`/工具桥）、设置面板、安卓壳、部署。首页
那个"实时语音通话"区块目前是占位符。如果你是来找一个能用的语音助手，现在还不是时候。

## 特性（目标形态）

- **多 Provider** — xAI / OpenAI / Azure 一套客户端零改动通用；智谱 GLM 免服务端中转，浏览器
  本地签 JWT 直连
- **完整工具集** — 与 DG-Agent 一致的 13 个设备工具，全部由模型自主决定何时调用
- **安全保障** — 强度上限、冷启动钳制、burst 上限、通话前一次性授权、紧急停止随时可按
- **完全本地** — 无服务端中转、无数据库；设置存 localStorage，API Key 自带
- **不重复造轮子** — 设备层来自 `@dg-kit/*` 1.13.0，是三个下游项目共用的同一份实现

## 本地开发

```bash
git clone https://github.com/0xNullAI/DG-Voice.git
cd DG-Voice
npm install
npm run dev
```

打开 http://localhost:5173/。Web Bluetooth 需要 **Chrome 或 Edge**。

## 架构

```
src/
  lib/            纯 TS：设备层、安全链、实时语音客户端（无 React 依赖）
  hooks/          React 绑定
  components/     UI（ui/ 是从 DG-Agent 逐字拷贝的 shadcn 组件）
  styles/         设计 token，与 DG-Agent/DG-Chat 共享同一套
worker/           Cloudflare Worker，纯静态资源托管
```

设备层、安全链的具体分工细节见 [CLAUDE.md](./CLAUDE.md)。

## 安全

- 强度量程 0-200，冷启动自动钳制到低强度
- 通话前需要一次性授权，通话中不再逐次弹窗打断体验，但硬上限和策略引擎始终生效、模型无法绕过
- 常驻「挂断并停止」按钮，随时紧急归零

## Sister Projects

| 项目 | 用途 |
|---|---|
| [DG-Kit](https://github.com/0xNullAI/DG-Kit) | 共享 TypeScript 中台（本项目消费） |
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | 浏览器版 AI 控制器（文字聊天） |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | 多人 P2P 房间 + 远程控制 |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP) | MCP 服务端，供 Claude Desktop 等使用 |

## 协议

[MIT](./LICENSE)
