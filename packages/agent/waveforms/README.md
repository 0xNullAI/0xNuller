# @dg-agent/waveforms

Agent 波形库适配器，连接共享波形存储与 `@dg-kit/waveforms`，支持 `.pulse`、JSON 和 ZIP
导入。

```ts
import { BrowserWaveformLibrary } from '@dg-agent/waveforms';
```

自定义波形可随账户同步；内置波形只同步选择和隐藏偏好。
