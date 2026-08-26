<!--
PR 标题用 conventional-commit 风格：type(scope): subject

  type   ::= feat | fix | docs | refactor | perf | test | chore | ci | style
  scope  ::= 包名 / 子目录 / 'release' 等
  subject::= 祈使句、简体中文或英文均可、不带句号

📍 分支约定（重要！）：

  ┌────────────────────────────────────────────────────────────┐
  │ main = 当前线上 / 已发布版本（默认查看分支）               │
  │ dev  = 不受保护的开发集成分支，可直推；评审 PR base 到这里 │
  │                                                            │
  │ 发布流程：dev 上统一升级产品版本 → dev 直接 PR 到 main →   │
  │           release-guard 校验 → merge commit → main 发布     │
  └────────────────────────────────────────────────────────────┘

⚠️ 需要评审的日常 PR 以 dev 为 base。只有维护者晋升 Product、DG-Kit 或 DG-MCP 版本时使用
`dev → main`，并必须使用 merge commit，让 main 真实包含已验证的 dev 历史；不要
squash/rebase，也不做反向 cherry-pick。

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
- 是否需要 changeset / changelog？（`packages/kit/*` 或 `apps/mcp` 的公共行为、API、依赖变化必加）
- 是否影响下游消费者？列举一下
-->

## 关联

<!-- closes #123, refs #456, depends on #789 -->
