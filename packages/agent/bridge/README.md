# @dg-agent/bridge

Agent 的外部消息桥接层，包含消息队列、权限服务以及 QQ、Telegram 等适配器契约。

```ts
import { BridgeManager } from '@dg-agent/bridge';
```

桥接消息进入与网页消息相同的运行时安全链路；接入方仍需自行配置平台 Token 和网络服务。
