# @0xnullai/native

统一 Web UI 与 Tauri Android 外壳之间的能力注入边界。目前提供 Agent、Chat 和 Voice 的
原生蓝牙桥接上下文。

```tsx
import { NativeBridgeProvider, useNativeBridge } from '@0xnullai/native';
```

所有能力均为可选；网页环境会安全返回空桥接。
