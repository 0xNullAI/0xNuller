# Voice Worker

`/api/realtime` 为登录账户提供按 Credit 结算的实时语音。客户端从 Auth 获取短期票据，Worker 通过服务绑定确认身份和余额，再由每账户一个 `ManagedVoiceSession` Durable Object 限制并发、预留额度、转发 xAI 并按连接时长结算。上游密钥始终只存在于 Worker secret。

```text
客户端 → Auth 短期票据 → Voice Worker → ManagedVoiceSession → xAI Realtime
```

首发价格为每 10 秒 20 Credit，最低 20 Credit；单次最多 20 分钟，同账户同时一通。失败连接释放预留，Durable Object 的 alarm 会强制结束超时会话。

配置：

- secret：`XAI_API_KEY`
- service binding：`AUTH` → `0xnullai-auth/AuthOwnershipService`
- `MANAGED_DISABLED=1` 可立即停止平台语音服务
- `ALLOWED_ORIGINS` 限制浏览器来源

本地联调需同时启动 Auth 与 Voice Worker并登录测试账户。

## 可恢复结算

每次预留前，Durable Object 先持久化释放意图和 alarm；建立通话后每 10 秒保存已确认连接时长。
挂断、超时或错误先关闭两端 socket，再保存结算任务。任务只有收到 Auth 的实际 `settled` 或
`released` 终态才删除；异常或不匹配的状态保留并由 alarm 重试。原费率与账户钱包不变。

实例重建后不存在匹配的实时连接时，只按最后一次持久化的连接时长结算，不把停机或重试等待
时间算给用户；因此意外中断可能少计最后一个尚未持久化的连接区间。最低一档计费仍适用于已经建立
的通话。尚未建立的连接释放预留。Storage/alarm 故障时不打开新的付费通话。

Auth 的 `finalizeVoiceReservation` 仅通过私有服务绑定调用，绑定原账户和既有 Voice reservation；
不使用已经过期的浏览器票据。公开入口每次从验证结果覆盖账户 subject，客户端不能指定结算账户。
旧 `settleVoiceCredits` / `releaseVoiceCredits` RPC 暂保留用于服务版本兼容，新 DO 使用可重试接口。
部署顺序为 D1 migrations（包括 0044）→ Auth → Voice。

`voice_credit_finalize_retry` / `voice_credit_finalize_pending` 日志表示任务仍需补偿，不代表已扣费
或已退款。`missing`（例如预留 RPC 结果不确定、或账户已删除）与状态冲突不会被当作结算成功，
任务保留以便后续排查；当前未提供运营补偿队列界面。测试覆盖存储重建与故障边界，正式上线仍需
Cloudflare Durable Object、真实 provider 和浏览器断线端到端验收。

补偿任务持久化重试次数与下次执行时间；失败从 10 秒指数退避到最多 5 分钟，状态异常至少等待
60 秒，每轮最多处理 4 项。正在通话或建连时优先维护 deadline 与 checkpoint，挂断后再执行旧账务
RPC，避免额度服务延迟拖过通话时限。旧任务缺少退避字段时按首次重试处理。

新托管通话以query中的conversationId/runId携带已准备好的服务器会话及固定callId。
入口始终清除客户端伪造的内部x-voice-conversation/run头，再转发声明给Auth预留；Auth0043
核验真实账户归属并保存快照，之后才连接上游。旧通话无参数保留unknown。设备执行和计时费率
不变，快照不会变成远端设备权限；需先迁移0043并升级Auth，未部署。

## 过期冻结的终结（0044，未部署）

Auth 按余额计算相同的两小时有效期，在写账时检查冻结。过期冻结以同一事务写入
`voice_billing_reviews` 并释放，不再补扣；返回 `needs_review` 且 `charged: null` 后，
DO 删除对应补偿任务并停止重试。异常携带非空扣款值不会被视为成功。
新通话的恢复任务保存本次预留额度，并核对 `settled` 回执的实扣与确认时长费率、`released`
回执无扣款；金额异常保留同一预留键重试和排查。旧持久任务缺少预留额度时只接受正整数、
20 Credit 整档且不超过确认时长报价的结算，避免升级时丢弃可恢复任务。
审计保留已确认时长及原请求报价，报价不代表实际扣款；运营核对入口见 Auth README。
正常有效冻结仍按原价格结算，已结算重试返回原结果。此次未验证真实上游或生产环境。
