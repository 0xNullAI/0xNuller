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
| `llm.0xnullai.com/*`                                     | LLM Proxy      |

Cloudflare 会优先匹配更具体的路径。提交前运行 `npm run check:routes`，确认没有路由重叠。

## 准备

- Node.js 26 或更高版本
- Wrangler 已登录目标 Cloudflare 账户
- 已创建配置中声明的 D1、R2 和 Durable Object 资源
- Market 公开角色头像使用独立 R2 bucket `dg-market-character-portraits`；配置 `PORTRAITS` 绑定前先创建资源并验证权限
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
3. LLM Proxy（依赖 Auth 的账户额度；需要 Secret `AI_PRICE_TABLE` 与 `VOLC_ARK_API_KEY`，缺少时托管模型返回 503）
4. Market
5. Voice（启用体验服务时）
6. Web

`main` 的 CI 成功后会自动触发 `.github/workflows/product-release.yml`。工作流固定检出 CI
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

所有生产 Worker 都关闭 `workers.dev` 和 Preview URL。登录、Chat、Market、Voice 与 LLM
Proxy 的预发布测试使用本地集成环境，或使用不绑定生产密钥、数据库、Durable Object 和 R2 的
专用 staging Worker；不得为了临时验证重新开放生产旁路。

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
- 主动告警只在配置 `ALERT_EMAIL` 后生效，规则见下节；未配置时只能声称已采集观测数据。

## 运行状况与告警

采集与存储由 `@0xnullai/observability` 与 Auth 的 `runtime-monitoring.ts` 负责，数据只在 Auth D1
（migration `0072_runtime_monitoring.sql`，纯新增表）。管理员在「设置 → 管理 → 运行状况」查看近
24 小时汇总（`GET /api/auth/admin/runtime-health`）。

- **客户端错误**：Web 与 Android 外壳把未处理异常、未处理 Promise 拒绝和模块错误边界的错误脱敏后
  发到 `POST /api/auth/client-errors`（匿名、不带 Cookie/Bearer、请求体上限 8 KiB）。服务端重新
  脱敏，按「消息 + 首帧」哈希归并为每小时计数；不保存账户、IP、会话 ID 或任何聊天内容。限流：
  每个 IP 哈希 10 分钟 60 条，全站每小时 5000 条；客户端自身每分钟 5 条、每次启动 50 条并去重。
- **服务端错误**：Auth、Chat、Market、Voice、LLM Proxy 的默认导出由 `withServerErrorCounting`
  包装，按小时记录 5xx、fetch 异常与失败的 cron。Auth 直接写 D1；Market、Voice、LLM Proxy 通过已有
  `AUTH`（`AuthOwnershipService.recordServerErrors`）；Chat 使用新增的仅含计数方法的
  `AUTH_MONITOR` 绑定（`AuthMonitoringService`）。任何监控失败都不影响请求。Web 是纯静态资源
  Worker，没有脚本可包装，前端错误由客户端上报覆盖。
- **告警**：Auth 每 5 分钟检查当前与上一个 UTC 整点小时，满足任一条件即向 `ALERT_EMAIL` 发送
  **一封**汇总邮件（发件人 `no-reply@0xnullai.com`，复用 `EMAIL` 绑定）：

  | 条件                                  | 变量                           | 默认 |
  | ------------------------------------- | ------------------------------ | ---- |
  | 单小时客户端错误总数 ≥                | `ALERT_CLIENT_ERRORS_PER_HOUR` | 100  |
  | 单小时服务端错误总数 ≥                | `ALERT_SERVER_ERRORS_PER_HOUR` | 20   |
  | 24 小时内首次出现的错误近两小时命中 ≥ | `ALERT_NEW_SIGNATURE_HITS`     | 20   |
  | 同一总量告警的最小重复间隔（小时）    | `ALERT_COOLDOWN_HOURS`         | 6    |

  新错误签名只告警一次；邮件发送失败不记为已发送，下次检查重试。

- **配置**：阈值写在 `workers/auth/wrangler.jsonc` 的 `vars`。收件人是逗号分隔的地址，作为 Secret
  设置，不写入仓库：`wrangler secret put ALERT_EMAIL --config workers/auth/wrangler.jsonc`。未设置
  时不发邮件，采集与管理视图照常工作。
- **保留**：每日 cron 删除 30 天前的小时汇总与告警记录；限流台账只保留 1 小时。
- **发布**：先执行 Auth migration `0072`，再部署 Auth，然后部署 Chat（新增 `AUTH_MONITOR` 绑定）。
  顺序颠倒时计数调用失败并被忽略，不影响业务。

## 已退役入口

历史子域、旧 API 入口和跨域浏览器数据迁移服务均已下线。当前产品只支持
`https://0xnullai.com` 与 `https://www.0xnullai.com`，模块通过主站路径访问。

退役入口不拥有 canonical 用户数据。账户、Market、Chat 数据继续由当前的 D1、R2 和 Durable
Objects 管理；清理历史 Worker 时不得删除 `0xnullai-auth`、`dg-market`、`dg-chat-media` 或现役
Durable Object 命名空间。

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
