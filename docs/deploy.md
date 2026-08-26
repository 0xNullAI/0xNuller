# 部署

0xNuller 使用一个统一 Web 外壳和多个独立 Cloudflare Worker。独立 Worker 保留各自的
存储与 Durable Object 命名空间，避免部署一个模块时影响其他模块。

## 路由

| 路径                                                     | 服务           |
| -------------------------------------------------------- | -------------- |
| `/*`                                                     | Web 静态资源   |
| `/api/auth/*`                                            | 账户与个人数据 |
| `/ws/*`、`/api/lobby/*`、`/api/upload/*`、`/api/media/*` | Chat           |
| `/api/items*`                                            | Market         |
| `/api/realtime`                                          | Voice 体验服务 |

Cloudflare 会优先匹配更具体的路径。提交前运行 `npm run check:routes`，确认没有路由重叠。

## 准备

- Node.js 22.19 或更高版本
- Wrangler 已登录目标 Cloudflare 账户
- 已创建配置中声明的 D1、R2 和 Durable Object 资源
- Worker 密钥保存在仓库外，并限制文件权限

配置只声明密钥名称，不保存密钥值。当前 Worker 使用的变量可从各自的
`wrangler.jsonc`、`wrangler.toml` 和 `.dev.vars.example` 查看。

## 发布前检查

```bash
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run verify:data
npm run check:routes
```

生产数据库升级前必须先备份，并运行只读门禁：

```bash
npm run release:data:preflight -- \
  --remote-readonly --confirm=dg-market,0xnullai-auth --require-current
```

该发布门禁只执行读取；数据库不是当前版本时会阻止 Worker 与 GitHub Release 发布。先备份并按
“数据迁移”应用所有待处理 migration，再重新运行。不要修改已经发布的 migration，也不要用
`schema.sql` 代替 Wrangler migrations。

## 部署顺序

后端先于 Web 外壳。服务绑定要求使用以下顺序：

1. Auth（先提供向后兼容的票据/API）
2. Chat
3. LLM Proxy（依赖 Auth 的账户额度）
4. Market
5. Voice（启用体验服务时）
6. Browser Migration（旧子域存储导出端点）
7. Legacy Compat（旧域网页跳转与旧 API 代理）
8. Web

`main` 的 CI 成功后会自动触发 `.github/workflows/deploy-cloudflare.yml`。工作流固定检出 CI
验证过的 SHA，不会重新解析一个已经向前移动的分支。各 API Worker 有独立部署版本与路由；Web
始终最后发布，因此任一后端失败都不会把尚未验证的静态外壳推到生产。

Web 发布产物使用当前 Git commit 作为构建编号，并拒绝从未提交的代码构建：

```bash
npm run web:build:release
```

建议先上传不接流量的版本，完成烟测后再提升同一个版本：

```bash
wrangler versions upload --config <wrangler-config> \
  --secrets-file <outside-repo-env> \
  --tag <release-tag> --preview-alias <preview-name>

wrangler versions deploy <version-id>@100% \
  --config <wrangler-config> --yes
```

Web 是纯静态 Workers Assets。它的 `workers.dev` 预览地址不会继承主域上的 API 路由，
因此只用于静态界面检查。登录、Chat、Market 和 Voice 的完整预发布测试应使用带 API
代理的本地集成环境，或配置了同一套路由的专用预发布域。

## 数据迁移

```bash
wrangler d1 migrations apply 0xnullai-auth --remote \
  --config workers/auth/wrangler.jsonc

wrangler d1 migrations apply dg-market --remote \
  --config apps/market/wrangler.jsonc
```

升级已有生产库时，以只读门禁输出为准；遇到 migration 账本与表结构不一致时先停止，
不要通过重复执行或改写旧 migration 强行继续。

## 首位管理员

管理员权限绑定账户角色，不使用共享管理口令。账户完成正常注册后，由维护者显式赋予角色：

```bash
npm run account:role -- --remote-write \
  --confirm=0xnullai-auth-account-role \
  --username=<username> --role=admin
```

不要自动把第一个注册账户设为管理员。

## 旧域迁移

历史子域已永久迁移：网页导航以 `308` 跳到统一主站的对应模块并保留查询参数；旧 API、
WebSocket 和非导航请求返回退役响应，不再依赖历史 Worker 或 Pages。

- `agent.0xnullai.com` → `/agent`
- `voice.0xnullai.com` → `/voice`
- `chat.0xnullai.com` → `/chat`
- `market.0xnullai.com` → `/market`
- `wiki.0xnullai.com` → `/wiki`

主站首次加载时通过 `workers/browser-migration` 在各旧 origin 的受限 `.well-known` 端点迁移白名单
localStorage 与 IndexedDB 数据。该端点长期保留，旧域由 `workers/legacy-compat` 的 Custom Domain
或 Worker Route 维持 TLS 和永久跳转，因此删除历史站点不会阻止长期未上线用户迁移浏览器数据。

Market 新旧版本共用 `dg-market` D1；Chat 新旧版本共用 `dg-chat-media` R2。旧版非保留 Chat
房间原本会在空置十分钟后删除消息和媒体，不是永久历史库。删除历史 Worker 时不得删除这两个
仍由当前产品使用的共享存储。

DG-Kit 的迁移与 DG-MCP 的对外发布必须单独确认，不随主站发布自动执行。

## 回滚

Worker 代码可回滚到上一部署版本：

```bash
wrangler rollback --config <wrangler-config>
```

GitHub Actions 的 `Roll back Cloudflare service` 工作流接受固定服务名和明确的已知良好
`version_id`，一次只恢复一个 Worker。版本号先从该服务的 `wrangler deployments list` 获取；
不要因一个模块失败而回滚全部模块。自动部署使用同一并发组，回滚不会与部署同时执行。

D1 migration 和 Durable Object 数据不会随 Worker 代码回滚。migration 必须向前兼容，
上线前也必须保留可验证的数据库备份。

Worker 回滚不会撤销 D1 migration。若新代码依赖新列，migration 必须先保持旧代码可运行，完成
观察后再启用新行为；不得把代码回滚当作数据库恢复方案。
