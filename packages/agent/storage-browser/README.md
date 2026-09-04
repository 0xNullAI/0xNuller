# @dg-agent/storage-browser

Agent 浏览器持久化实现：IndexedDB 会话、设置、账户分区、远端合并与删除墓碑。未登录或
网络不可用时保持 local-first。

```ts
import { BrowserSessionStore, BrowserAppSettingsStore } from '@dg-agent/storage-browser';
```

第三方模型 API Key 仅保存在当前设备，不进入账户同步。

`BrowserDiagnosticStore` 将调用方已限制容量的诊断记录异步增量写入 IndexedDB，串行化写入和
删除。Agent 日志最多保留 100 条、256000 UTF-16 code units，单条大请求截断；开启诊断时才
加载和迁移旧 localStorage 日志，迁移保存成功后删除旧记录。保存失败通过共享设置警告反馈。
