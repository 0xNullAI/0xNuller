# CLAUDE.md

在 0xNuller monorepo 中工作的开发指引。

## 产品与结构

0xNuller 6.0.0 是一个统一 Web 与 Android 应用，包含六个模块：

1. Control
2. Agent
3. Voice
4. Chat
5. Playground
6. Market

主要目录：

```text
apps/web              统一 Web 外壳
apps/control          直接设备控制
apps/agent            文字 Agent
apps/voice            实时语音
apps/chat             房间、私聊与媒体
apps/playground       游戏
apps/market           场景与波形社区
android/app           单一 Tauri Android 外壳
packages/kit/*        可发布的 @dg-kit 共享层
packages/platform/*   应用内部共享层
packages/agent/*      Agent 运行时与浏览器实现
workers/*             Cloudflare 后端
apps/mcp              MCP 服务；对外发布等待单独确认
```

新增能力前先判断它属于可发布 Kit、全应用共享平台层，还是单一模块。不要复制设备协议、
安全策略、主题、账户或设置存储。

## 设备安全

设备会产生真实输出，以下约束不可削弱：

- 停止操作始终一个动作可达；
- 所有强度、时长与突增请求在设备持有者一侧再次限制；
- 切换模块或失去设备租约时立即停止输出；
- 安全链只保留一份，以 `@dg-kit/safety` 为准；
- 多设备急停必须覆盖每台郊狼与负鼠；
- 游戏、房间消息与模型工具不能绕过共享策略和命令队列。

外壳设备栏只从模块的 `useSafetySession` 注册信息读取。模块切换时交还控制权，不以断开蓝牙
代替撤销租约。

## 共享状态

| 状态                     | 真源                              |
| ------------------------ | --------------------------------- |
| 主题                     | `@0xnullai/ui` theme store        |
| 设备安全设置             | `@0xnullai/settings`              |
| 场景                     | `@0xnullai/scenes`                |
| 模型配置                 | `@0xnullai/llm-providers`         |
| 设备清单、急停与控制租约 | `@dg-kit/safety`                  |
| 账户与角色               | Auth Worker                       |
| Market 内容所有权        | Auth 与 Market 的 Service Binding |

弹窗使用共享 Overlay；模块通过 `SidebarSection`、`ModuleActions`、`useSafetySession` 与
`useNativeBridge` 接入外壳。不要在模块中新增第二个顶部设备入口。

## 命令

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run check:dead-code
npm run verify:data
npm run check:routes
npm run verify:release
```

`@dg-kit/*` 是 dist-first，执行全仓 typecheck、test 或 build 前必须先完成 `build:kit`；根脚本
已经包含此前置步骤。

## Cloudflare 与发布

- 当前产品只运行在 `0xnullai.com` 与 `www`；旧子域只保留永久跳转；
- Worker 继续分开部署，避免移动 Durable Object 命名空间；
- 已发布 migration 不可改写；生产迁移前先只读预检与备份；
- secrets 只写 Cloudflare，不写仓库、日志或文档；
- Chat → Auth → Market → Voice → Web 按依赖顺序发布；
- DG-Kit 迁移与 DG-MCP 对外发布必须先取得用户确认。

详细步骤见 [部署文档](docs/deploy.md)。

## 代码与提交

- TypeScript strict、ESM、type-only import；
- 注释解释原因，面向用户的文案保持简短；
- 提交前执行格式、lint、类型、测试、构建和 dead-code 门禁；
- 日常开发在 `dev`，发布通过 PR 进入 `main`；
- Conventional Commits；
- 作者与提交者必须是 `0xNull <271426072+0xNullAI@users.noreply.github.com>`；
- 不在仓库设置 `git user.*`；
- 不向旧仓库推送代码；归档与下线是两个独立动作。
