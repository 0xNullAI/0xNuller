# 0xNuller Web

中文 | [English](README.en.md)

`0xNuller` 的统一网页版外壳。Control、Chat、Agent、Voice、Video、Market 和 Playground 在同一
SPA 中按路由加载，共用侧边栏、账户、设备横栏、设置、主题和弹窗层。

## 路由

| 路径          | 模块           |
| ------------- | -------------- |
| `/control`    | 手动控制       |
| `/chat`       | 房间与私聊     |
| `/agent`      | 文字 Agent     |
| `/voice`      | 实时语音       |
| `/video`      | 视觉控制       |
| `/market`     | 场景与波形社区 |
| `/playground` | 游戏互动       |

主站为 <https://0xnullai.com>。兼容发布只替换根站；`agent.`、`voice.`、`chat.`、
`market.` 与 `wiki.` 历史子域继续运行旧版。

## 本地开发

```bash
npm install
npm run build:kit
npm run dev -w @0xnullai/web
npm run test -w @0xnullai/web
npm run typecheck -w @0xnullai/web
npm run build -w @0xnullai/web
```

## 内置文档

旧 DG-Wiki 的用户文档已经并入主站：

```text
apps/web/src/docs/*.md       文档正文
apps/web/src/docs/index.ts   文档目录
apps/web/src/DocsDialog.tsx  阅读界面
```

新增或修改页面时，同时更新 `index.ts` 的目录信息，并运行 Web 测试与 production build。
历史文档站 <https://wiki.0xnullai.com> 在兼容期保留。

## 结构

```text
src/Shell.tsx        统一外壳与账户门禁
src/Sidebar.tsx      导航、房间和私聊入口
src/DeviceBar.tsx    全局设备状态与停止操作
src/settings/        统一设置
src/modules/         各模块的懒加载入口
src/docs/            用户文档
```

设计令牌和通用组件位于 `packages/platform/ui`。模块不应重复实现外壳已经提供的设备连接、
设置或导航入口。

AI 设置按 Agent、Voice、Video 分 profile 展示，但三者共用 catalog-driven 字段控件；Agent 与
Video 的模型发现走 `@dg-agent/agent-browser`。设置 UI 不直接拼 provider 请求地址或复制 provider
SDK 分支。

## 部署

生产构建由 Cloudflare Workers Static Assets 托管。后端 API 由更具体的路径路由接管；
完整的预检、迁移、预览和回滚顺序见 [部署文档](../../docs/deploy.md)。

## 协议

[MIT](../../LICENSE)
