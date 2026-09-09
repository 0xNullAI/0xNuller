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
