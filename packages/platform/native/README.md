# @0xnullai/native

统一 Web UI 与 Tauri Android 外壳之间的能力注入边界。目前提供 Agent、Chat、Voice 和
Video 的原生蓝牙桥接上下文。

```tsx
import { NativeBridgeProvider, useNativeBridge } from '@0xnullai/native';
```

所有能力均为可选；独立模块环境会安全返回空桥接。统一外壳在渲染前构建唯一的 `DgLabConnectionRegistry`
并通过 `dglab` 注入；各模块通过 `useDgLabRegistry()` 读取，不自行建立蓝牙连接。
