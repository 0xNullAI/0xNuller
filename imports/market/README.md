# DG-Market

社区市场：上传与交换 [DG-Agent](https://github.com/0xNullAI/DG-Agent) 的**波形**和**场景**。

全免费栈：**Cloudflare Workers**（前端静态资源 + `/api` 接口）+ **D1**（SQLite）。
匿名上传（单条 / 批量），按来源限流（每小时 50 条），举报满 5 次自动隐藏。
编辑：上传时可设「编辑口令」，之后改这条需对上口令；未设口令则公开可编辑。删除仍由管理员口令把关。

**在线**：[market.0xnullai.com](https://market.0xnullai.com) ｜ 官网 [0xnullai.com](https://0xnullai.com)

## 技术栈

- 前端：React 18 + Vite，构建到 `dist/`，由 Workers Static Assets 托管
- 后端：单个 Worker（`src/worker/index.ts`），路由 `/api/*`
- 存储：D1，单表 `items`（见 `schema.sql`）
- 校验：`zod`（前后端共享 `src/shared/schema.ts`）

## 本地开发

```bash
npm install
npm run build           # 先构建前端到 dist/（Worker 需要 ASSETS）
wrangler d1 create dg-market          # 创建本地/远程 D1，拿到 database_id 填进 wrangler.toml
npm run db:init                       # 初始化本地 D1 表结构
npm run preview         # wrangler dev：Worker + 静态资源一起跑
# 或仅调前端：npm run dev（/api 代理到 127.0.0.1:8787）
```

机密在 `.dev.vars` 里设：

```
ADMIN_KEY=任意本地口令
```

## 部署到 Cloudflare（GitHub 推送自动部署）

1. **创建 D1**：`wrangler d1 create dg-market`，把返回的 `database_id` 填进 `wrangler.toml`。
2. **初始化远程表**：`npm run db:init:remote`。
   - 若是从旧版本升级（库已存在），改跑一次性迁移补 `edit_key_hash` 列：`npm run db:migrate:remote`。
     **务必在部署新版 Worker 之前执行**，否则上传会因缺列而失败。
3. **设置机密**：
   ```bash
   wrangler secret put ADMIN_KEY          # 管理员删除口令，同时用作编辑口令哈希的 pepper
   ```
4. **连接 GitHub 自动部署**：Cloudflare 控制台 → Workers & Pages → 选中本 Worker → Settings → Builds → Connect to Git，选择本仓库。
   - Build command：`npm run build`
   - Deploy command：`npx wrangler deploy`
   之后每次 `git push` 到生产分支即自动构建并部署。

> 也可手动一次性部署：`npm run deploy`。

## 批量上传

一次提交多条（最多 50），无需人机验证：把多条 JSON 放进一个数组 `POST /api/items/batch`，
或在前端「上传」弹窗点「📦 批量上传」，选一个 JSON 数组文件或含多个 `.json` 的 `.zip`。
每条可选带 `"editKey":"…"` 设置该条的编辑口令（留空 / 不带则公开可编辑）。

```bash
curl -X POST https://<your-worker>.workers.dev/api/items/batch \
  -H "Content-Type: application/json" \
  -d '[{"type":"scenario","name":"场景A","content":{"prompt":"…"}}, {"type":"scenario","name":"场景B","editKey":"我的口令","content":{"prompt":"…"}}]'
```

## 编辑与删除内容

编辑改的是元数据（名称/简介/昵称/图标/标签，空值清空）。鉴权规则：

- 上传该条时**未设** `editKey` → 任何人都能编辑，无需口令。
- 上传该条时**设了** `editKey` → 编辑需带匹配的 `X-Edit-Key`。
- 管理员带 `X-Admin-Key: <ADMIN_KEY>` 可编辑任何条目（覆盖上述口令）。
- 删除始终只认管理员口令 `X-Admin-Key`。

```bash
# 编辑（条目设了口令时）
curl -X PATCH https://<your-worker>.workers.dev/api/items/<id> \
  -H "Content-Type: application/json" -H "X-Edit-Key: <上传时所设口令>" \
  -d '{"name":"新名称","tags":["标签1","标签2"]}'

# 编辑（管理员覆盖）
curl -X PATCH https://<your-worker>.workers.dev/api/items/<id> \
  -H "Content-Type: application/json" -H "X-Admin-Key: <你的 ADMIN_KEY>" \
  -d '{"name":"新名称"}'

# 删除（仅管理员）
curl -X DELETE https://<your-worker>.workers.dev/api/admin/items/<id> \
  -H "X-Admin-Key: <你的 ADMIN_KEY>"
```

## 数据格式（与 DG-Agent 互通）

- **波形**：`{ name, description?, frames: [编码频率(10..240), 强度(0..100)][], pulse? }`
- **场景**：`{ name, icon?, prompt }`

DG-Agent 在「波形库 / 场景」面板提供「从市场导入」，直接拉取本站内容导入；也可下载/复制 JSON 手动导入。
