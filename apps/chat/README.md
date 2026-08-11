# 0xNuller Chat

中文 | [English](README.en.md)

基于 Cloudflare Durable Objects 的房间、公开大厅和私聊模块，可在明确授权后远程控制房间
成员共享的设备。Chat 要求登录且邮箱已验证；浏览器和 Android 都先由 Auth 签发短期 admission
ticket，房间、公开目录和私聊在 Worker 入口再次校验，不能通过自定义客户端绕过。

- 统一主站：<https://0xnullai.com/chat>
- 历史独立版：<https://chat.0xnullai.com>

## 功能

- 公开大厅、公开或私密房间、房间号与二维码邀请。
- 文字、图片和语音消息；媒体存储于 R2。
- 账户联系人和私聊；Chat 在统一主站中要求登录并验证邮箱。
- 成员设备共享、波形选择、强度调整和临时开火。
- 房主设置、房间 Agent 和场景支持。
- 桌面与移动端布局。

房间中的设备操作必须由设备持有者授权，并经过持有者设备上的安全策略。离开房间、撤销授权、
切换模块或停止输出都会结束相应控制。

## 使用

1. 登录账户后打开 Chat。
2. 从侧边栏创建房间、加入房间或进入公开大厅。
3. 互相关注后，可从用户主页发起私聊；已有私聊显示在侧边栏。
4. 需要共享设备时，从顶部横栏连接设备，再在房间内明确授权。

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
src/components/       房间、消息、成员和设备 UI
src/hooks/            房间、设备和波形状态
src/lib/              WebSocket、媒体与客户端协议
worker/index.ts       HTTP 与 WebSocket 路由
worker/room-do.ts     房间和私聊状态
worker/lobby-do.ts    公开大厅
worker/media.ts       R2 媒体读写
```

媒体上传需要当前 WebSocket 会话签发的能力；仅知道房间号不能写入媒体桶。私聊票据由账户
服务签发，Chat 只接受有效票据。

## 部署

Chat 使用 `RoomDO`、`LobbyDO` 和 `dg-chat-media`。新主站的 `0xnullai-chat` Worker 与历史
`dg-chat` Worker 并行，旧子域不删除。部署顺序和密钥要求见 [部署文档](../../docs/deploy.md)。

## 协议

[MIT](../../LICENSE)
