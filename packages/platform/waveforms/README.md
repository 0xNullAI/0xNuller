# @0xnullai/waveforms

全应用共享的自定义波形存储，负责旧 Agent/Chat/Voice 数据迁移、逐项校验、隐藏偏好和账户
同步。

```ts
import { listCustomWaveforms, saveCustomWaveform, subscribeWaveforms } from '@0xnullai/waveforms';
```

IndexedDB 是本地真源；损坏条目会单独跳过，不会清空整座波形库。

包内同时提供 `useWaveforms` 与 `.pulse`/Market 导入转换；Chat 和 Control 仅作为消费者，
不再互相借用功能应用内的 hook。
