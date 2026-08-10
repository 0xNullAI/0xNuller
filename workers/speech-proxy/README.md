# 0xNuller Speech Proxy Template

供用户自托管的实时语音 WebSocket 中继模板，不是 0xNuller 共享生产服务。调用方使用自己的
上游账户与凭据。

## 本地验证

```bash
npm run deploy:dry -w @0xnullai/speech-proxy-worker
```

部署前在自己的 Cloudflare 账户配置上游地址与凭据。不要把 secret 写入配置、文档或提交。

## 协议

[MIT](../../LICENSE)
