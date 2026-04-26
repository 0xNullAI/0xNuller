# DG-Agent · 开发者文档

面向想魔改 DG-Agent、加新 LLM provider、做新桥接、或贡献代码的人。

## 仓库结构

```
DG-Agent/
├── apps/
│   └── web/                          React 18 SPA UI 壳
│       └── src/
│           ├── App.tsx               入口
│           ├── components/           UI 组件
│           ├── hooks/                React hooks
│           ├── composition/          createBrowserServices 装配
│           └── services/             浏览器专属服务（主题、安全提醒等）
├── packages/
│   ├── core/                         re-export of @dg-kit/core + agent 专属类型
│   ├── client/                       AgentClient 抽象（embedded / HTTP）
│   ├── runtime/                      agent 循环、policy engine、turn state
│   ├── agent-browser/                浏览器侧装配（无 React）
│   ├── bridge/                       QQ / Telegram 桥
│   ├── device-webbluetooth/          shim → @dg-kit/protocol + transport-webbluetooth
│   ├── permissions-browser/          带 UI 弹窗的权限服务
│   ├── providers-catalog/            LLM provider 注册表
│   ├── providers-openai-http/        OpenAI 兼容 HTTP/SSE 传输
│   ├── storage-browser/              IndexedDB sessions + localStorage settings
│   ├── audio-browser/                DashScope ASR/TTS + 浏览器 SpeechRecognition
│   └── waveforms/                    IndexedDB 波形库（基于 @dg-kit/waveforms）
└── aliyun-fc/                        阿里云函数计算的免费代理（CommonJS，独立）
```

## 数据流

```
apps/web (React UI)
  ↓
@dg-agent/agent-browser (createBrowserServices 工厂)
  ↓
AgentClient (embedded) → Runtime
  ↓                          ↓
DeviceClient            LlmClient + PermissionService
  ↓
@dg-kit/protocol → Web Bluetooth → 设备
```

`runtime/runTurn()` 的循环：

1. 构建 system instructions（含工具描述、强度上限提示）
2. 调 LLM
3. 如果有工具调用：
   - 检查 policy engine（强度上限、回合次数）
   - 通过 → 弹权限确认（如果需要）→ 执行 → 反馈结果
   - 拒绝 → 把拒绝原因塞回上下文，让 LLM 重试
4. 如果没有工具调用 → 回合结束，返回文本

## 关键模式

### UI / Agent 分离

- `apps/web` 是**纯 React 壳**，只做 UI 状态管理 + useEffect 包装
- 所有业务装配在 `@dg-agent/agent-browser` 的 `createBrowserServices()` 工厂里
- 这个工厂返回 `{ deviceClient, llmClient, permissionService, sessionStore, runtime }`，是纯 TypeScript 没有 React 依赖

这种分离让 runtime 可以被 Node 端复用（比如未来要做 `@dg-agent/agent-node`）。

### 契约 / 适配器

`@dg-agent/core` 重新导出 `@dg-kit/core` 的接口（`DeviceClient`、`LlmClient`、`WaveformLibrary`），并加 agent 专属契约（`SessionStore`、`SessionTraceStore`、`PermissionService`）。具体实现各自在 `*-browser` / `*-http` / 等适配器包里。

### Per-channel burst quota

burst 调用次数是按通道计数的（A / B 各 1 次），不是全局。改这块逻辑去 `runtime/runtime-tool-executor.ts`。

### Policy engine

硬编码的 LLM 不能绕过的安全约束在 `runtime/policy-engine.ts` 和 `runtime/default-policies.ts`：

- 单回合最大工具迭代次数（防 LLM 死循环）
- 单步强度调节幅度
- Burst 时长上限
- Burst 强度上限（基于通道当前强度）
- 冷启动钳制

加新规则：在 `default-policies.ts` 写一个 `PolicyRule`（实现 `evaluate(input): PolicyDecision | null`），加到默认列表。

### Model context strategy

`last-user-turn` / `last-five-user-turns` / `full-history` 三种。在 `runtime/agent-runtime.ts` 的 `buildLlmHistory()` 里实现。改时注意 LLM 上下文长度。

## 加新功能

### 加一个新 LLM provider

1. `packages/providers-openai-http/`（或新开一个包）— 实现 `LlmClient` 接口的 `runTurn(input)` 方法
2. `packages/providers-catalog/` — 注册到 catalog，加显示名 / 默认 base URL / 默认模型名
3. `apps/web/src/components/SettingsDrawer.tsx` — 如果需要特殊 UI（比如自定义请求头），加表单字段

参考已有 `providers-openai-http` 的实现。

### 加一个新工具

