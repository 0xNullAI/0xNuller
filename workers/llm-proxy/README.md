# 0xNuller Managed LLM Worker

这是 `https://llm.0xnullai.com` 的正式 Credit 模型入口。上游凭据只存在 Cloudflare secret 中；登录账户在请求前预留 Credit，成功后按上游实际 Token 结算，失败释放预留。自己的 API Key 不经过本 Worker，也不消耗 Credit。

生产脚本沿用 `dg-llm-proxy`，以保留已配置的上游 secret。自定义域、日志、服务绑定、来源白名单、全局限流和关闭的 workers.dev/Preview URL 均由 `wrangler.toml` 管理。

## 本地验证

```bash
npm test -w @0xnullai/llm-proxy-worker
npm run deploy:dry -w @0xnullai/llm-proxy-worker
```

部署前先应用 Auth D1 migration，随后依次部署 Auth 和本 Worker。完整顺序见[部署文档](../../docs/deploy.md)。

## 协议

[MIT](../../LICENSE)
