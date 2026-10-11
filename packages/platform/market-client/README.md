# @0xnullai/market-client

Market 的轻量共享客户端，读取波形与角色／场景卡，并记录导入下载。已下线的多人场景不再是可请求的类型，旧服务误返回时也不会作为当前公开卡提供给用户；历史文件导入由对应旧格式解析器处理。

```ts
import { fetchMarketItem, fetchMarketItems, markMarketDownloaded } from '@0xnullai/market-client';
```

API 地址通过 `@0xnullai/settings` 解析，网页和 Android 使用同一实现。
`fetchMarketItem` 按公开 ID 读取最新可见版本，供用户确认后更新自己的角色快照；
下架、编号不匹配或旧服务缺少版本号时不应用更新。

`parseMarketPortraitId` / `marketPortraitUrl` 仅接受 UUID 并生成本站头像路径，不接受外部 URL。
默认头像消费者应使用 `fetchPublicMarketPortrait(id, signal)`：匿名、no-store 读取，避免作者
登录权限使已下架头像继续显示为公开图；404/缺图/错误类型/读取失败返回 null，由视图回退 emoji。
Abort 保留取消语义。成功 Blob 的 object URL 由消费者创建并及时回收；不写入私人照片或本地缓存。
