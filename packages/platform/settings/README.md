# @0xnullai/settings

全应用设置基础层：API 地址、代理配置和设备安全上限。Control、Agent、Voice、Chat 与
Playground 读取同一份设备安全状态。

```ts
import {
  loadDeviceSafety,
  loadDeviceSafetySections,
  saveDeviceSafetySections,
} from '@0xnullai/settings';
```

设备持有者一侧始终执行最终安全限制。
`loadDeviceSafetySections`/`saveDeviceSafetySections` 提供 Coyote 与 Opossum 面板共用的分组契约，
避免 platform 测试或应用之间互相反向导入。

每台郊狼与负鼠还可以有自己的 A/B 通道上限（`loadDeviceLimits` / `updateDeviceLimit` /
`removeDeviceLimit` / `subscribeDeviceLimits`），按不透明的稳定设备键保存，跨重连与重启保留。
实际生效值为 `min(全局类型上限, 该设备上限)`，由设备持有者在每次写入时读取；单台设备的记录只能
更严，不能放宽全局上限。损坏的记录整条忽略（回到全局上限），数值钳制到 0..200；存储拒绝写入时
保留本次运行的值，避免刚调低的上限悄悄失效。设置页通过 `@0xnullai/device-runtime` 注册表的
`listDeviceLimits` / `setOwnLimits` 读写，而不是直接调用这些函数。

普通偏好通过 `readPreference` / `writePreference` 处理存储拒绝和配额不足；失败时保留本次
运行的内存值并发布可见警告。设备安全记录继续使用独立的保守失败路径，不使用此内存回退。

`publicPageUrl` 生成网页分享链接，原生 WebView 和本地开发地址使用主站域名，Web 保留当前站点域名。
