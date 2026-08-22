# 贡献指南

感谢你参与 0xNuller。仓库同时维护一个产品和两个公共 npm 项目，并控制会向人体输出电流或振动的真实设备。请先确认改动属于哪条责任域，再开始编码。

本文分为两部分：所有贡献者都要遵守的开发流程，以及仅维护者执行的版本与发布流程。更详细的架构、测试和发布说明见 [`docs/architecture.md`](docs/architecture.md)、[`docs/testing.md`](docs/testing.md) 和 [`docs/platform-release.md`](docs/platform-release.md)。

## 项目与依赖关系

仓库有三条独立版本线：

| 发布线           | 源码                                                                                         | 版本来源                                              | 交付物                                          |
| ---------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------- |
| 0xNuller Product | `apps/*`（不含 `apps/mcp`）、`android/app`、`packages/agent`、`packages/platform`、`workers` | 根 `package.json` 及同步的 Android/Tauri/Cargo 元数据 | Web、Workers、签名 APK、`vX.Y.Z` GitHub Release |
| DG-Kit           | `packages/kit/*`                                                                             | Changesets 固定版本组                                 | 7 个 `@dg-kit/*` npm 包                         |
| DG-MCP           | `apps/mcp`                                                                                   | `apps/mcp/package.json`                               | `dg-mcp` npm 包                                 |

依赖方向是：

```text
DG-Kit ──> 0xNuller Product
   └─────> DG-MCP
```

Product 不依赖 DG-MCP。三条版本线互不要求版本号相同，但共享同一个 `dev` 集成分支和 `main` 生产源。

## 开始开发

需要 Node.js `>=22.19` 和仓库声明的 npm 版本。功能分支应从最新 `dev` 创建：

```bash
git switch dev
git pull --ff-only origin dev
git switch -c <type>/<short-description>
npm ci
npm run build:kit
npm run test:full
```

DG-Kit 是 dist-first；下游类型检查或构建前应先执行 `npm run build:kit`。`npm test` 只用于产生改动后的相关测试反馈，干净工作树的环境基线使用 `npm run test:full`。以命令退出状态为准，不在文档中维护容易过期的测试数量或警告数量。

## 选择改动位置

| 内容                                       | 位置                                                |
| ------------------------------------------ | --------------------------------------------------- |
| 设备类型、通用契约、安全无关的状态原语     | `packages/kit/core`                                 |
| BLE 字节、位域、设备协议行为               | `packages/kit/protocol`                             |
| 强度策略、命令队列、急停抢占、生命周期守卫 | `packages/kit/safety`                               |
| 波形、工具定义、Web Bluetooth/Tauri 传输   | 对应的 `packages/kit/*`                             |
| Agent 模型运行时和浏览器接线               | `packages/agent/*`                                  |
| 产品级权限、存储、共享 UI 和数据客户端     | `packages/platform/*`                               |
| 单一功能模块的 UI 或交互状态               | `apps/<module>/src`                                 |
| MCP 服务、Node BLE 适配                    | `apps/mcp`                                          |
| Android 壳行为                             | `android/app`                                       |
| Cloudflare 服务                            | `workers/*`、`apps/*/worker` 或 `apps/*/src/worker` |

不要通过跨 App import 复用业务逻辑；把共享行为放入最窄的公共包。不要复制协议、安全或设备状态语义。

## 安全关键改动

以下行为涉及真实设备输出，开始前应先开 issue 说明目标和失效场景：

- `packages/kit/protocol` 和 transport 的设备写入行为；
- `packages/kit/safety` 的强度、时长、命令队列、急停和生命周期规则；
- `packages/platform/permissions` 的授权逻辑；
- Agent、Voice、Chat、游戏或 Worker 到设备命令的落地路径；
- `android/app/src/lifecycle-safety.ts` 的后台、退出和异常停止行为。

不可妥协的约束：

1. 停止和急停始终可达，不得被普通权限、队列或失败状态阻塞。
2. 所有远程、AI、房间、游戏和网络输入都不可信，必须在设备持有者侧重新校验和钳制。
3. 激活、增强和延长输出必须 fail closed；断连、后台、租约丢失和异常路径必须停止。
4. 不得降低安全上限或权限提示来通过测试或演示。
5. 安全逻辑只能有一个真源，不能在不同 App 中复制。

