# Browser Migration Worker

在历史 `agent`、`chat`、`voice`、`market` 与 `wiki` 子域提供受限的 `.well-known` iframe
端点。统一主站通过严格的 origin、window source、nonce 和字段白名单校验，把旧 origin 的
localStorage 与 IndexedDB 数据合并到 `0xnullai.com`。

端点不删除旧数据，也不迁移 Cookie、Bearer Token 或 sessionStorage。必须先部署本 Worker，
再部署主站和 Legacy Compat；确认迁移观察期结束前不得移除这些路由。
