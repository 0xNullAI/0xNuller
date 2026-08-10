# 0xNuller LLM Proxy Worker

为统一 Web 的免费文本模型入口提供受限中继。上游凭据只存在 Cloudflare secret 中，不会进入
浏览器或仓库。

该 Worker 在 6.0.0 兼容发布阶段只保留 `workers.dev` 入口，不接管旧 `llm.0xnullai.com`。

## 本地验证

```bash
npm test -w @0xnullai/llm-proxy-worker
npm run deploy:dry -w @0xnullai/llm-proxy-worker
```

部署前确认上游 secret、允许来源、模型和全局限流绑定。完整顺序见
[部署文档](../../docs/deploy.md)。

## 协议

[MIT](../../LICENSE)
