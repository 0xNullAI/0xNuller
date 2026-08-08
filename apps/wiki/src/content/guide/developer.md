# 开发者文档

## 仓库结构

```
packages/kit/*        @dg-kit/*，发布到 npm。dist-first：main/types 指向 dist/
                      safety/ 是设备安全链的唯一真身
packages/platform/*   @0xnullai/*，跨模块共用、不发布
                      ui · settings · scenes · auth · native · llm-providers
                      market-client · permissions
packages/agent/*      @dg-agent/*，Agent 模块专属
apps/*                web（统一外壳）· agent chat voice market · landing wiki mcp
android/app           单一 Tauri 壳
workers/*             auth · llm-proxy（免费 provider）· speech-proxy
```

加新东西之前先想清楚它属于哪一层：发布给外部（kit）、四个模块都要用（platform）、
还是只有 Agent 用（agent）。放错层的代价是它迟早会被复制第二份。

## 命令

```bash
npm run build:kit    # 共享层是 dist-first，是其余一切的前置
npm run build        # 全仓
npm run test         # vitest 跑完全仓
npm run lint         # 零错误策略
npm run android:build
```

改完提交前跑：`npm run lint && npm run build && npm run test`。

## 统一外壳

`apps/web` 是唯一入口。两列布局：侧边栏（应用切换 / 置顶 / 对话 / 房间 / 账户）+
内容区（设备栏 / 模块按钮 / 模块内容）。

三个必须知道的契约：

1. **Tailwind 的扫描根取自 Vite 的 `config.root`。** 外壳的 root 是 `apps/web`，
   模块源码树不在其下，所以 `shell.css` 里为每个模块显式 `@source`。**加新模块必须
   同步加一行**，漏掉的表现是该模块的工具类被静默 tree-shake，而构建完全不报错。
2. **级联层名必须与 Tailwind v4 内部一致**（theme / base / components / utilities）。
   自造名字会让 Tailwind 的真实层排到后面，preflight 反压过共享 base，且构建、测试、
   lint、截图全绿——只有读注入元素的计算样式才看得出来。
3. **弹窗必须 portal 到外壳的覆盖层容器。** 留在模块子树里，祖先有没有 transform
   决定它是「盖住外壳」还是「关不住模态」。见 `@0xnullai/ui` 的 `overlay.tsx`。

模块**一旦打开就保持挂载**，切走只是隐藏——BLE 连接与模块状态都活着。

## 模块与外壳的四个接口

| 接口 | 作用 |
|---|---|
| `useSafetySession` | 注册设备会话。**这是全局停止按钮唯一的数据来源**，也是设备栏的数据来源。 |
| `SidebarSection` | 把列表项投进侧边栏的置顶 / 对话 / 房间分区。 |
| `ModuleActions` | 把顶部按钮投进外壳的按钮插槽。 |
| `useNativeBridge` | 取安卓的蓝牙注入。网页端返回空对象。 |

## 安全链——改之前先想清楚失效场景

- `packages/kit/safety/src/default-policies.ts` — 强度上限、冷启动钳制、单回合调用上限
- `packages/kit/safety/src/policy-engine.ts` — 策略求值
- `packages/kit/safety/src/device-command-queue.ts` — 串行队列与急停插队
- `packages/kit/safety/src/safety-bus.ts` — 全局停止与设备清单
- `packages/platform/settings/src/device-safety.ts` — 全应用共享的安全设置真源
- `packages/platform/permissions/` — 限时权限授予
- `android/app/src/lifecycle-safety.ts` — 切后台/被杀时自动停止

三条硬约束：

1. **停止永远一个动作可达**，任何 UI 改动都不能削弱它
2. **上限在设备持有者一侧执行**，不信任来自房间、AI 或游戏逻辑的数值
3. **安全逻辑不得出现第二份可独立演化的副本**——要复用就上提到共享包

## 已知的坑

- **Kit 是 dist-first。** `main`/`types` 指向 `dist/`，不要改回 `src`。任何
  typecheck/test 之前必须先 `build:kit`。
- **Node 26 的内置 `localStorage` 会遮蔽 jsdom 的。** `test/setup/jsdom-gaps.ts` 已处理。
- **`run_worker_first: true` 会让静态资源变成计费的 Worker 调用。** 免费额度耗尽时
  Cloudflare 返回 429 而不是回退到资源服务——整站挂掉。只对 `/api/*` 与 `/ws/*` 开。
- **DO migration tag 按 Worker script 计。** 不要把已有的 DO 类挪进别的 Worker。
- **安卓端没有热更新**，前端修复都要重新打 APK，老版本会长期存在于用户手机上。
- **React 必须全仓只有一份实例。** 曾经 Market 声明 react@18 而其余是 19，npm 无法
  提升，它的 chunk 拿到第二个实例、`useState` 读到 null dispatcher 直接崩。
  各 vite 配置都加了 `resolve.dedupe`。
- **通用类名会跨模块污染。** Market 的样式表用 `.app` / `.grid` / `.btn`，归 module
  层而 module 排在 utilities 之后——它的 `.grid` 曾经压过 Tailwind 的 `grid-cols-*`，
  把 Agent 的主布局改成四列。现在整份包在 `.mkt-scope` 之下。

## 代码约定

TypeScript `strict` + `noUncheckedIndexedAccess`；仅 ESM；`import type`；未使用变量
前缀 `_`；注释解释 WHY 不解释 WHAT；不用 emoji；UI 文案简体中文。
