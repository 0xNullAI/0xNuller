# 部署

统一外壳占据根域，四个后端 Worker 按**路径路由**接管各自的 API。

```
0xnullai.com/*                  → 0xnuller       纯静态，无 Worker 代码
0xnullai.com/api/auth/*         → 0xnullai-auth  D1
0xnullai.com/ws/*               → dg-chat        Durable Objects + R2
0xnullai.com/api/lobby/*        → dg-chat
0xnullai.com/api/upload/*       → dg-chat
0xnullai.com/api/media/*        → dg-chat
0xnullai.com/api/items*         → dg-market      D1 + R2
0xnullai.com/api/admin/*        → dg-market
0xnullai.com/api/realtime       → dg-voice       Durable Object（体验版计量）

llm.0xnullai.com                → dg-llm-proxy   免费 provider，独立子域
```

免费 provider 的代理留在自己的子域上：它不属于统一外壳的接口面，客户端用绝对地址
直连，挪进根域没有收益，只有风险。

Cloudflare 按最长前缀匹配，所以更具体的路径优先于外壳的兜底。路径互不重叠，
`npm run check:routes` 会核对这一点——它**自动发现**仓库里所有 wrangler 配置，
新加 Worker 不需要改脚本。

## 为什么不合并成一个 Worker

**Durable Object 的 migration tag 按 Worker script 计。** 把 `RoomDO` / `LobbyDO`
搬进另一个 script 等于新建一组空的 DO——现有的所有房间和聊天历史会变成永远访问不到
的孤儿数据，且不可恢复。`dg-voice` 的 `TrialSession` 同理：搬走会让所有激活密钥的
用量计数归零，那是花钱的方向。

**同样不能改的是 script 的名字**（`dg-chat` / `dg-voice`）。名字只出现在 Cloudflare
控制台里，用户看不到，不值得为「去掉 DG」冒这个险。

这是唯一的原因。除此之外几个 script 合并没有任何障碍，将来如果 Cloudflare 提供了
跨 script 迁移 DO 的手段，可以再合。

## 首次部署

**顺序有讲究**：后端先上，外壳最后。反过来做的话，外壳一上线就把根域接管了，而它的
`/api/*` 还没有 Worker 接管——那些请求会落到静态资源服务上，返回 SPA 的 index.html，
前端拿到一坨 HTML 去 `JSON.parse`，报的错跟真正的原因毫无关系。

```bash
npm run build            # 全仓，四个 dist 都要在

# 1. 账号服务 —— 库已建（ed58c339…，region ENAM），migration 与 IP_PEPPER 都已就位
wrangler d1 migrations apply 0xnullai-auth --remote  # 只在新增 migration 后需要
npm run deploy -w @0xnullai/auth-worker

# 2. 市场 —— 库已在线且有内容，不要重建
npm run deploy -w dg-market

# 3. 聊天（含 DO；已在线的话跳过创建，直接 deploy）
wrangler r2 bucket create dg-chat-media
npm run deploy -w dg-chat

# 4. 体验版语音（含 DO）
wrangler secret put XAI_API_KEY --config apps/voice/wrangler.jsonc
wrangler secret put TRIAL_KEYS  --config apps/voice/wrangler.jsonc
npm run deploy -w dg-voice

# 5. 外壳——最后
npm run deploy -w @0xnullai/web
```

## dg-market 改名成 0xnullai-market 的切换

脚本名从 `dg-market` 改成了 `0xnullai-market`。**改名不是原地重命名**——部署会创建
一个新脚本，旧的那个还在，而且路由仍指向它。必须按顺序切：

```bash
npm run deploy -w dg-market                 # 以新名字部署，此时两个脚本并存
curl -s https://0xnullai.com/api/items | head -c 200   # 确认新脚本已接管路由
wrangler delete --name dg-market            # 确认无误后，删掉旧脚本
```

D1 库名仍是 `dg-market`：绑定按 `database_id` 走，库名只在控制台里出现。改库名要新
建库再搬 44 条内容，为一个用户永远看不到的字符串冒数据风险不值得。

**dg-chat 与 dg-voice 的脚本名不要动。** Durable Object 的命名空间按脚本名划分，而
wrangler 的 migration 只有 new_classes / new_sqlite_classes / renamed_classes（同脚本
内）/ deleted_classes——没有跨脚本转移。改名等于换一套全新 DO 实例：房间聊天记录
（RoomDO）、公开大厅（LobbyDO）、体验额度（TrialSession）全部变成不可达。命名不统一
是控制台里的观感，用户看不到；房间历史丢了用户第一眼就发现。

## 部署前必须确认的四件事

**1. `IP_PEPPER` 永不轮换。** 它参与登录限流记录的哈希，换了等于把所有限流记录作废，
攻击者只要等一次轮换就能重置自己的失败计数。

**2. `ALLOWED_ORIGINS` 必须包含根域。** 漏了的话 `me()` 会静默失败被当成未登录——
用户会看到「明明登录了却显示未登录」，而控制台里只有一条 CORS 警告。

**3. 两个 origin 白名单都要含根域**：`0xnullai-auth` 的 `ALLOWED_ORIGINS` 与
`dg-voice` 的 `TRIAL_ALLOWED_ORIGINS`。两者都必须包含 `http://tauri.localhost`
——那是安卓壳 WebView 的 origin，漏了的话手机上登录和体验版语音全部 403，而界面
只会显示「连接失败」。安卓没有热更新，这种错要重新打包才能修。

**4. 不要给任何 Worker 开 `run_worker_first: true`。** 那会让每个静态资源请求都变成
计费的 Worker 调用。免费额度是**账号级共享**的，一次 SPA 首屏约 10–30 个请求，
10 万/天换算下来只够几千次页面加载。更糟的是额度耗尽时 Cloudflare 返回 429 而不是
回退到资源服务——整站直接挂掉，直到 UTC 零点。

## 回滚

Worker 的部署是原子的，`wrangler rollback --config <配置>` 回到上一版。

**但 D1 的迁移不会回滚。** 上线前在预发数据库上跑一遍迁移，确认没有破坏性变更。

**DO 的存储也不会回滚。** RoomDO 的 schema 变更必须向后兼容——旧版本的 Worker 可能
在回滚后读到新版本写入的数据。

## 旧仓库下线

九个旧仓（DG-Kit / DG-Agent / DG-Chat / DG-Voice / DG-Market / DG-Web / DG-Wiki /
DG-MCP / DG-Playground）在迁移完成前**保持在线且自动化仍然是武装的**：DG-Kit 的
`release.yml` 在 push 时会 npm publish，几个应用的 Cloudflare Workers Builds 监听旧仓
且 push 即部署生产。

所以：**不要往旧仓推任何东西。**

下线顺序（每一步之间留出观察期）：

1. 关掉旧仓的 Workers Builds 集成 —— 否则它们会继续覆盖新部署
2. 停用旧仓的 GitHub Actions
3. 确认新部署稳定运行至少一周
4. Archive（不是 delete）旧仓，保留 issue 与 PR 历史
5. 确认没有外部引用后再考虑删除

**第 4 步之后就不可逆了。** Archive 可以撤销，delete 不能。npm 上的 `@dg-kit/*` 已发布
版本永远不能删——别人的 lockfile 指着它们。
