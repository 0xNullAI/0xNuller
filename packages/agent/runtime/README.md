# @dg-agent/runtime

与界面无关的 Agent 会话运行时：上下文策略、流式事件、工具调度、权限、安全限制、传感器
触发与会话持久化。调用方注入模型、设备、权限和存储实现。

```ts
import { AgentRuntime } from '@dg-agent/runtime';
```

设备命令仍由 `@dg-kit/safety` 与权限服务执行，本包不会因登录状态自动授予控制权。

运行时内部边界：`runtime-tool-executor.ts` 只编排权限、租约、事件、追踪与设备分发；
`device-tool-availability.ts` 负责纯设备目标解析和模型工具可见性；
`runtime-policy-resolution.ts` 负责 Coyote/Opossum 共用的有界 clamp 收敛，并在不收敛时拒绝执行。
