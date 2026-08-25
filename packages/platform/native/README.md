# @0xnullai/native

统一 Web UI 与 Tauri Android 外壳之间的能力注入边界。目前提供 Agent、Chat、Voice 和
Video 的原生蓝牙桥接上下文。

```tsx
import { NativeBridgeProvider, useNativeBridge } from '@0xnullai/native';
```

所有能力均为可选；网页环境会安全返回空桥接。外壳还可通过 `deviceRuntime` 注入唯一的
`SharedDeviceRuntimeProvider`，各模块只绑定自己的 module id，不另建后端会话。
