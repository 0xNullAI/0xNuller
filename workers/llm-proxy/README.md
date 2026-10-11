# 0xNuller Managed LLM Worker

这是 `https://llm.0xnullai.com` 的正式 Credit 模型入口。模型通过同一 Cloudflare 账号的 Workers AI binding 运行，不需要第三方 API Key；登录账户在请求前预留 Credit，成功后按实际 Token 结算，明确未执行时释放预留，执行状态不明时等待后台核对。自己的 API Key 不经过本 Worker，也不消耗 Credit。

生产脚本沿用 `dg-llm-proxy`。Workers AI、自定义域、日志、服务绑定、来源白名单、全局限流和关闭的 workers.dev/Preview URL 均由 `wrangler.toml` 管理。

平台公开三个稳定文字档位：基础、均衡和强力。真实 Cloudflare 模型 ID、能力和 Credit 价格只由 Worker 白名单决定，客户端不能指定任意模型或价格。Video 单独使用 `vision`。私人角色聊天的 `chat-vision` 协议已与 Video 分离，但在真实模型与计费验收前不出现在 Agent 的模型选择中，也不开放托管看图按钮。

## 摄像头视觉 Credit

托管 Video 的 `vision` 映射到 Cloudflare Workers AI `@cf/meta/llama-4-scout-17b-16e-instruct`。价格版本 `workers-ai-credits-2026-09`：Cloudflare 官方列出的输入/输出价分别为每百万 Token USD 0.270 / 0.850，产品现行换算为 USD 1 = 1,500 Credit，故每百万 Token 为 405 / 1,275 Credit。这是成本换算和内部 Credit 报价，不代表人民币售价。来源：[模型规格与 131k context](https://developers.cloudflare.com/workers-ai/models/llama-4-scout-17b-16e-instruct/)、[Workers AI 价格](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[AI Run 图像输入和 usage 结构](https://developers.cloudflare.com/api/resources/ai/methods/run/)。实际线上模型兼容性与计价仍须在上线前做真实小额验收；本地测试不调用付费模型。

每次观察只接受一张 JPEG data URI，压缩后至多 250 KiB；请求上限 1 MiB，最多一个 system 提示和一个带图片的 user 消息，输出最多 4,096 Token。模型 131,000 输入 Token 的完整上下文上限成本为 53.055 Credit，输出上限成本为 5.2224 Credit，向上取整为 **最多预留 59 Credit/次**，多出的 0.7226 Credit 是取整余量。实际扣费只依据服务商返回的真实输入/输出 usage 向上取整，不是每帧固定扣 59。Auth 独立固定校验 59、`vision/video`、会话所有权和 runId；额度不足不会启动上游。代理对实际发送给模型的文字、图片、工具及参数计算 SHA-256，Auth 将哈希绑定到预留并在 checkpoint 时再核对，浏览器无法自己决定金额或哈希。

缺少 usage、报告超过 131k 输入/4096 输出、价格超过预留，或结果无法交付时返回 `pending` 待账务核对；不虚构 Token、不把失败结果标为已成功扣费。Auth 的 10 分钟无心跳补偿会将未知用量标记 `needs_review` 并释放冻结，人工核对记录保留。相机最短每 5 秒观察一次、同一 Video 会话不并发请求、授权最多 15 分钟；图片本身不写入数据库或会话。自带密钥路径继续由服务商计费，不走平台 Credit。

## 本地验证

```bash
npm test -w @0xnullai/llm-proxy-worker
npm run deploy:dry -w @0xnullai/llm-proxy-worker
```

部署前先应用 Auth D1 migration，随后依次部署 Auth 和本 Worker。完整顺序见[部署文档](../../docs/deploy.md)。

## 协议

[MIT](../../LICENSE)

## 流式计费与中断

文字输入预留现在包含工具定义及结构化输出格式，避免大工具schema未计入输入额度。仍按现有
三个档位和真实usage收费，不更换模型或价格。usage必须提供非负整数输入/输出token，缓存
token不得超过输入token；缺少有效usage不会凭空估算实际费用。

SSE以事件边界解析，兼容分块CRLF和末尾无换行的usage。每个已读取块先提取全部usage再向
客户端写出；客户端取消会停止上游读取，已经收到可验证usage时结算该用量。请求已发往上游但
没有可信usage时保留预留为 pending，交由 Auth 后台标记待核对并释放冻结。只有调用前取消或
明确收到无结果的上游拒绝才立即释放。
上游在usage之后中断也结算已确认用量，不以流错误把真实使用无条件变成免费。[DONE]仅在
Auth确认结算后发送；结算失败使流报错，不能提前向客户端宣告成功。

结算/释放均校验Auth实际终态，最多同幂等键重试3次，每次RPC最多等待3秒。结算超时可能已经
提交，因此始终重试settle，绝不随后调用release；非流式接口也不能在未确认结算时返回
`credit_charged`。已知相反终态或仍未确认会返回错误及真实可知的billing_status。释放失败不会
吞掉原始模型错误，返回pending以便用户查看账本。重复pending请求不会重新启动上游生成。

新增 Auth migration `0039_text_billing_outbox.sql` 后，托管文字通过私有
`reserveManagedTextCredits` 注册持久化任务；成功后才启动上游。服务返回仅用于该预留的随机
capability，留在 Worker 请求内，不发给浏览器、不记录 Cookie/Bearer。checkpoint、状态查询与
终结 RPC 使用此 capability，因此后台补偿不依赖用户会话有效期。缺少新版 RPC 时失败关闭。

有效 usage 在对应 SSE 帧交付前写入 Auth；非流式结果在响应交付前写入。最终 settle/release
意图先落库，再在同一 D1 事务写原账本和预留终态。现有 Auth 分钟 cron 每批最多恢复 20 项，
失败持久退避 30 秒到 5 分钟。10 分钟无心跳或 checkpoint 的运行任务按已确认用量结算；没有确认用量
则标记 needs_review 并释放冻结，不猜费用。上游调用报错、流中断或响应缺用量也沿用这一路径，
因为请求可能已经到达服务商。两小时预留已过期时也只 review/release，避免迟扣
侵占已用于其他消费的余额。重复 idempotency key 不重新生成，也不重放模型响应。

这不等于所有上游成本都能追偿：早期文字 delta 可先于 provider 最终 usage 交付，进程在 usage
落库前死亡无法证明实际用量，只能留待核对。needs_review 目前保存在 D1，尚无专门运营处理界面。
任务登记失败会按刚验证的账户释放新预留；若数据库连释放也失败，冻结可能保留到原两小时
有效期，日志 `Text billing registration cleanup deferred` 用于核对。补偿不重启生成。
需要先应用迁移、部署 Auth，再部署代理；未执行迁移或部署，也未进行真实付费模型验收。

托管视觉还需要 Auth migration `0051_vision_request_hash.sql`，仅在 outbox 保存请求摘要；先部署该迁移及 Auth，再启用代理和 Video 客户端。不会保存原始画面。

`chat-vision` 与 Video 使用同一上游模型和 59 Credit 最大预留，但只接受 `agent` 用量种类、已归属的私人会话和 runId。它允许角色指令、私人 Memory、近期文字历史、最多一张当前用户 JPEG 与有界工具往返；工具后续请求不重传图片。请求不支持流式输出，代理对最终转发内容计算摘要，并沿用 Auth 的 checkpoint/settle/pending 补偿。协议测试并不等于真实模型兼容性或付费验收；Worker 默认拒绝此模型并从 `/v1/models` 隐藏，只有经真实验收后显式配置 `ENABLE_CHAT_VISION=true` 才可启用代理。客户端仍保持隐藏，需单独开放。

预留 RPC 等待上限为 3 秒；异常或不合法的授权状态返回 503 和 `billing_status: unknown`，
不调用模型，也不自动释放可能已落库的预留。只有 `allowed: true` 且 `status: pending` 可以开始。
SSE 的 `[DONE]` 是读取终点：无需等待上游关闭连接，终点之后的 usage 不参与结算。

运行期间代理每分钟持久化心跳，心跳 RPC 3 秒内未确认则中止后续转发与交付；未知用量保留
任务待核对，不宣称释放成功。心跳不刷新原预留的2小时TTL，过期会拒绝续约。

私人文字请求可附 `X-0xNullAI-Conversation-Id` 和 `X-0xNullAI-Run-Id`，仅转交Auth预留验证，
不进入模型输入。Auth0043保存预留时快照；不属于账户或已删除会话使预留失败，不能继续生成。
旧请求和临时试聊不必提供context，保持unknown。真实费率与Token结算方式不变。
