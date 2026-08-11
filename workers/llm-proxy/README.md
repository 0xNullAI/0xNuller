# 0xNuller LLM Proxy Worker

为统一 Web 的免费文本模型入口提供受限中继。上游凭据只存在 Cloudflare secret 中，不会进入
浏览器或仓库。

体验模型仅向已登录账户开放。Auth service binding 原子扣减每日文字请求额度；浏览器通过
同站 Cookie，Android 通过 Bearer 会话归属到同一个账户。自带 API Key 的模型不经过此额度。

部署前先应用 Auth D1 migration，再部署 Auth，最后部署本 Worker。服务绑定使未升级 Auth 时
代理安全失败为不可用，不会退回匿名消耗上游密钥。

## 本地验证

```bash
npm test -w @0xnullai/llm-proxy-worker
npm run deploy:dry -w @0xnullai/llm-proxy-worker
```

部署前确认上游 secret、允许来源、模型和全局限流绑定。完整顺序见
[部署文档](../../docs/deploy.md)。

## 协议

[MIT](../../LICENSE)
