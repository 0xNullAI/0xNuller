# 0xNuller Cloudflare 服务

0xNuller 6.0.0 使用 Cloudflare Workers、Durable Objects、D1、R2 与 Static Assets。每项服务
有独立配置和最小权限边界，统一通过主站的具体路径提供 API。

| 服务          | 目录                                       | 用途                             |
| ------------- | ------------------------------------------ | -------------------------------- |
| Web           | [`apps/web`](../apps/web/README.md)        | 主站 SPA 与静态资源              |
| Auth          | [`workers/auth`](./auth/README.md)         | 账户、资料、联系人、同步与角色   |
| Chat          | [`apps/chat`](../apps/chat/README.md)      | 房间、私聊、WebSocket 与媒体     |
| Market        | [`apps/market`](../apps/market/README.md)  | 场景和波形目录、账户所有权与审核 |
| Voice         | [`apps/voice`](../apps/voice/README.md)    | 实时语音会话                     |
| LLM Proxy     | [`workers/llm-proxy`](./llm-proxy)         | 托管文本模型中继                 |
| Legacy Compat | [`workers/legacy-compat`](./legacy-compat) | 旧域网页跳转与旧 API 代理        |
| Speech Proxy  | [`workers/speech-proxy`](./speech-proxy)   | 可选的自托管语音中继模板         |

## 本地验证

```bash
npm install
npm run check:routes
npm run verify:data
npm run typecheck
npm run test
npm run build
```

各服务的 Wrangler 配置位于自己的目录。生产发布使用版本上传、预览验证和显式流量切换；不要
把静态资源预览当作完整 API 预览，因为预览地址不会自动继承主域路径路由。

## 发布原则

- 先只读检查远端资源、迁移账本和绑定，再备份 D1。
- 按 [部署文档](../docs/deploy.md) 的依赖顺序迁移和部署。
- secrets 只写入 Cloudflare，不写入 Git、日志或文档。
- `agent.`、`voice.`、`chat.`、`market.` 与 `wiki.` 旧子域只保留永久跳转。
- 所有当前产品流量由 `0xnullai.com` 与 `www` 承载。

`workers/speech-proxy` 是用户自托管模板，不是共享生产服务。DG-Kit 与 DG-MCP 的对外迁移仍
等待单独确认。