涉及设备行为的 PR 必须列出真机验证状态。获得明确授权和人工监督时，记录设备型号和固件、Web 或 Android 环境、通道、波形、低强度起点、急停、断连及后台结果；未获授权时明确标记“未运行”及原因，由维护者在发布前完成监督验证。单元测试不能替代真机验证。

## 分支、提交与 PR

普通 PR 的 base 必须是 `dev`。只有维护者的正式发布 PR 可以使用 `dev → main`。

建议分支名：`feat/...`、`fix/...`、`docs/...`、`chore/...`。提交和 PR 标题使用 Conventional Commits：

```text
type(scope): imperative subject
```

`type` 可选 `feat | fix | docs | refactor | perf | test | chore | ci | style`。外部贡献者应保留自己的 Git 身份；自动版本提交才使用仓库发布身份。

PR 至少说明：

- 改了什么，以及为什么；
- 失效场景和停止路径（如涉及设备）；
- 公共 API、持久化、权限及下游影响；
- 实际执行的测试；
- 未执行的真机、Android 或视觉检查及原因。

不得直接向 `main` 提交，不得在普通功能 PR 中创建 tag、Release、部署生产环境或发布 npm。

## Changeset 与版本影响

| 改动范围                                     | Changeset                   | 最低验证                     | 版本线                    |
| -------------------------------------------- | --------------------------- | ---------------------------- | ------------------------- |
| Product App、Agent/Platform、Worker、Android | 通常不需要                  | Product + 相关模块           | 由维护者统一提升 0xNuller |
| `packages/kit/*` 公共 API 或运行时行为       | 必须选择直接受影响的 Kit 包 | Kit + Product + MCP          | DG-Kit 固定组             |
| `apps/mcp` 公共行为、CLI、依赖或修复         | 必须选择 `dg-mcp`           | MCP；涉及 Kit 时再跑 Kit     | DG-MCP                    |
| 同一改动同时引入 Kit API/修复并让 MCP 使用   | 同时为 Kit 和 `dg-mcp` 添加 | Kit + MCP + Product 兼容检查 | 先 Kit，后 MCP            |
| MCP 改为依赖已版本化的 Kit API/修复          | 仅 `dg-mcp`                 | MCP + Kit 兼容检查           | MCP                       |
| 根脚本、CI、锁文件                           | 仅在公共交付物变化时需要    | Repository + 受影响责任域    | 视影响而定                |
| 纯测试、文档、无外部行为的重构               | 通常不需要                  | 相关模块                     | 无                        |

创建 changeset：

```bash
npm run changeset
```

- `patch`：兼容修复；
- `minor`：向后兼容功能；
- `major`：破坏性变更，必须先讨论迁移方案。

DG-Kit 的 7 个包属于 fixed group，任一 Kit 包发布会同步提升全组版本。DG-MCP 是独立版本，Kit changeset 不会自动提升 MCP。贡献者只提交 `.changeset/*.md`，不要手改公共包版本或 `CHANGELOG.md`；根产品版本也不由 Changesets 管理。

Kit 改动会触发 Product、Kit、MCP 三套 CI，这是下游兼容验证，不代表 Product 或 MCP 必须自动升版。

## 验证要求

迭代时运行最窄的相关测试：

```bash
npm test
npm run test:module -- <module>
```

按责任域验证：

| 责任域     | 命令                                                                             |
| ---------- | -------------------------------------------------------------------------------- |
| Repository | `npm run test:repository`、`npm run check:structure`、`npm run lint`             |
| Product    | `npm run typecheck:product`、`npm run test:product`、`npm run build:product:web` |
| DG-Kit     | `npm run verify:kit`、`npm run typecheck:kit`、`npm run test:kit`                |
| DG-MCP     | `npm run verify:mcp`、`npm run typecheck:mcp`、`npm run test:mcp`                |

交付前运行：

```bash
npm run check:structure
npm run lint
npm run typecheck
npm run test:full
npm run build
```

协议修复需要旧实现会失败的字节级回归测试；transport 需要适配器测试；跨产品设备行为需要共享层测试及适用消费者测试。禁止静默、排除或用 `|| true` 绕过失败测试。

