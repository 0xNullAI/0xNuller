<div align="center">

# 0xNullAI

**DG-Lab 郊狼设备的统一 AI 控制平台**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/npm-%40dg--kit%2F*-cb3837)](https://www.npmjs.com/org/dg-kit)
[![Demo](https://img.shields.io/badge/demo-online-success)](https://0xnullai.com)

中文 | [English](./README.en.md)

> 交流 QQ 群：**628954471**

</div>

## 这是什么

0xNullAI 把原先分散在九个仓库里的产品收拢成一个平台：四个功能模块共用一套设备协议、一套安全链、一套设计系统和一个账号体系，并打包成单一的安卓应用。

| 模块       | 做什么                                                        |
| ---------- | ------------------------------------------------------------- |
| **Agent**  | 用自然语言跟 AI 对话，AI 通过工具调用真实控制设备             |
| **Chat**   | 多人房间，把自己设备的控制权交给房间里的伙伴                  |
| **Voice**  | 像打电话一样跟 AI 保持连线，AI 自己决定何时开口、何时调用工具 |
| **Market** | 社区波形与场景市场，一键带进其余三个模块                      |

共享层 [`@dg-kit/*`](https://www.npmjs.com/org/dg-kit) 继续发布到 npm，供 MCP 服务端与外部项目消费。

## 快速开始

```bash
git clone https://github.com/0xNullAI/0xNuller.git
cd 0xNuller
npm install
npm run build:kit        # 共享层是 dist-first，其余包依赖它的构建产物
npm run dev -w dg-chat   # 或 -w @dg-agent/web / dg-voice / dg-market
```

Web Bluetooth 需要 **Chrome 或 Edge**。

## 仓库结构

```
packages/
  kit/                     @dg-kit/*，发布到 npm
    core protocol waveforms tools transport-webbluetooth transport-tauri-blec
    safety/                ★ 设备安全链唯一真身：策略引擎 · 默认上限 · 串行命令队列
  platform/                @0xnullai/*，跨模块共用（不发布）
    ui/                    设计系统单一真源：令牌 · 主题 · 12 个 Radix 原子组件
    llm-providers/         LLM 供应商注册表与免费体验代理常量
    market-client/         DG-Market 客户端
    permissions/           浏览器侧限时权限授予
  agent/                   @dg-agent/*，Agent 模块专属
    runtime/ agent-browser/ bridge/ client/ providers-* storage-browser/ audio-browser/
apps/
  agent/ chat/ voice/ market/     四个功能模块
  landing/                 落地页（Astro）
  wiki/                    文档站（只读，贡献走 PR）
  mcp/                     MCP 服务端，发布为 npm 包 dg-mcp
android/
  agent/ chat/ voice/      三个 Tauri 壳，将合并为单一「0xNullAI」应用
workers/
  llm-proxy/               免费 provider 中继（llm.0xnullai.com）
  speech-proxy/            DashScope 语音中继
docs/legacy/               各仓合并前的 CLAUDE.md 与 README 存档
```

`packages/*/*` 的两层结构一是为了让 `@dg-kit/core` 与 `@dg-agent/core` 这类同名包共存，二是让「发布到 npm」「跨模块共用」「模块专属」三种性质在目录上一眼可辨。

## 命令

```bash
npm run build:kit    # 只构建共享层（其余构建的前置）
npm run build        # 全仓构建
npm run typecheck    # 全仓类型检查
npm run test         # vitest，单进程跑完全仓
npm run lint         # eslint，零错误策略
npm run format       # prettier --write
npm run changeset    # 为 @dg-kit/* 的改动写发布说明
```

单个 workspace 用 `-w`：`npm run test -w dg-voice`。

## 分支约定

- `dev` — 日常开发，PR 全部走这里
- `main` — 仅用于发版

## 迁移状态

本仓库正在接管以下仓库，迁移完成前它们保持在线：

DG-Kit · DG-Agent · DG-Chat · DG-Voice · DG-Market · DG-Web · DG-Wiki · DG-MCP

代码已通过 `git subtree` 并入，提交历史与 blame 完整保留。Cloudflare 部署与 npm
发布仍指向旧仓，切换后旧仓才会下线。

保持独立的只有 [tauri-plugin-blec-multi](https://github.com/0xNullAI/tauri-plugin-blec-multi)——它是上游项目的 Rust fork，工具链与本仓无交集。

## 致谢

- [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE) — 官方开源 BLE 协议
- [openclaw-plugin-dg-lab](https://github.com/FengYing1314/openclaw-plugin-dg-lab) — 波形解析器参考实现
- [sse-dg-lab](https://github.com/admilkjs/sse-dg-lab) — Dungeonlab+pulse 波形解析引擎
- [MapleLeaf API](https://aihub.071129.xyz) — 为「免费体验」模式提供模型调用

## 免责声明

> **本项目仅供学习交流使用，不得用于任何违法或不当用途。使用者应自行承担使用本项目所产生的一切风险和责任，项目作者不对因使用本项目而导致的任何直接或间接损害承担责任。**

## 协议

[MIT](./LICENSE)
