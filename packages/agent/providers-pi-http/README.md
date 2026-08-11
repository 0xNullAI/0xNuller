# @dg-agent/providers-pi-http

基于 `@earendil-works/pi-ai` 的多 provider Agent 模型适配器，复用其模型目录、流式响应与
推理内容支持。

```ts
import { PiAiLlmClient } from '@dg-agent/providers-pi-http';
```

适用于需要多模型目录的浏览器构建；请通过配置注入 API Key。
