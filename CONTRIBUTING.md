# 贡献指南

先谢谢你愿意花时间。这个项目控制的是会向人体输出电流的真实设备，所以下面关于**安全链**的部分不是形式主义，请先读完再动手。

## 开始之前

```bash
npm install
npm run build:kit    # 共享层是 dist-first，不先构建它，其余包的类型解析会失败
```

跑一遍确认环境没问题：

```bash
npm run build && npm run test && npm run lint
```

预期：全仓构建通过、621 个测试全过、lint 零错误。lint 目前有 7 个
`react-hooks/exhaustive-deps` 警告，那是合并前 DG-Chat 的 lint 被 `|| true`
关掉留下的既有基线——**不要新增，但也不必在无关的 PR 里顺手清理**。

> Node 26 内置的 `localStorage` 会遮蔽 jsdom 的实现。仓库里的
> `test/setup/localstorage.ts` 已经处理了这件事，不需要给 node 加
> `--localstorage-file`。

## 安全链：改这些代码前请先开 issue

以下位置直接决定设备输出的强度、时长和谁能下指令。改动它们需要先讨论，PR 里
必须说明「失效场景是什么」而不只是「改了什么」：

- `packages/agent/runtime/src/default-policies.ts` — 强度上限、冷启动钳制、单回合调用次数
- `packages/agent/runtime/src/device-command-queue.ts` — 串行命令队列与急停插队
- `packages/agent/permissions-browser/` — 限时权限授予
- `apps/chat/src/App.tsx` 的 `handleCommand` — 房间内他人指令的落地钳制
- `android/*/src/lifecycle-safety.ts` — 切后台 / 被杀时的自动停止

三条不可妥协的约束：

1. **停止永远是一个动作可达。** 任何 UI 变更都不能让急停变得更难触达。
2. **上限在设备持有者一侧执行。** 不要信任来自房间、AI 或游戏逻辑的强度值。
3. **不要让安全逻辑出现第二份副本。** 需要在别处用，就把它提到共享包，而不是复制。

## 提交规范

Conventional commits：

```
type(scope): 一句话祈使句

可选正文，解释 WHY 而不是 WHAT，72 字换行。
```

`type` ∈ `feat | fix | refactor | docs | chore | test | perf | style`
`scope` 用模块或包名：`runtime`、`chat`、`voice`、`market`、`kit`、`android`、`workspace`。

提交身份统一为 `0xNull <271426072+0xNullAI@users.noreply.github.com>`。仓库根的
`.gitconfig` 目录条件包含会自动生效，**不要在仓库里单独设置 `user.*`**。

## PR

全部 PR 提到 `dev`，不要直接提 `main`。

```markdown
## 做了什么

1-2 句：改了什么、为什么。

## 测试

- [ ] npm run build
- [ ] npm run test
- [ ] npm run lint
- [ ] 真机验证（涉及设备行为时必填，写清楚用什么设备、什么波形、什么强度）
```

涉及设备行为的改动，**单元测试不能替代真机验证**。

## 改 `@dg-kit/*` 要写 changeset

`packages/kit/*` 会发布到 npm，被 MCP 服务端和外部项目消费。任何用户可见的改动
都要加一份发布说明：

```bash
npm run changeset
```

破坏公共 API 是 major bump，请先在 issue 里讨论。优先做增量式改动。

## 代码约定

- TypeScript `strict: true` + `noUncheckedIndexedAccess: true`
- 仅 ESM；类型导入用 `import type`
- 未使用变量前缀 `_`
- 注释解释 WHY，不解释 WHAT
- 代码与注释里不用 emoji（除非明确要求）
- UI 文案为简体中文

## 目录放哪

| 要加的东西                 | 放哪                               |
| -------------------------- | ---------------------------------- |
| 设备协议 / 波形 / 工具定义 | `packages/kit/*`（会发 npm，慎重） |
| 跨模块复用的平台逻辑       | `packages/agent/*`                 |
| 某个模块专属的 UI 或逻辑   | `apps/<模块>/src`                  |
| 安卓壳专属行为             | `android/<模块>/src`               |
| 新的 Worker 中继           | `workers/`                         |

拿不准就先开 issue 问，比事后搬家便宜。
