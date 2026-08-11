# @dg-agent/storage-browser

Agent 浏览器持久化实现：IndexedDB 会话、设置、账户分区、远端合并与删除墓碑。未登录或
网络不可用时保持 local-first。

```ts
import { BrowserSessionStore, BrowserAppSettingsStore } from '@dg-agent/storage-browser';
```

第三方模型 API Key 仅保存在当前设备，不进入账户同步。
