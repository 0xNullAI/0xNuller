# 平台运行审计

## 注册与邮箱

- 新注册要求格式有效且唯一的邮箱。Cloudflare Email Sending 通过 `no-reply@0xnullai.com`
  发送验证与找回邮件；验证 token 24 小时有效，重置 token 30 分钟有效且一次性使用。
- Chat 在前端和 Worker 入口都要求邮箱已验证；房间、公开目录、私聊票据和账户房间同步不能由
  未验证账户调用。Control、Agent、Playground 与自带模型配置不受此门禁影响。
- 登录已有用户名/IP 双维度失败限流。注册现在另按来源 IP 的不可逆哈希限制为每小时 5 次，
  定时任务清理记录；它降低批量建号风险，但不替代 Turnstile 或邮箱验证。
- 找回请求始终返回同一结果，避免泄漏邮箱是否注册。Cloudflare 负责硬退信抑制；运营侧仍应
  定期查看 Email Sending analytics 和 suppression list。

## 流量与故障观察

- Chat、Auth、Market、Voice、Web 均已启用 Workers observability。部署后应分别查看请求错误率、
  延迟和异常日志，不能只用主页 200 作为成功标准。
- GitHub Actions 每 15 分钟运行一次 `npm run smoke:production`，检查 Web 构建标识、Auth 匿名
  契约、Chat 邮箱门禁、Market 查询和 Voice WebSocket 边界。失败会保留独立运行记录，并按
  仓库的 Actions 通知设置提醒维护者；它用于可用性监测，不代替 Cloudflare 的错误率分析。
- 服务使用独立 Worker、路由和存储；部署与回滚按服务操作。D1/R2/DO 数据不随代码版本回滚。
- 仓库未配置外部告警接收方或 Cloudflare Analytics API 凭据，因此当前只保证采集，不声称已有
  主动告警。配置通知渠道后再添加错误率和注册 429 激增告警。

## npm 发布

- `@dg-kit/*` 由 changesets 固定版本组管理；`dg-mcp` 保持独立版本和独立人工批准工作流。
- `npm run verify:packages` 会构建并执行 `npm pack --dry-run`，检查入口、README、仓库元数据和
  测试产物泄漏。它不发布任何包。
- 旧 DG-Kit 与 DG-MCP 仓库均已归档，旧发布工作流已停用；新的 Kit/MCP 发布只从本仓执行。
  现行版本、工作流与验证命令记录在 `docs/kit-release-switchover.md`。
