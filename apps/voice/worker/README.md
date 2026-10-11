# Voice Worker

`/api/realtime` 为登录账户提供按 Credit 结算的实时语音。客户端从 Auth 获取短期票据，Worker 通过服务绑定确认身份和余额，再由每账户一个 `ManagedVoiceSession` Durable Object 限制并发、预留额度、转接豆包端到端实时语音（Seeduplex），并按服务商逐轮上报的用量结算。上游密钥始终只存在于 Worker secret。

```text
客户端 → Auth 短期票据 → Voice Worker → ManagedVoiceSession → 豆包 Seeduplex
```

单次最多 `MAX_SESSION_MINUTES`（默认 20）分钟，同账户同时一通。失败连接释放预留，Durable Object 的 alarm 会强制结束超时会话。

配置：

- secret：`VOLC_SPEECH_API_KEY`（豆包语音新版控制台 API Key，作为 `X-Api-Key` 发往上游）
- secret：`AI_PRICE_TABLE`（`@0xnullai/ai-pricing` 价格表；其中 `realtime.model` 指定模型）
- 任一缺失或价格表无效时，入口与 Durable Object 都返回 503，不按默认价计费
- service binding：`AUTH` → `0xnullai-auth/AuthOwnershipService`
- `MANAGED_DISABLED=1` 可立即停止平台语音服务
- `ALLOWED_ORIGINS` 限制浏览器来源

本地联调需同时启动 Auth 与 Voice Worker 并登录测试账户。

## 协议转接

浏览器只与本 Worker 通信，协议见 `src/lib/realtime/managed-voice-session.ts`：扁平
`session.update`（指令、音色、工具）、16 kHz pcm16 上行、24 kHz pcm16 下行。
`worker/doubao-realtime.ts` 负责双向转换：

- 首个 `session.update` 变为 `session.create`（模型来自价格表，音色经共享音色目录校验，
  旧服务商的音色 ID 映射为目录音色）；之后只刷新指令与工具，通话内音色不变。
- 会话建立前的麦克风帧丢弃；服务端要求 20 ms 一帧、按实时节奏发送。
- 工具调用以 `response.function_call_arguments.done` 下发；同批全部结果收齐后一次性回传，
  模型随后自动继续，浏览器的 `response.create` 不再上行。设备工具仍只在浏览器一侧经
  权限确认、策略限制与命令队列执行，Worker 不接触设备。
- 用户转写只转发最终文本（服务端的增量是累计文本）；助手文本与音频按轮转发，音频结束即向
  浏览器发送 `response.done`，使设备相关回复的播放闸门不必等用量回执。

## 按轮用量结算

服务商每轮在 `response.done` 上报 `input_token_details`（文本、音频，以及额外计入的缓存
命中）与 `output_token_details`。Durable Object 逐轮累计并立即持久化；无法解析的回执
不估算，按“缺失”计数。挂断后先发送 `input_audio_mute.commit`，最多等待 20 秒让已经说完的
轮次补报用量，再发送 `session.close` 并等待确认。仍未上报的轮次计为缺失。

预留额度按价格表与每分钟用量上限估算（见 `realtimeReservation`），同时决定通话时限；
已上报用量达到预留的九成时主动结束通话。Auth 按价格表计价并封顶于预留；存在缺失轮次或
用量超出预留时，只扣已上报部分，并写入 `voice_usage_reviews` 供运营核对。

## 可恢复结算

每次预留前，Durable Object 先持久化释放意图和 alarm；建立通话后每 10 秒及每次收到用量时
保存已确认时长与累计用量。挂断、超时或错误后保存结算任务。任务只有收到 Auth 的实际
`settled` 或 `released` 终态才删除；异常或不匹配的状态保留并由 alarm 重试。

实例重建后不存在匹配的实时连接时，只按最后一次持久化的用量结算，检查点时仍在等待用量的
轮次计为缺失；不把停机或重试等待时间算给用户。尚未建立的连接释放预留。Storage/alarm 故障
时不打开新的付费通话。

Auth 的 `finalizeVoiceReservation` 仅通过私有服务绑定调用，绑定原账户和既有 Voice reservation；
不使用已经过期的浏览器票据。公开入口每次从验证结果覆盖账户 subject，客户端不能指定结算账户。
旧 `settleVoiceCredits` / `releaseVoiceCredits` RPC 暂保留用于服务版本兼容。部署顺序为
D1 migrations（包括 0070）→ Auth → Voice；旧版本留下的按时长任务仍按原规则完成。

`voice_credit_finalize_retry` / `voice_credit_finalize_pending` 日志表示任务仍需补偿，不代表已扣费
或已退款。补偿任务持久化重试次数与下次执行时间；失败从 10 秒指数退避到最多 5 分钟，状态异常
至少等待 60 秒，每轮最多处理 4 项。正在通话或建连时优先维护 deadline 与 checkpoint。

托管通话以 query 中的 conversationId/runId 携带已准备好的服务器会话及固定 callId。入口始终
清除客户端伪造的内部 `x-voice-conversation/run` 头，再转发声明给 Auth 预留。

## 过期冻结的终结（0044）

Auth 按余额计算相同的两小时有效期，在写账时检查冻结。过期冻结以同一事务写入
`voice_billing_reviews` 并释放，不再补扣；返回 `needs_review` 且 `charged: null` 后，
DO 删除对应补偿任务并停止重试。异常携带非空扣款值不会被视为成功。
