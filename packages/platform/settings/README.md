# @0xnullai/settings

全应用设置基础层：API 地址、代理配置和设备安全上限。Control、Agent、Voice、Chat 与
Playground 读取同一份设备安全状态。

```ts
import { loadDeviceSafety, updateDeviceSafety, apiBaseUrl } from '@0xnullai/settings';
```

设备持有者一侧始终执行最终安全限制。
