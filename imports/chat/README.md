<div align="center">

# DG-Chat

**自带郊狼控制功能的多人实时房间，跑在 Cloudflare 边缘**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/built%20on-%40dg--kit%2F*-0a84ff)](https://github.com/0xNullAI/DG-Kit)
[![Demo](https://img.shields.io/badge/demo-online-success)](https://chat.0xnullai.com)

中文 | [English](./README.en.md)

官网：[0xnullai.com](https://0xnullai.com)

</div>

## 这是什么

DG-Chat 是一个浏览器端的多人实时房间。消息经 Cloudflare 边缘的 WebSocket 中继（Durable Object）转发，低延迟、无第三方 broker；除此之外，**每个成员可以把自己的郊狼设备授权给房间里其他人远程控制**——发"现在让谁谁谁来"，对方点你头像就能调强度、换波形、发短脉冲。

打开网页就能用，部署在 Cloudflare（chat.0xnullai.com），HTTPS 已配好。

## 特性

- **实时聊天** — Cloudflare 边缘 WebSocket 中继，低延迟、无公共 broker
- **房间大厅** — 房主可把房间公开到 [大厅](https://chat.0xnullai.com/lobby)，其他人看到在线人数后自由加入；不公开则保持私密，需房间号
- **聊天历史** — 房间存活期间消息持久保存，新加入者可看到完整历史；所有人离开一段时间后自动清除
- **图片 / 语音** — 发图片（自动压缩）和语音消息，媒体存 Cloudflare R2，随房间清理一并删除
- **二维码邀请** — 房间号 + 二维码，分享给朋友直接加入
- **远程设备控制** — 把强度滑块、波形选择、安全上限的控制权交给队友
- **响应式布局** — 桌面端左右分栏，移动端 Tab 切换
- **波形导入** — 支持 `.pulse` / `.zip` 自定义波形包
- **从 DG-Market 市场导入波形** — 搜索社区市场，一键导入到本地波形库
- **后台保活策略** — 切到后台时是停止输出还是继续，由你设置

## 快速开始

### 在线试玩

打开 [demo](https://chat.0xnullai.com)。需要 **Chrome / Edge**（Web Bluetooth）。

### 本地开发

```bash
git clone https://github.com/0xNullAI/DG-Chat.git
cd DG-Chat
npm install
npm run dev
```

打开 http://localhost:5174/。

## 使用方法

### 创建 / 加入房间

1. 打开页面，输入昵称
2. 点"创建房间"（可勾选"公开到大厅"并填房间名），或输入房间号点"加入"
3. 把房间号或二维码分享给其他人；或在"浏览公开房间大厅"里直接挑一个加入

### 连接郊狼

1. 长按郊狼电源键开机
2. 点页面顶部蓝牙按钮，在系统弹窗里选择设备

> Web Bluetooth 需要 HTTPS 或 localhost + 支持的浏览器（Chrome/Edge）。

### 远程控制

在右侧成员列表点任意成员（包括自己）→ 进入控制界面 → 调强度、换波形、设安全上限。

> 本机端开了某个上限，远端控制不能突破——安全约束在硬件层面。

## 架构

```
worker/             Cloudflare Worker（同源托管前端 + 实时层 + 媒体）
  index.ts          fetch 路由：/ws/room/:code、/ws/lobby、/api/lobby、/api/upload、/api/media，其余回退到静态资源
  room-do.ts        RoomDO：每房间一个实例，WebSocket relay + presence + 聊天历史(SQLite) + 空房宽限清理
  lobby-do.ts       LobbyDO：单例，公开房间注册表 + 实时推送
  media.ts          R2 媒体上传 / 读回 / 按房间前缀清理
  wire.ts           WebSocket wire 协议（纯类型 + 常量）
src/
  components/         UI 组件（含独立大厅页 Lobby.tsx）
  hooks/              业务 Hook（use-device、use-peer-room、use-waveforms）
  lib/
    room-transport.ts 房间 WebSocket 客户端（连 RoomDO，断线自动重连）
    lobby-client.ts   大厅订阅客户端
    media.ts          图片压缩 + 语音录制 + 上传
    bluetooth.ts      DGLabDevice：基于 @dg-kit/protocol + transport-webbluetooth 的薄封装
    protocol.ts       房间消息协议（聊天、设备命令、波形传输）
    commands.ts       房间内命令分发
    waveforms.ts      内置波形 + .pulse 导入（基于 @dg-kit/waveforms）
```

蓝牙 + 波形相关代码完全复用了 [`@dg-kit/*`](https://github.com/0xNullAI/DG-Kit) 的中台实现，DG-Chat 自身负责 React UI、Cloudflare Worker 实时层（RoomDO/LobbyDO）和房间状态。

## 命令

```bash
npm run dev      # 前端 Vite 开发服务（http://localhost:5174/）
npm run cf:dev   # 另开一个终端跑 Worker（wrangler dev，含 DO/R2 本地模拟，:8787）
npm run build    # tsc + Vite 构建
npm run lint
npm run deploy   # 构建并 wrangler deploy
```

## 部署

前端与 Worker 同源，由 **Cloudflare Workers Static Assets** 托管（参照 DG-Market）。首次部署：

```bash
wrangler r2 bucket create dg-chat-media   # 媒体桶
npm run deploy                            # 构建 dist 并部署 Worker + Durable Objects
```

随后在 Cloudflare 控制台把 `chat.0xnullai.com` 自定义域指向该 Worker。

> 成本：SQLite-backed Durable Objects 与 R2 都有免费额度，WebSocket Hibernation 让空闲连接休眠不计费；小流量基本全程免费，上规模后才需 Workers Paid（$5/月起）。

## 相关项目

| 项目 | 用途 |
|---|---|
| [DG-Kit](https://github.com/0xNullAI/DG-Kit) | 共享的 TypeScript 中台（被本项目消费） |
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | 浏览器版 AI 控制器，自然语言驱动 |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP) | MCP 服务器，接入 Claude Desktop |

## 协议

[MIT](./LICENSE)
