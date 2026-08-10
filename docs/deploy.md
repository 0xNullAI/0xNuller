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
  --remote-readonly --confirm=dg-market,0xnullai-auth
```

迁移记录必须与远端数据库实际结构一致。不要修改已经发布的 migration，也不要用
`schema.sql` 代替 Wrangler migrations。

## 部署顺序

后端先于 Web 外壳。服务绑定要求使用以下顺序：

1. Chat
2. Auth
3. Market
4. Voice（启用体验服务时）
5. Web

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

## 兼容发布

6.0 只替换 `0xnullai.com` 和 `www.0xnullai.com`。历史子域可以继续运行旧版本：

- `agent.0xnullai.com`
- `voice.0xnullai.com`
- `chat.0xnullai.com`
- `market.0xnullai.com`
- `wiki.0xnullai.com`

切换根域时不要删除旧 Pages 项目、Worker、存储或 DNS。先观察新版稳定运行，再归档不再维护
的旧 GitHub 仓库；归档不是删除，也不代表历史站点下线。

DG-Kit 的迁移与 DG-MCP 的对外发布必须单独确认，不随主站发布自动执行。

## 回滚

Worker 代码可回滚到上一部署版本：

```bash
wrangler rollback --config <wrangler-config>
```

D1 migration 和 Durable Object 数据不会随 Worker 代码回滚。migration 必须向前兼容，
上线前也必须保留可验证的数据库备份。
