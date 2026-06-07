# DG-Market

社区市场：上传与交换 [DG-Agent](https://github.com/0xNullAI/DG-Agent) 的**波形**和**场景**。

全免费栈：**Cloudflare Workers**（前端静态资源 + `/api` 接口）+ **D1**（SQLite）。
匿名上传，Cloudflare Turnstile 人机验证，按来源限流（每小时 10 条），举报满 5 次自动隐藏，管理员口令可删除。

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

本地 Turnstile 用官方测试密钥即可（`wrangler.toml` 已填 `1x00000000000000000000AA`）。
机密在 `.dev.vars` 里设：

```
TURNSTILE_SECRET=1x0000000000000000000000000000000AA
ADMIN_KEY=任意本地口令
```

## 部署到 Cloudflare（GitHub 推送自动部署）

1. **创建 D1**：`wrangler d1 create dg-market`，把返回的 `database_id` 填进 `wrangler.toml`。
2. **初始化远程表**：`npm run db:init:remote`。
3. **创建真实 Turnstile 小组件**（Cloudflare 控制台 → Turnstile），把站点公钥填进 `wrangler.toml` 的 `TURNSTILE_SITE_KEY`。
4. **设置机密**：
   ```bash
   wrangler secret put TURNSTILE_SECRET   # Turnstile 私钥
   wrangler secret put ADMIN_KEY          # 管理员删除口令
   ```
5. **连接 GitHub 自动部署**：Cloudflare 控制台 → Workers & Pages → 选中本 Worker → Settings → Builds → Connect to Git，选择本仓库。
   - Build command：`npm run build`
   - Deploy command：`npx wrangler deploy`
   之后每次 `git push` 到生产分支即自动构建并部署。

> 也可手动一次性部署：`npm run deploy`。

## 管理员删除违规内容

```bash
curl -X DELETE https://<your-worker>.workers.dev/api/admin/items/<id> \
  -H "X-Admin-Key: <你的 ADMIN_KEY>"
```

## 数据格式（与 DG-Agent 互通）

- **波形**：`{ name, description?, frames: [编码频率(10..240), 强度(0..100)][], pulse? }`
- **场景**：`{ name, icon?, prompt }`

DG-Agent 在「波形库 / 场景」面板提供「从市场导入」，直接拉取本站内容导入；也可下载/复制 JSON 手动导入。
