# 0xNuller Auth Worker

统一主站的账户服务，提供注册、登录、资料、联系人、私聊入口、同步数据和账户角色。账户服务
不持有或控制蓝牙设备。

## 路由与存储

- 路由：`/api/auth/*`
- D1：账户、会话、资料、联系人、私聊索引、同步内容和角色
- R2：用户资料照片
- Service Binding：向 Chat 发送账户拥有的联系人与私聊事件

注册要求唯一用户名和唯一邮箱，并按来源哈希限制短时间批量建号。邮箱验证和密码找回令牌只以
SHA-256 哈希保存；浏览器使用同源安全 Cookie，原生外壳使用 Bearer 会话。Market 管理权限来自
账户角色，不使用共享的管理员口令。

生产账户已开通 Workers Paid，并在 Email Sending 中验证 `0xnullai.com`。Auth Worker 使用以下
绑定发送验证与密码找回邮件：

```jsonc
"send_email": [{
  "name": "EMAIL",
  "allowed_sender_addresses": ["no-reply@0xnullai.com"]
}]
```

本地未配置绑定时注册和登录保持可用，账户页会明确显示邮件服务待启用。

## 本地验证

在仓库根目录执行：

```bash
npm run typecheck -w @0xnullai/auth-worker
npm run test -w @0xnullai/auth-worker
npm run types:check -w @0xnullai/auth-worker
npm run db:migrate:local -w @0xnullai/auth-worker
```

## 数据迁移

迁移文件位于 `migrations/`，已发布迁移不可改写。生产迁移前必须先备份并执行只读预检；完整
顺序和回滚方式见 [部署文档](../../docs/deploy.md)。

## 部署

```bash
npm run deploy -w @0xnullai/auth-worker
```

生产部署前必须确认 D1、照片 R2、Chat service binding、允许来源与所需 secrets 均已配置。
secret 只通过 Wrangler 或 Cloudflare 控制台写入，不进入仓库。

## 协议

[MIT](../../LICENSE)
