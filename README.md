<div align="center">

# DG-Wiki

**DG-Lab 郊狼系列项目的统一文档站**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![Deploy](https://github.com/0xNullAI/DG-Wiki/actions/workflows/deploy.yml/badge.svg)](https://github.com/0xNullAI/DG-Wiki/actions/workflows/deploy.yml)
[![@dg-kit](https://img.shields.io/badge/built%20on-%40dg--kit%2F*-58c8f2)](https://github.com/0xNullAI/DG-Kit)

中文 | [English](./README.en.md)

</div>

## 这是什么

DG-Wiki 是 [DG-Kit](https://github.com/0xNullAI/DG-Kit) / [DG-Agent](https://github.com/0xNullAI/DG-Agent) / [DG-Chat](https://github.com/0xNullAI/DG-Chat) / [DG-MCP](https://github.com/0xNullAI/DG-MCP) 四个项目的中央文档站，包含每个项目的介绍、使用手册、安装步骤、常见问题和故障排查。

支持**浏览器内编辑**——按右上角 ✎ 进入分屏 Markdown 编辑器，本地修改自动保存到 localStorage，可一键跳到 GitHub 提 PR 把改动贡献回来。

## 在线访问

https://0xnullai.github.io/DG-Wiki/

## 本地开发

```bash
npm install
npm run dev          # http://localhost:5173/DG-Wiki/
```

## 构建

```bash
npm run build
npm run preview
```

构建产物在 `dist/`。GitHub Actions 在 push 到 `main` 时自动部署。

## 编辑内容

每页内容在 `src/content/<id>.md`。通过 Vite `?raw` 导入；页面元数据（标签、强调色、GitHub 编辑链接）在 `src/lib/pages.ts` 维护。

新增页面：

1. 写 `src/content/<id>.md`
2. 在 `pages.ts` 的 `PAGES` 数组里加一条
3. 重启 dev server

## 视觉风格

色板与 DG-Agent / DG-Chat 一致：

- 浅色：白底 + 天蓝 `#58c8f2 / #3ab5e6`
- 深色：近黑 + 暖琥珀 `#ffe99d / #ffb800`

字体：Big Shoulders Display（显示）/ PingFang SC + 系统中文栈（正文）/ JetBrains Mono（代码）。

## 相关项目

| 项目 | 用途 |
|---|---|
| [DG-Kit](https://github.com/0xNullAI/DG-Kit) | 共享的 TypeScript 中台 |
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | 浏览器版 AI 控制器 |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | 多人 P2P 房间 |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP) | MCP 服务器，接 Claude Desktop |

## 协议

[MIT](./LICENSE)
