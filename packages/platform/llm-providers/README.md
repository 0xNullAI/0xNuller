# @0xnullai/llm-providers

文本模型 provider 的共享目录、配置字段、默认端点和模型元数据，供 Agent、Chat 与统一设置
界面共同使用。

```ts
import { PROVIDER_DEFINITIONS, createProviderSettings } from '@0xnullai/llm-providers';
```

目录同时提供互不迁移、互不订阅的 Agent/Chat 与 Video 本地配置存储。Video 配置带版本号，且仅接受明确列入图片输入清单的 provider/model 组合；产品账户不保存 AI API 凭据。
