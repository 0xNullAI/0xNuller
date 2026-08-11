# @dg-agent/providers-openai-http

OpenAI Responses 与 Chat Completions 兼容 HTTP provider，包含消息/工具序列化、流式解析和
严格参数支持。

```ts
import { OpenAiHttpLlmClient } from '@dg-agent/providers-openai-http';
```

支持 OpenAI 兼容端点；凭据只由调用方配置和保存。
