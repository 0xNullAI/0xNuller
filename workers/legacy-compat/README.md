# Legacy Compat Worker

历史子域的永久入口。浏览器页面导航以 `308` 跳到统一主站模块；旧 API、WebSocket、静态资源和
其他非导航请求返回退役响应，不再依赖旧 Worker 或 Pages。

Browser Migration 的 `.well-known` 路径始终转发到专用迁移 Worker。五个旧域由本 Worker 的
Custom Domain 长期维持 DNS、TLS、浏览器数据迁移和搜索引擎跳转。
