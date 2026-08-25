# @dg-agent/agent-browser

浏览器端 Agent 组合层，负责把 Web Bluetooth、浏览器存储、语音、模型 provider 和运行时
装配为可直接供界面使用的客户端。

```ts
import { createBrowserAgentClient } from '@dg-agent/agent-browser';
```

Android 可通过注入原生连接能力复用同一组合层；安全与账户同步由各自共享包提供。

`@dg-agent/agent-browser/llm` 的 `createBrowserLlmClient` 是 Agent、Chat 与 Video 共用的文本/视觉请求工厂；provider dialect、
免费代理账户头、全局 HTTP 代理和图片能力都在这里解析。`discoverBrowserProviderModels` 与
`testBrowserProviderConnection` 为统一设置提供同一套浏览器边界，设置页面不再自行分派 SDK。

通用设备经 `@0xnullai/device-runtime` 的 AI allowlist 与 schema adapter 注入。Agent 这里只将
共享定义适配到 runtime registry；权限、quota、trace 和 stop 顺序仍由 Agent runtime 执行。
