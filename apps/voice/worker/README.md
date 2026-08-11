# Voice Worker

`/api/realtime` 为登录账户提供实时语音体验。客户端先从 Auth 获取短期票据，随后通过
WebSocket 子协议提交；Worker 使用 Auth 服务绑定确认账户和每日额度，再由每账户一个
`TrialSession` Durable Object 限制并发、单次时长并转发至 xAI。上游密钥始终只存在于
Worker secret。

```text
客户端 → Auth 换取短期票据 → Voice Worker → TrialSession → xAI Realtime
```

默认限制：每账户每天 60 分钟、单次最多 20 分钟、同账户同时一通。额度记录在 Auth D1，
因此网页与 Android 共用；Durable Object 负责实时会话并发和强制结束。

配置：

- secret：`XAI_API_KEY`
- service binding：`AUTH` → `0xnullai-auth/AuthOwnershipService`
- `TRIAL_DISABLED=1` 可立即停止体验服务
- `TRIAL_ALLOWED_ORIGINS` 限制浏览器来源

本地联调需同时启动 Auth 与 Voice Worker并登录测试账户；单独运行 Vite 不提供体验接口。
