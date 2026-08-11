# @dg-agent/runtime

与界面无关的 Agent 会话运行时：上下文策略、流式事件、工具调度、权限、安全限制、传感器
触发与会话持久化。调用方注入模型、设备、权限和存储实现。

```ts
import { AgentRuntime } from '@dg-agent/runtime';
```

设备命令仍由 `@dg-kit/safety` 与权限服务执行，本包不会因登录状态自动授予控制权。
