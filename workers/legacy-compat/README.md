# Legacy Compat Worker

历史子域的永久入口。浏览器页面导航以 `308` 跳到统一主站模块；旧 API、WebSocket、静态资源和
其他非导航请求返回退役响应，不再依赖旧 Worker 或 Pages。

五个旧域由本 Worker 的 Custom Domain 或 Worker Route 维持 TLS、旧书签和搜索引擎跳转。跨域
浏览器数据迁移已结束；旧域不再执行脚本、读取存储或代理应用请求。
