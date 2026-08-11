# @0xnullai/llm-providers

文本模型 provider 的共享目录、配置字段、默认端点和模型元数据，供 Agent、Chat 与统一设置
界面共同使用。

```ts
import { PROVIDER_DEFINITIONS, createProviderSettings } from '@0xnullai/llm-providers';
```

目录不保存凭据；连接和 Key 生命周期由调用模块负责。
