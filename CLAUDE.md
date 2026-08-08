# CLAUDE.md

Claude Code 在 **0xNullAI** 平台仓库工作时的指引。

## 这是什么

由九个独立仓库合并而成的 monorepo：`@dg-kit/*` 共享层、Agent/Chat/Voice/Market 四个功能模块、落地页、文档站、MCP 服务端、三个待合并的安卓壳。控制对象是 DG-Lab 郊狼——**会向人体输出电流的真实设备**。

各仓合并前的 `CLAUDE.md` 完整保留在 `docs/legacy/`，里面有大量硬换来的知识（智谱 GLM 的五处服务端分歧、DG-Agent 的 UI 维护约定、DG-Voice 的 realtime provider 差异等）。改动某个模块前先读对应那份。

## 结构

```
packages/kit/*        @dg-kit/*，发布到 npm。dist-first：main/types 指向 dist/
                      safety/ 是设备安全链的唯一真身（含租约与设备清单）
packages/platform/*   @0xnullai/*，跨模块共用、不发布
                      ui · settings · scenes · auth · native
                      llm-providers · market-client · permissions
packages/agent/*      @dg-agent/*，Agent 模块专属
apps/web              统一外壳。唯一的入口
apps/*                agent chat voice market（模块）· landing wiki mcp
android/app           单一 Tauri 壳，四个模块一个 APK
workers/*             auth · llm-proxy（免费 provider，产品承诺的一部分）· speech-proxy
```

加新东西之前先想清楚它属于哪一层：发布给外部（kit）、四个模块都要用（platform）、
还是只有 Agent 用（agent）。放错层的代价是它迟早会被复制第二份。

目录多套一层还有个附带好处：`@dg-kit/core` 与 `@dg-agent/core` 同名也能共存。

## 命令

```bash
npm run build:kit    # 共享层是 dist-first，是其余一切的前置
npm run build        # 全仓
npm run test         # vitest 单进程跑完全仓（621 个测试）
npm run lint         # 零错误策略
npm run format
npm run changeset    # 改了 packages/kit/* 就要写
```

改完提交前跑：`npm run lint && npm run build && npm run test`。

## 安全链——改之前先想清楚失效场景

这些位置决定强度、时长和谁能下指令：

- `packages/kit/safety/src/default-policies.ts` — 强度上限、冷启动钳制、单回合调用上限
- `packages/kit/safety/src/policy-engine.ts` — 策略求值
- `packages/kit/safety/src/device-command-queue.ts` — 串行队列与急停插队
- `packages/platform/permissions/` — 限时权限授予
- `apps/chat/src/App.tsx` 的 `handleCommand` — 房间内他人指令的落地钳制
- `android/*/src/lifecycle-safety.ts` — 切后台/被杀时自动停止

三条硬约束：

1. **停止永远一个动作可达**，任何 UI 改动都不能削弱它
2. **上限在设备持有者一侧执行**，不信任来自房间、AI 或游戏逻辑的数值
3. **安全逻辑不得出现第二份可独立演化的副本**——要复用就上提到共享包

DG-Voice 曾整份复制 DG-Agent 的安全链。现在它只有一份，在 `@dg-kit/safety`。不要再制造第二份——需要在别处用就依赖这个包。

## 一个软件

软件名 **0xNuller**，四个模块：Agent / Chat / Voice / Market。说明与设置是弹窗，
不占模块槽位。界面文案里不出现 DG 前缀（「郊狼」是 DG-Lab 的设备型号，那个不能改）。

**独立部署形态已经不再保留。** 模块只在统一外壳里跑。

## 统一外壳

`apps/web` 是统一入口，四个模块 + 文档站按路由挂载在同一个文档里。各模块**同时**
仍然可以独立构建部署，两种形态共用同一份代码。

第一次尝试失败过（Market 白屏、Chat 弹窗逃出外壳、Agent 布局塌陷），当时判断是
「四套 CSS 体系不可能共存」。**那个判断是错的。** 真正的根因是三件具体的事，都已修复：

1. **Tailwind 的扫描根取自 Vite 的 `config.root`。** 外壳的 root 是 `apps/web`，
   模块源码树不在其下，候选类从 2199 掉到 409，高度锁与断点整片消失——而构建不报错。
   修法是 `shell.css` 里逐个 `@source`，**加新模块必须同时加一行**。
2. **级联层名必须与 Tailwind v4 内部一致**（theme/base/components/utilities）。
   自造名字会让 Tailwind 的真实层排到后面，preflight 反压过共享 base，且构建、
   测试、lint、截图全绿——只有读注入元素的计算样式才看得出来。
3. **弹窗必须 portal 到外壳的覆盖层容器。** 留在模块子树里，祖先有没有 transform
   决定它是「盖住外壳」还是「关不住模态」。见 `@0xnullai/ui` 的 `overlay.tsx`；
   `useModuleOverlayLayer` 还负责让被切走模块的弹窗跟着隐藏。

外壳级的状态只有一份，模块不要再各写各的：

