# 部署

本页供发布维护者使用。0xNuller 由一个统一 Web 外壳和多个独立 Cloudflare Worker 组成；
各 Worker 保留自己的存储和 Durable Object 命名空间，因此按服务发布和回滚，不做整站替换。

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

生产数据库迁移与产品发布分开管理。GitHub 发布任务不会查询或修改 D1；需要升级数据库时，
由具有 Cloudflare 数据权限的维护者先取得可验证的备份，再按“数据迁移”单独执行。不要修改
已经发布的 migration，也不要用 `schema.sql` 代替 Wrangler migrations。

## 部署顺序

后端必须先于 Web 外壳，服务绑定要求使用以下顺序：

1. Auth（先提供向后兼容的票据/API）
2. Chat
3. LLM Proxy（依赖 Auth 的账户额度）
4. Market
5. Voice（启用体验服务时）
6. Legacy Compat（旧域网页跳转与旧 API 退役响应）
7. Web

`main` 的 CI 成功后会自动触发 `.github/workflows/deploy-cloudflare.yml`。工作流固定检出 CI
验证过的 SHA，不会重新解析一个已经向前移动的分支。各 API Worker 有独立部署版本与路由；Web
始终最后发布，因此任一后端失败都不会把尚未验证的静态外壳推到生产。

Web 发布产物使用当前 Git commit 作为构建编号，并拒绝从有未提交修改的工作区构建：

```bash
npm run web:build:release
```

手工发布时，先上传不接流量的版本，完成烟测后再提升同一个版本：

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

以只读门禁输出为准。migration 账本与表结构不一致时立即停止，不要通过重复执行或改写旧
migration 强行继续。

## 首位管理员

管理员权限绑定账户角色，不使用共享管理口令。账户完成正常注册后，由维护者显式赋予角色：

```bash
npm run account:role -- --remote-write \
  --confirm=0xnullai-auth-account-role \
  --username=<username> --role=admin
```

不要自动把第一个注册账户设为管理员。

## 运行观察

- Auth 注册要求唯一邮箱；验证链接 24 小时有效，密码重置链接 30 分钟有效且只能使用一次。
  找回请求始终返回同一结果，避免泄漏账户是否存在。邮件退信和 suppression list 在 Cloudflare
  Email Sending 中查看。
- Chat 要求邮箱已验证；Control、Agent、Playground 和用户自行配置的模型不受此门禁影响。
- 部署后分别检查 Auth、Chat、Market、Voice 和 Web 的错误率、延迟与异常日志，不能只检查首页。
- 生产 smoke 定期检查 Web 版本、Auth 匿名契约、Chat 邮箱门禁、Market 查询和 Voice 边界；它不
  代替 Cloudflare 的错误率观察。
- 仓库没有内置外部告警接收方。配置通知渠道前，只能声称已采集观测数据，不能声称已有主动告警。

## 旧域迁移

历史子域已永久迁移。网页导航以 `308` 跳到统一主站的对应模块并保留查询参数；旧 API、
WebSocket 和非导航请求返回退役响应。

- `agent.0xnullai.com` → `/agent`
- `voice.0xnullai.com` → `/voice`
- `chat.0xnullai.com` → `/chat`
- `market.0xnullai.com` → `/market`
- `wiki.0xnullai.com` → `/wiki`

跨域 localStorage 与 IndexedDB 搬运的观察期已经结束，主站不再加载隐藏 iframe，旧域也不再提供
存储导出端点。`workers/legacy-compat` 只通过 Custom Domain 或 Worker Route 维持 TLS 和永久跳转；
canonical 账户、Market 与 Chat 数据仍由当前 D1、R2 和 Durable Objects 管理。

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

若新代码依赖新列，migration 必须先保持旧代码可运行，完成观察后再启用新行为；不得把代码回滚
当作数据库恢复方案。
