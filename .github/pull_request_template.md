<!--
PR 标题请用 conventional-commit 风格：type(scope): subject

  type   ::= feat | fix | docs | refactor | perf | test | chore | ci | style
  scope  ::= 包名 / 子目录 / 'release' 等
  subject::= 祈使句、简体中文或英文均可、不带句号

例：feat(protocol): add setLimits() to update strength caps
    fix(web): bluetooth chooser auto-trigger regression
    docs(agent): clarify cold-start strength cap
-->

## 概述

<!-- 一两句话：改了什么 + 为什么。WHY 比 WHAT 重要。 -->

## 测试计划

- [ ] `npm run lint`
- [ ] `npm run typecheck`（如适用）
- [ ] `npm run test`（如适用）
- [ ] `npm run build`
- [ ] 真机 / 浏览器烟测（如涉及设备 / UI）

## 影响范围

<!--
- 是否破坏 API？是 → 加 `breaking-change` 标签，PR 标题改 `feat!` 或 `fix!`
- 是否需要 changeset / changelog？(DG-Kit 必加；其它项目按需)
- 是否影响下游消费者？列举一下
-->

## 关联

<!-- closes #123, refs #456, depends on #789 -->
