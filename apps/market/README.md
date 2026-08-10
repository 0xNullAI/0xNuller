# DG-Market

0xNuller 社区市场：上传与交换 Agent 模块的**波形**和**场景**。

全免费栈：**Cloudflare Workers**（前端静态资源 + `/api` 接口）+ **D1**（SQLite）。
登录后可单条或批量上传，按来源限流（每小时 50 条），举报满 5 次自动隐藏。
上传内容归当前账户管理；后台权限使用账户角色，不再使用全局管理员口令。

**历史版**：[market.0xnullai.com](https://market.0xnullai.com) ｜ **统一主站**：[0xnullai.com](https://0xnullai.com)

## 技术栈

- 前端：React 19 + Vite，构建到 `dist/`，由 Workers Static Assets 托管
- 后端：单个 Worker（`src/worker/index.ts`），路由 `/api/items*`
- 存储：D1，单表 `items`（以 `migrations/` 为准，`schema.sql` 只是快照）
- 校验：`zod`（前后端共享 `src/shared/schema.ts`）

## 本地开发

```bash
npm install
npm run build           # 先构建前端到 dist/（Worker 需要 ASSETS）
npm run db:migrate:local              # 在本地 D1 从空库顺序应用 migrations
npm run preview         # wrangler dev：Worker + 静态资源一起跑
# 或仅调前端：npm run dev（/api 代理到 127.0.0.1:8787）
```

本地只需给来源限流设置独立 pepper：

```
MARKET_IP_PEPPER=独立随机值
```

## 部署到 Cloudflare

1. **创建 D1**：`wrangler d1 create dg-market`，把返回的 `database_id` 填进 `wrangler.jsonc`。
2. **先做只读迁移预检**：`npm run release:data:preflight -- --remote-readonly
--confirm=dg-market,0xnullai-auth`。当前生产库是 44 行 raw schema，migration 账本为空；
   schema、索引或历史数据不符合预期时，门禁会直接退出。
3. **只建立 migration ledger**：先备份，再对生产 Market 执行
   `scripts/bootstrap-market-migration-ledger.sql`。它不改任何 `items` 行或索引，
   只把已经存在的 `0000`/`0001` 记入 Wrangler 的标准账本。随后才可以运行
   `npm run db:migrate:remote`，让 Wrangler 只应用 `0002`/`0003`。
4. **上传未接流量的版本**：
   ```bash
   wrangler versions upload --config wrangler.jsonc \
     --secrets-file ~/.dg-keystores/0xnullai-market.env \
     --tag release-6.0.0 --preview-alias release-6-0-0
   ```
5. 验证 preview 后按 [统一部署顺序](../../docs/deploy.md)切换。兼容发布期间不启用 push 自动部署。

## 批量上传

登录后一次提交多条（最多 50）：把多条 JSON 放进一个数组 `POST /api/items/batch`，
或在前端「上传」弹窗点「📦 批量上传」，选一个 JSON 数组文件或含多个 `.json` 的 `.zip`。

```bash
curl -X POST https://<your-worker>.workers.dev/api/items/batch \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <账号会话>" \
  -d '[{"type":"scenario","name":"场景A","content":{"prompt":"…"}}, {"type":"scenario","name":"场景B","content":{"prompt":"…"}}]'
```

## 编辑与删除内容

编辑改的是元数据（名称/简介/昵称/图标/标签，空值清空）。内容所有者可以编辑和删除；
管理员账户可以处理历史未认领内容和举报内容。

```bash
# 编辑自己的内容
curl -X PATCH https://<your-worker>.workers.dev/api/items/<id> \
  -H "Content-Type: application/json" -H "Authorization: Bearer <账号会话>" \
  -d '{"name":"新名称","tags":["标签1","标签2"]}'

# 删除自己的内容（管理员账户也可用于内容治理）
curl -X DELETE https://<your-worker>.workers.dev/api/items/<id> \
  -H "Authorization: Bearer <账号会话>"
```

## 数据格式（与 0xNuller Agent 互通）

- **波形**：`{ name, description?, frames: [编码频率(10..240), 强度(0..100)][], pulse? }`
- **场景**：`{ name, icon?, prompt }`

0xNuller Agent 在「波形库 / 场景」面板提供「从市场导入」，直接拉取本站内容导入；也可下载/复制 JSON 手动导入。
