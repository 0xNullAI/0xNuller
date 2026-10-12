# @dg-agent/providers-openai-http

OpenAI Responses 与 Chat Completions 兼容 HTTP provider，包含消息/工具序列化、流式解析和
严格参数支持。

```ts
import { OpenAiHttpLlmClient } from '@dg-agent/providers-openai-http';
```

支持 OpenAI 兼容端点；凭据只由调用方配置和保存。

`attachPrivateConversation` 默认关闭。仅明确的私人账户Agent组合开启后，托管域请求才附带
当前 `LlmTurnInput.session.id` 与真实请求幂等ID作为账务关联；公共房间及BYOK不会泄露私人
会话标识给provider。此头不是会话权限或设备授权，仍由Auth验证归属。
