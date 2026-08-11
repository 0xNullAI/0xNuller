# @0xnullai/market-client

Market 的轻量共享客户端，读取波形、场景和多人场景，并记录导入下载。

```ts
import { fetchMarketItems, markMarketDownloaded } from '@0xnullai/market-client';
```

API 地址通过 `@0xnullai/settings` 解析，网页和 Android 使用同一实现。
