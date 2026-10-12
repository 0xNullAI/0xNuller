# @0xnullai/llm-providers

模型配置的共享目录，只有两个 provider：`managed`（猫愿模型，按 Credit 计费）提供全部 AI 能力；
`custom`（自定义）是用户自带密钥的唯一入口，走一个 OpenAI 兼容接口，默认只发文字。

```ts
import { PROVIDER_DEFINITIONS, createProviderSettings } from '@0xnullai/llm-providers';
```

图片输入一律 fail-closed：`managed` 只有声明的 `vision` 模型接受图片；`custom` 只有用户在设置里
打开「支持图片输入」后才发送图片（Video 与图片附件共用 `supportsProviderImageInput`）。

目录同时提供 Agent/Chat 与 Video 两个互不迁移、互不订阅的配置 profile；两者复用同一个
scoped store 骨架来处理校验、local/session key、同页通知和跨 tab 更新。产品账户不保存 AI API 凭据。

旧版本保存的已移除 provider（qwen、deepseek、openai 等）在读取时由 `legacy-provider-migration.ts`
转为 `custom`，保留密钥与模型并填入该服务的 OpenAI 兼容地址；无法确定兼容地址的（Anthropic、
MiniMax 及未知 id）回到 `managed` 并丢弃密钥。迁移后图片输入为关闭状态。

浏览器请求 client、全局代理、模型发现与连接探测由 `@dg-agent/agent-browser` 统一组合。
本包不依赖 provider SDK，也不负责 prompt、会话或工具循环。
