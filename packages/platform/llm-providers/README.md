# @0xnullai/llm-providers

文本模型 provider 的共享目录、配置字段、默认端点和模型元数据，供 Agent、Chat 与统一设置
界面共同使用。

```ts
import { PROVIDER_DEFINITIONS, createProviderSettings } from '@0xnullai/llm-providers';
```

目录同时提供 Agent/Chat 与 Video 两个互不迁移、互不订阅的配置 profile；两者复用同一个
scoped store 骨架来处理校验、local/session key、同页通知和跨 tab 更新。Video profile 带版本号，
且仅接受明确列入图片输入清单的 provider/model 组合；产品账户不保存 AI API 凭据。

浏览器请求 client、dialect 分派、全局代理、模型发现与连接探测由
`@dg-agent/agent-browser` 统一组合。本包不依赖 provider SDK，也不负责 prompt、会话或工具循环。
