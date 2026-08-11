# @dg-agent/client

Agent 应用与运行时之间的稳定客户端接口。`createEmbeddedAgentClient` 可把本地
`AgentRuntime` 包装为统一的会话、消息、设备和订阅 API。

```ts
import { createEmbeddedAgentClient } from '@dg-agent/client';
```

适合 UI、测试或未来远程适配器复用；不包含具体模型和蓝牙实现。
