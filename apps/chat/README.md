# 0xNuller Chat

中文 | [English](README.en.md)

基于 Cloudflare Durable Objects 的房间、公开大厅和私聊模块。成员明确授权后，房间还可以控制其
共享的设备。Chat 要求登录且邮箱已验证；浏览器和 Android 使用 Auth 签发的短期 admission ticket，
房间、公开目录和私聊会在 Worker 入口重新校验。

- 统一主站：<https://0xnullai.com/chat>
- 历史地址（跳转主站）：<https://chat.0xnullai.com>

## 功能

- 公开大厅、公开或私密房间、房间号与二维码邀请。
- 文字、图片和语音消息；媒体存储于 R2。
- 账户联系人和私聊；Chat 在统一主站中要求登录并验证邮箱。
- 成员设备共享、波形选择、强度调整和临时开火。
- 房主设置、房间 Agent 和场景支持。
- 桌面与移动端布局。

## 使用

1. 登录账户后打开 Chat。
2. 从侧边栏创建房间、加入房间或进入公开大厅。
3. 互相关注后，可从用户主页发起私聊；已有私聊显示在侧边栏。
4. 需要共享设备时，从顶部横栏连接设备，再在房间内明确授权。

## 设备控制与安全

设备操作必须由持有者授权，并在持有者设备上重新检查设备身份、连接状态、Chat 租约和安全策略。
离开房间、撤销授权、切换模块或停止输出都会结束相应控制。

房间 AI 看到的是当前授权的物理设备实例。即使显示名称相同，每个实例也有独立的临时目标 ID；
一次调用只能选择一个明确目标，不会按名称回退、选择主设备或广播。设备拓扑变化后，旧目标立即失效。

## 本地开发

在仓库根目录执行：

```bash
npm install
npm run dev -w 0xnullai-chat       # 前端
npm run cf:dev -w 0xnullai-chat    # Worker、DO 和本地存储
npm run test -w 0xnullai-chat
npm run build -w 0xnullai-chat
npm run types:check -w 0xnullai-chat
```

统一外壳开发使用 `npm run dev -w @0xnullai/web`。

## 代码结构

```text
src/components/       房间、消息、成员 UI；ChatAppView 只组合房间/大厅展示
src/hooks/            房间、设备和波形状态
src/lib/              WebSocket、媒体与客户端协议
worker/index.ts       HTTP 与 WebSocket 路由
worker/room-do.ts     房间和私聊状态
worker/lobby-do.ts    公开大厅
worker/media.ts       R2 媒体读写
```

`src/App.tsx` 负责认证、WebSocket 生命周期、设备持有者校验、租约和停止路径；
`src/components/ChatAppView.tsx` 只组合界面，不得改变设备命令或停止语义。

房间 Agent 与文字 Agent 共用 `@0xnullai/llm-providers` 配置和
`@dg-agent/agent-browser` 请求工厂。房间 prompt、@ 触发、有限工具循环和设备持有者侧授权仍由
Chat 负责，不要把它们并入本地 Agent 会话运行时。

媒体上传需要当前 WebSocket 会话签发的能力；仅知道房间号不能写入媒体桶。私聊票据由账户
服务签发，Chat 只接受有效票据。

## 部署

Chat 使用 `RoomDO`、`LobbyDO` 和共享的 `dg-chat-media` R2。旧域只保留到统一主站的永久跳转；
部署顺序、共享存储和密钥要求见 [部署文档](../../docs/deploy.md)。

## 协议

[MIT](../../LICENSE)
