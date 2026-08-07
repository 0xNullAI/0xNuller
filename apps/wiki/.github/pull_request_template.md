<!--
PR 标题用 conventional-commit 风格：type(scope): subject

  type   ::= feat | fix | docs | refactor | chore | ci | style
  scope  ::= 子目录 / 'release' / 'content' 等

DG-Wiki 走单 main 分支模式（区别于 DG-Kit / DG-Agent / DG-Chat / DG-MCP
那种 dev → main 的两层流程）：所有 PR 直接 base=main，CI 跑 lint + build，
合到 main 后由 Cloudflare 自动部署到 https://wiki.0xnullai.com。
-->

## 概述

<!-- 一两句话：改了什么 + 为什么 -->

## 测试计划

- [ ] `npm run lint`
- [ ] `npm run build`
- [ ] 视觉确认（如改了 UI / 样式）

## 关联

<!-- closes #123 -->