## 维护者发布流程

外部贡献者到功能 PR 和 changeset 为止。以下步骤只由具有发布权限的维护者执行。

### 1. 集成到 dev

1. 功能分支从 `dev` 创建并通过 PR 合回 `dev`。
2. 确认安全、兼容性、文档和 changeset 完整。
3. `dev` 只做集成和版本准备，不发布任何生产产物。

### 2. 准备 npm 版本

1. `NPM Version Preparation` 在 `dev` push 后创建或更新 `changeset-release/dev` PR。
2. Bot PR 消费 changeset、更新 DG-Kit/DG-MCP manifest、内部依赖和 CHANGELOG。
3. 审查版本级别、依赖范围和 release note；四套 CI 通过后按仓库保护规则合回 `dev`。
4. 这是正常的两阶段 Changesets 流程，不是重复发布；此时 npm 仍未发布。

DG-Kit 与 MCP 同批变化时，MCP manifest 必须声明包含所需 Kit API/修复的最低兼容范围。

### 3. 准备 Product 版本

需要交付 Web/Android 时，单独准备 0xNuller 版本：

1. 同步更新 `package.json`、`android/app/package.json`、`android/app/src-tauri/tauri.conf.json`、`android/app/src-tauri/Cargo.toml`、`android/app/src-tauri/Cargo.lock` 和 `package-lock.json`；
2. 按 `major * 1,000,000 + minor * 1,000 + patch` 更新 Android `versionCode`；
3. 更新 `android/app/README.md`、`docs/android-release.md`，并新增 `docs/releases/X.Y.Z.md`；
4. 运行 `npm run verify:release -- --base=origin/main`。

Product、DG-Kit、DG-MCP 可以同批进入 `main`，但版本号保持独立。

### 4. 晋升到 main

1. 确认 `.changeset` 没有待消费文件；
2. 创建唯一的 `dev → main` 发布 PR；
3. Release Guard 校验来源分支、版本增长和产品元数据；
4. Repository、Product、Kit、MCP 的必要 CI 全部通过；
5. 必须使用 merge commit，禁止 squash 或 rebase 发布 PR。

`main` 是 npm、Cloudflare、APK 和 GitHub Release 的唯一生产源。

### 5. 自动交付顺序

同一个已验证的 `main` SHA 会启动三条独立流程，它们不是全局串行：

- **DG-Kit** 查询 npm，逐个发布尚不存在的固定组版本；
- **DG-MCP** 可以并行启动，但会等待当前源码声明的 Kit 版本全部可从 npm 获取，再发布尚不存在的 `dg-mcp` 版本；
- **0xNuller Product** 独立构建并部署 Web/Workers、构建和验证签名 APK，最后创建 `vX.Y.Z` GitHub Release。

唯一强制的跨流程顺序是 DG-Kit → DG-MCP。三条工作流都应验证当前 SHA 仍是 `main` tip、Repository CI 和自身责任域 CI 已通过。Product 不等待 npm Kit，因为它从同一 monorepo SHA 构建。

DG-Kit 和 DG-MCP 不创建 Git tag 或 GitHub Release。只有 Product 创建 `vX.Y.Z` 和版本化 APK。

### 6. 发布后验证与恢复

```bash
npm view @dg-kit/core version
npm view @dg-kit/protocol version
npm view dg-mcp version
gh release view v<X.Y.Z>
```

同时检查线上 `/version.json`、APK 资产和真机升级。npm 版本不可覆盖；部分发布失败时以 npm 实际状态为准重试对应工作流。不要删除已有产品 tag 或 Release 来修复 npm 发布。

## 禁止事项

- 不直接推送 `main`，不绕过 Release Guard 或责任域 CI；
- 不在普通 PR 中运行 `npm run version`，不手改生成的版本和 CHANGELOG；
- 不提交密钥、账号、设备地址、生产数据或签名材料；
- 不修改或提交 `dist`、`target`、`src-tauri/gen`、`.astro`、`.wrangler` 和构建缓存；
- `docs/legacy` 是历史快照，不作为当前规范，也不要顺手修改；
- 不重写他人历史、删除他人工作或执行未经授权的外部发布操作。
