# @0xnullai/native

统一 Web UI 与 Tauri Android 外壳之间的能力注入边界。目前提供 Agent、Chat、Voice 和
Video 的原生蓝牙桥接上下文。

```tsx
import { NativeBridgeProvider, useNativeBridge } from '@0xnullai/native';
```

所有能力均为可选；独立模块环境会安全返回空桥接。统一外壳通过顶层 `deviceRuntime` 注入唯一的
共享设备运行时，供 Control、Agent、Voice 与 Video 绑定各自的 module id；各模块仍须独立收窄授权与模型能力。
