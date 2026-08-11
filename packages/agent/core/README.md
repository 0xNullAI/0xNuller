# @dg-agent/core

Agent 的公共类型与运行时契约，包含会话、消息、模型、工具、存储和追踪接口，并重导出
`@dg-kit/core`。其他 Agent 包应依赖这里，不应反向依赖 UI。

```ts
import type { SessionSnapshot, LlmClient } from '@dg-agent/core';
```

浏览器、Node 和测试环境均可使用；本包不访问 DOM、网络或设备。