工具定义在 [`@dg-kit/tools`](#/kit/api) 里。如果是 DG-Agent 专属工具（不需要给 DG-Chat / DG-MCP）：

1. `packages/runtime/src/tool-registry.ts` — 这是个 re-export 层，但你可以在底下加 agent-only 工具
2. 用 `registry.register({ name, definition, toExecutionPlan })` 注册
3. 在 `runtime-tool-executor.ts` 里加新工具的执行分支

如果是要给三个项目共享的工具，去 [DG-Kit 的 `@dg-kit/tools`](#/kit/developer) 加。

### 加一个新桥接（比如 Discord / Slack）

1. `packages/bridge/` — 新建 `discord-adapter.ts`，实现 `BridgeAdapter` 接口
2. 接 Discord WebSocket 或 webhook，把入站消息塞进 `BridgeManager.dispatch()`
3. UI 设置里加个 Discord tab 让用户填配置
4. 持久化设置走 `storage-browser`

### 加一个新设备适配（比如 Coyote 4.0）

要先在 [DG-Kit 加协议适配器](#/kit/developer)，DG-Agent 几乎不需要改——facade 自动选用就行。

## 测试

```bash
npm install
npm run dev          # Vite, http://localhost:5173/
npm run build        # 全 workspace 构建
npm run typecheck    # 全 workspace
npm run test         # vitest, 全 workspace（74 个测试）
npm run lint         # eslint zero-warning 政策
```

测试覆盖 runtime turn loop、tool executor、policy engine 等。改这些时务必加测试。

## 贡献流程

1. Fork → 在 fork 里建 feature branch（基于 `dev`）
2. 改 → push → PR 到 `0xNullAI/DG-Agent` 的 **`dev` 分支**（**不是 `main`**）
3. CI 自动跑 lint / typecheck / test / build
4. Review 后合入 `dev`
5. dev 推送自动通过 `.github/workflows/mirror-dev.yml` 镜像到 [`DG-Agent-dev`](https://github.com/0xNullAI/DG-Agent-dev) 的 `main` 分支
6. 镜像仓库自己的 `deploy.yml` 触发 → 大约 45 秒后 dev 内容上线 [https://0xnullai.github.io/DG-Agent-dev/](https://0xnullai.github.io/DG-Agent-dev/)（**dev 实时预览站**）

发布到生产线则是另一个动作：

7. 准备发版时：在 dev 上 `npm version patch`（或 minor / major）→ commit
8. PR 从 dev → main → `release-guard.yml` 校验 `package.json` version 已 bump
9. 合并到 main → `deploy.yml` 部署到 [https://0xnullai.github.io/DG-Agent/](https://0xnullai.github.io/DG-Agent/) + `auto-tag.yml` 推 `vX.Y.Z` 标签

## 二次开发

完整 fork 一份做自己的 AI 控制器，建议：

1. 改 `package.json` 里的 `name`（避免发布冲突）
2. 改 `apps/web/index.html` 的 title、meta
3. 改 `apps/web/public/` 下的 favicon、og-image
4. 改 `apps/web/src/styles/tokens.css` 的 accent 色定义自己的视觉
5. UI 文案在各 component 里改

## 代码规范

完整规则在 `DG-Agent/CLAUDE.md`。要点：

- TypeScript strict、ESM only
- UI 文案 **简体中文**
- `import type` 显式标注类型导入
- 未使用变量加 `_` 前缀
- 注释解释 WHY，不解释 WHAT
- 不引入新依赖前先看现有的能不能复用
- 改 UI 之前看 `CLAUDE.md` 的「UI Maintenance Notes」（用户已确认的行为不要改）

## 部署 / 双站点

DG-Agent 有两个 GitHub Pages 站点同时运行：

| 站点 | URL | 来源 | 触发 |
|---|---|---|---|
| 生产 | https://0xnullai.github.io/DG-Agent/ | DG-Agent 本仓 main 分支 | 合 PR 到 main 时（必须带 version bump） |
| 开发预览 | https://0xnullai.github.io/DG-Agent-dev/ | [DG-Agent-dev 镜像仓](https://github.com/0xNullAI/DG-Agent-dev) main 分支 | dev push 后自动镜像 + deploy |

镜像通过 `.github/workflows/mirror-dev.yml` 实现：每次 push 到 dev，用 PAT 把 dev 强推到 DG-Agent-dev/main，然后镜像仓自己的 deploy.yml 跑构建+发布。

`vite.config.ts` 用 `base: './'`（相对路径），同一份代码部署到不同子路径都行。如果你自己 fork 部署到第三个 URL，不需要改 base。

镜像 PAT 配置在 DG-Agent 的 secrets 里（`MIRROR_PAT`），权限范围：`Contents: read+write` + `Workflows: read+write` 仅对 DG-Agent-dev 仓。