| 东西 | 真源 |
|---|---|
| 主题 | `@0xnullai/ui` 的 `theme-store`（唯一写 `data-theme` 的地方） |
| 设备安全设置 | `@0xnullai/settings` 的 `device-safety` |
| 场景（人设） | `@0xnullai/scenes` |
| LLM 配置 | `@0xnullai/llm-providers` 的 `config-store` |
| 代理 | `@0xnullai/settings` 的 `proxy` |
| 急停 / 设备清单 / 控制权租约 | `@dg-kit/safety` 的 `safety-bus` |

模块与外壳之间只有四个接口：`useSafetySession`（注册设备会话——**这是全局停止按钮和
设备栏唯一的数据来源**）、`SidebarSection`（投列表项到侧边栏）、`ModuleActions`
（投按钮到外壳按钮插槽）、`useNativeBridge`（取安卓的蓝牙注入）。

**设备控制权是可撤销的租约**，跟着当前模块走。切走的模块必须停输出、清掉「按住不放」
的聚合状态、硬拒绝后续指令（远程指令不经过 UI，只禁用按钮没用）。**撤权绝不能实现成
disconnect()** —— Agent 与 Voice 开了 autoReconnect，断连会让后台模块静默重连抢回设备。

**安卓**：`android/app` 是唯一的 Tauri 壳，四个模块一个 APK。原生蓝牙注入走
`@0xnullai/native` 的 `NativeBridge`——**三条缝的形状原样保留**（Agent 用
servicesOverrides + connectDevice，Chat 用 deviceClientFactory + requestDevice，
Voice 用 transport），只是注入点合并成一个。不去重塑它们是刻意的：安卓没有热更新，
改错会让三个模块同时哑掉，而坏掉的版本会长期留在用户手机上。

各模块内部别名是 `@agent` / `@voice` / `@chat`（不是 `@`），保留这个命名以免将来再
撞车。`apps/web` 与 `android/app` 两个 vite 配置里的 alias 必须保持一致。

## 已知的坑

- **Kit 是 dist-first。** `main`/`types` 指向 `dist/`，不要改回 `src`——那个模式当年弄坏过 0.1.0 的发布。所以任何 typecheck/test 之前必须先 `build:kit`。
- **Node 26 的内置 `localStorage` 会遮蔽 jsdom 的。** `test/setup/jsdom-gaps.ts` 已处理，不要加 `--localstorage-file`（实验性标志，且文件持久化会让测试互相串状态）。
- **`run_worker_first: true` 会让静态资源变成计费的 Worker 调用。** 免费额度耗尽时 Cloudflare 返回 429 而不是回退到资源服务——整站挂掉。只对 `/api/*` 与 `/ws/*` 开。
- **DO migration tag 按 Worker script 计。** 不要把已有的 DO 类挪进别的 Worker。
- **安卓端没有热更新**，前端修复都要重新打 APK，老版本会长期存在于用户手机上。
- **`@mnlphlp/plugin-blec` 是 git 依赖**，指向 0xNullAI 的 fork。上游 force-push 会让它漂移。
- **React 必须全仓只有一份实例。** 曾经 Market 声明 react@18 而其余是 19，npm 无法提升，它的 chunk 拿到第二个实例、`useState` 读到 null dispatcher 直接崩。各 vite 配置都加了 `resolve.dedupe`。
- **通用类名会跨模块污染。** `module` 层排在 `utilities` 之后，所以模块 CSS 里的 `.grid` / `.app` / `.btn` 会压过 Tailwind 工具类。Market 的样式表整份包在 `.mkt-scope` 之下——注意作用域类要放在**外层**元素，和 `.app` 放同一个元素上会让后代选择器匹配不到自己。
- **`erasableSyntaxOnly`**：Chat 与安卓壳开了它，共享包里不能用构造器参数属性（`constructor(private x)`）。typecheck 发现不了，只有构建会报 TS1294。

## 提交与分支

- `dev` 日常开发，PR 全部提到这里；`main` 仅发版
- Conventional commits，正文解释 WHY
- 提交身份由 `~/.gitconfig` 的目录条件包含自动提供（`0xNull` + noreply 邮箱），**不要在仓库里设置 `user.*`**
- 推送前确认 `gh auth status` 的活跃账号是 `0xNullAI`

## 代码约定

TypeScript `strict` + `noUncheckedIndexedAccess`；仅 ESM；`import type`；未使用变量前缀 `_`；注释解释 WHY 不解释 WHAT；不用 emoji；UI 文案简体中文。

lint 现有 7 个 `react-hooks/exhaustive-deps` 警告，是 DG-Chat 合并前 lint 被 `|| true` 关掉留下的基线。**不要新增**，也不必在无关改动里顺手清理。

`apps/chat` 里有三处 `react-hooks/refs` 的显式豁免（渲染期刷新「最新值」ref）。那是有意为之：改到 effect 里会让 ref 晚一个 commit 更新，设备指令可能读到过期引用。要动请单独做，并真机验证。

## 迁移中

本仓库正在接管九个旧仓库。**迁移期间旧仓保持在线且它们的自动化仍然是武装的**——DG-Kit 的 `release.yml` 在 push 时会 npm publish，Chat/Voice/Market 的 Cloudflare Workers Builds 监听旧仓且 push 即部署生产。所以：**不要往旧仓推任何东西**。
