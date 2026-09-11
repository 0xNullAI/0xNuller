# 0xNuller Managed LLM Worker

这是 `https://llm.0xnullai.com` 的正式 Credit 模型入口。模型通过同一 Cloudflare 账号的 Workers AI binding 运行，不需要第三方 API Key；登录账户在请求前预留 Credit，成功后按实际 Token 结算，失败释放预留。自己的 API Key 不经过本 Worker，也不消耗 Credit。

生产脚本沿用 `dg-llm-proxy`。Workers AI、自定义域、日志、服务绑定、来源白名单、全局限流和关闭的 workers.dev/Preview URL 均由 `wrangler.toml` 管理。

平台公开三个稳定档位：基础、均衡和强力。真实 Cloudflare 模型 ID、能力和 Credit 价格只由 Worker 白名单决定，客户端不能指定任意模型或价格。三个档位均只开放文字和工具调用；Video 使用独立的视觉模型设置。

## 本地验证

```bash
npm test -w @0xnullai/llm-proxy-worker
npm run deploy:dry -w @0xnullai/llm-proxy-worker
```

部署前先应用 Auth D1 migration，随后依次部署 Auth 和本 Worker。完整顺序见[部署文档](../../docs/deploy.md)。

## 协议

[MIT](../../LICENSE)
