# @dg-agent/agent-browser

浏览器端 Agent 组合层，负责把 Web Bluetooth、浏览器存储、语音、模型 provider 和运行时
装配为可直接供界面使用的客户端。

```ts
import { createBrowserAgentClient } from '@dg-agent/agent-browser';
```

Android 可通过注入原生连接能力复用同一组合层；安全与账户同步由各自共享包提供。
