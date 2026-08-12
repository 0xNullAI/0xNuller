<!--
PR 标题用 conventional-commit 风格：type(scope): subject

  type   ::= feat | fix | docs | refactor | perf | test | chore | ci | style
  scope  ::= 包名 / 子目录 / 'release' 等
  subject::= 祈使句、简体中文或英文均可、不带句号

📍 分支约定（重要！）：

  ┌────────────────────────────────────────────────────────────┐
  │ main = 当前线上 / 已发布版本（默认查看分支）               │
  │ dev  = 开发分支，所有日常 PR 都 base 到这里                │
  │                                                            │
  │ 发布流程：dev 上统一升级产品版本 → dev 直接 PR 到 main →   │
  │           release-guard 校验 → merge commit → publish      │
  └────────────────────────────────────────────────────────────┘

⚠️ 日常 PR 的 base 必须是 dev。只有产品发布使用 dev → main，且必须保留 merge commit；
不要 squash/rebase，也不再发布后反向 cherry-pick。

例：feat(protocol): add setLimits() to update strength caps
    fix(web): bluetooth chooser auto-trigger regression
    docs(agent): clarify cold-start strength cap
-->

## 概述

<!-- 一两句话：改了什么 + 为什么。WHY 比 WHAT 重要。 -->

## 测试计划

- [ ] `npm run check:structure`
- [ ] `npm run lint`
- [ ] `npm run typecheck`（如适用）
- [ ] `npm run test:full`（交付前）
- [ ] `npm run build`
- [ ] 真机 / 浏览器烟测（如涉及设备 / UI）

## 影响范围

<!--
- 是否破坏 API？是 → 加 `breaking-change` 标签，PR 标题改 `feat!` 或 `fix!`
- 是否需要 changeset / changelog？（改动 packages/kit/* 或 apps/mcp 必加）
- 是否影响下游消费者？列举一下
-->

## 关联

<!-- closes #123, refs #456, depends on #789 -->
