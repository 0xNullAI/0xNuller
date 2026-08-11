# @0xnullai/sync

账户同步客户端，覆盖设置、场景、波形、Chat 房间和 Agent 会话。所有写入 local-first，
未登录或离线时降级为空操作。

```ts
import { pullContent, pushContent, pullAgentSessions } from '@0xnullai/sync';
```

同步层会剥离已知凭据字段，不上传第三方 API Key。
