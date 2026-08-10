# 部署

下面是目标拓扑：统一外壳占据根域，后端 Worker 按**路径路由**接管各自的 API。

```
0xnullai.com/*                  → 0xnuller         纯静态，无 Worker 代码
0xnullai.com/api/auth/*         → 0xnullai-auth    D1
0xnullai.com/ws/*               → 0xnullai-chat    Durable Objects + R2
0xnullai.com/api/lobby/*        → 0xnullai-chat
0xnullai.com/api/upload/*       → 0xnullai-chat
0xnullai.com/api/media/*        → 0xnullai-chat
0xnullai.com/api/items*         → 0xnullai-market  D1
0xnullai.com/api/realtime       → 0xnullai-voice   Durable Object（体验版计量）

llm.0xnullai.com                → dg-llm-proxy         兼容期继续使用旧服务
```

免费 provider 留在自己的子域上。兼容发布只替换根站，不切换这个自定义域。

## 当前外部状态（2026-08-10，部署后核对）

- `0xnullai-chat`、`0xnullai-auth`、`0xnullai-market` 已部署 6.0 后端；根域的 Chat、Auth、
  Market 路径路由已返回 JSON。`0xnullai-voice` 尚未部署，等待真实的 xAI 与体验密钥。
- Market D1 在迁移前已备份，44 条内容完整保留，ledger 现为 0000–0003；Auth D1 已从
  0001–0003 升到 0001–0009，当前仍是 0 个用户。`0xnullai-profile-photos` R2 已创建，
  `dg-chat-media` 保持原桶不变。
- `0xnuller` 统一外壳尚未接管根域；`https://0xnullai.com/` 仍由 `dg-web` Pages 提供。
  `dg-agent`、`dg-web`、`dg-wiki` 与其余旧 Pages/Worker/子域均未删除。
- `0xnullai-llm-proxy` 与 `0xnullai-speech-proxy` 未创建；`llm.0xnullai.com` 继续由旧
  `dg-llm-proxy` 提供服务。
- 根仓 auto-tag 与 npm release workflow 继续只允许手动触发。登录态、Voice、真机与主站
  切换验收完成前，不得恢复 push 触发或归档旧仓。

这段状态只能由下一次发布前的只读核对更新；配置文件描述的是目标，不能反推远端已经存在。

## 旧版本保留策略

统一站只替换 `0xnullai.com` 与 `www.0xnullai.com`。旧版 `agent.0xnullai.com`、
`voice.0xnullai.com`、`chat.0xnullai.com`、`market.0xnullai.com` 与
`wiki.0xnullai.com` 继续作为历史版本独立运行；不要删除它们的 Pages 项目、旧 Worker、
自定义域或 DNS。旧 GitHub 仓库归档前先关闭自动构建，归档只表示不再维护，不代表下线
历史站点。

Cloudflare 按最长前缀匹配，所以更具体的路径优先于外壳的兜底。路径互不重叠，
`npm run check:routes` 会核对这一点——它**自动发现**仓库里所有 wrangler 配置，
新加 Worker 不需要改脚本。

## 为什么不合并成一个 Worker

**Durable Object 的 migration tag 按 Worker script 计。** 把 `RoomDO` / `LobbyDO`
搬进另一个 script 等于新建一组空的 DO——现有的所有房间和聊天历史会变成永远访问不到
的孤儿数据，且不可恢复。`0xnullai-voice` 的 `TrialSession` 同理：搬走会让所有激活密钥的
用量计数归零，那是花钱的方向。

**同样不能改的是 script 的名字**（`0xnullai-chat` / `0xnullai-voice`）。名字只出现在 Cloudflare
控制台里，用户看不到，不值得为「去掉 DG」冒这个险。

这是唯一的原因。除此之外几个 script 合并没有任何障碍，将来如果 Cloudflare 提供了
跨 script 迁移 DO 的手段，可以再合。

## 首次部署

**顺序有讲究**：后端先上，外壳最后。反过来做的话，外壳一上线就把根域接管了，而它的
`/api/*` 还没有 Worker 接管——那些请求会落到静态资源服务上，返回 SPA 的 index.html，
前端拿到一坨 HTML 去 `JSON.parse`，报的错跟真正的原因毫无关系。

service binding 决定了固定顺序：chat → auth → market。Auth 指向 Chat（拉黑时
推送私聊吊销），Market 指向 Auth 的私有归属 RPC；绑定目标不存在会使部署失败。

```bash
npm run build            # 全仓，各模块的 dist 都要在
npm run verify:data      # 空库 + 真实升级形状，本地

# 只读生产门禁（不会 create/migrate/deploy）
npm run release:data:preflight -- --remote-readonly --confirm=dg-market,0xnullai-auth

# 先分别备份两个 D1。确认门禁输出 ok 后，Market 的 raw 库只补 migration ledger：
wrangler d1 execute dg-market --remote --config apps/market/wrangler.jsonc \
  --file scripts/bootstrap-market-migration-ledger.sql

# 此时 Market 只会执行 0002-0003；Auth 当前登记 0001-0003，只会执行 0004-0009。
wrangler d1 migrations apply dg-market --remote --config apps/market/wrangler.jsonc
wrangler d1 migrations apply 0xnullai-auth --remote --config workers/auth/wrangler.jsonc

# 新 Worker 不存在时 `wrangler secret put` 会失败，而且普通 secret put 会立即部署。
# 每个 Worker 使用仓库外、权限 600 的独立 env/JSON 文件，把代码和必需 secret 一次上传为
# 未接流量的版本；先验 preview URL，再用同一个 version tag 正式部署。不要把 secret 文件
# 放进仓库或把内容打印到日志。

# 1. 聊天（含 DO）——先创建目标版本，auth 的 service binding 才有稳定目标。
#    dg-chat-media 已存在；先用 `wrangler r2 bucket list` 核对，不要重复创建或换桶。
wrangler versions upload --config apps/chat/wrangler.jsonc \
  --secrets-file ~/.dg-keystores/0xnullai-chat.env \
  --tag release-6.0.0 --preview-alias release-6-0-0
# 验证 preview 后：
wrangler versions deploy --config apps/chat/wrangler.jsonc --version-tag release-6.0.0

# 2. 账号服务。照片 bucket 必须在 Worker 绑定它之前存在。
wrangler r2 bucket create 0xnullai-profile-photos
wrangler versions upload --config workers/auth/wrangler.jsonc \
  --secrets-file ~/.dg-keystores/0xnullai-auth.env \
  --tag release-6.0.0 --preview-alias release-6-0-0
wrangler versions deploy --config workers/auth/wrangler.jsonc --version-tag release-6.0.0

# 3. 市场。上传、编辑和管理都使用账户归属/角色，不再需要共享管理员口令。
wrangler versions upload --config apps/market/wrangler.jsonc \
  --secrets-file ~/.dg-keystores/0xnullai-market.env \
  --tag release-6.0.0 --preview-alias release-6-0-0
wrangler versions deploy --config apps/market/wrangler.jsonc --version-tag release-6.0.0

# 首位管理员先正常注册账号，再显式绑定角色。不要让“第一个注册者”自动成为管理员。
npm run account:role -- --remote-write --confirm=0xnullai-auth-account-role \
  --username=<已注册用户名> --role=admin

# 4. 体验版语音（含 DO）
wrangler versions upload --config apps/voice/wrangler.jsonc \
  --secrets-file ~/.dg-keystores/0xnullai-voice.env \
  --tag release-6.0.0 --preview-alias release-6-0-0
wrangler versions deploy --config apps/voice/wrangler.jsonc --version-tag release-6.0.0

# 5. 外壳——最后。先上传并验证 workers.dev preview；随后从 dg-web Pages 仅移除
#    0xnullai.com 自定义域，再正式部署 0xnuller。dg-web 项目本身与其他旧子域不删除。
npm run deploy -w @0xnullai/web
```

Chat 6.0 的媒体上传要求当前 WebSocket 下发的 `media-auth` capability；仅知道 room
code 不再有写 R2 的权限。这是有意的协议安全升级：旧客户端仍可聊天，但旧版媒体
上传会收到 403，必须升级客户端后才恢复附件上传。

## 新旧 Worker 并行

`0xnullai-chat`、`0xnullai-market` 与 `0xnullai-voice` 只接管新主站的路径路由；
`dg-chat`、`dg-market`、`dg-voice` 继续服务旧子域。不要删除或重绑旧 Worker。

Market 继续绑定原来的 `dg-market` D1，Chat 继续绑定原来的 `dg-chat-media` R2，因此
现有市场内容和媒体桶无需复制。Durable Object 无法跨 Worker script 搬迁：旧站的房间
留在旧 Worker，新主站从新的命名空间开始，两边互不覆盖。

`llm.0xnullai.com` 在兼容阶段继续由 `dg-llm-proxy` 提供服务；仓库里的新 proxy 只做
本地 dry-run，不上传、不切域。`0xnullai-speech-proxy` 是自建模板，本次也不部署。

## 免费 provider 的开销边界

`0xnullai-llm-proxy` 转发的是一把**付费**的上游 key，而免费 provider 是对用户的承诺，
不是可以随便关掉的功能。所以这里的失败模式不是「有人混进来」，而是「所有人被挡在外面」
——`src/guard.js` 里的每一道检查都是**配了才生效**，什么都不设时行为和以前完全一样。

上线时按顺序打开：

```bash
wrangler deploy --dry-run --config workers/llm-proxy/wrangler.toml   # 先验配置
wrangler secret put PROXY_API_KEY     --config workers/llm-proxy/wrangler.toml
wrangler secret put FREE_PROXY_SECRET --config workers/llm-proxy/wrangler.toml  # 可选
```

三点要知道：

**1. 签名是减速带，不是鉴权。** 客户端从安卓版上线起就在用 HMAC-SHA256 签
`X-DG-Timestamp`，而这个 Worker 以前**从来没读过那两个头**——签名是死的，比没有更糟，
因为在 code review 里它看起来像是保护。现在会验了，但密钥是打包进 APK 的，拆包的人可以
永远伪造。它真正挡住的是「有人发现了这个子域名，拿脚本对着打」，仅此而已。
**没带签名的请求仍然放行**：只有安卓版拿得到密钥，强制要求会把网页版的免费 provider
全部切断。带了但签错的才拒绝。

**2. `ALLOWED_ORIGINS` 不设就是 `*`。** 设了之后只回显名单内的来源。**没有 Origin 的
请求一律放行**——安卓 WebView 和任何非浏览器客户端都不发这个头，而浏览器无法隐藏自己的
Origin，所以这条只会放进本来就不受 CORS 约束的客户端，它们照样要过签名和限流。

**3. 没有 `RATE_LIMITER` 绑定时，限流几乎等于没有。** 兜底的是进程内的一张 Map，
Cloudflare 会跑很多 isolate、每个都有自己的一份，实际上限是「每分钟 N 条 × 当时热着的
isolate 数」。绑定还在 `unsafe` 下且 schema 变过，所以**先 `--dry-run`**。绑定缺失或
报错时代码会退回内存计数而不是直接 500——限流可以变弱，但不能变成一次故障。

## 部署前必须确认的四件事

**1. `IP_PEPPER` 永不轮换。** 它参与登录限流记录的哈希，换了等于把所有限流记录作废，
攻击者只要等一次轮换就能重置自己的失败计数。

值已经生成好了，存在仓库外的 `~/.dg-keystores/0xnullai-worker-secrets.txt`（`600`，
和 keystore 密码放在一起）。首次部署时：

```bash
wrangler secret put IP_PEPPER --config workers/auth/wrangler.jsonc
# 从上面那个文件里取值粘贴。不要生成新的——那就是一次轮换。
```

那个文件永远不进仓库。`.gitignore` 现在挡住了 `.env*` / `*.pem` / `*.key` / `*.jks`，
但真正的保障是密钥根本不在仓库目录下：误提交的密钥 push 之后就永远留在别人的 clone
和 GitHub 的对象库里，撤不回来。

**1b. `DM_TICKET_SECRET` 两个 Worker 同值，且同样永不轮换。** `0xnullai-auth` 用它签
私聊入场票，`0xnullai-chat` 用它验；两边不一致等于私聊完全打不开，而且报错只会是一句
「握手失败」。值已经生成好，和 `IP_PEPPER` 在同一个文件里：

```bash
wrangler secret put DM_TICKET_SECRET --config workers/auth/wrangler.jsonc
wrangler secret put DM_TICKET_SECRET --config apps/chat/wrangler.jsonc   # 同一个值
```

轮换它会同时作废所有在线的私聊连接和所有未过期的票。另外 `0xnullai-auth` 现在有一个
指向 `0xnullai-chat` 的 service binding（拉黑时推送吊销），所以**chat 必须先于 auth
部署**——绑定一个还不存在的脚本会让 auth 部署失败。

**2. `ALLOWED_ORIGINS` 必须包含根域。** 漏了的话 `me()` 会静默失败被当成未登录——
用户会看到「明明登录了却显示未登录」，而控制台里只有一条 CORS 警告。

**3. 两个 origin 白名单都要含根域**：`0xnullai-auth` 的 `ALLOWED_ORIGINS` 与
`0xnullai-voice` 的 `TRIAL_ALLOWED_ORIGINS`。两者都必须包含 `http://tauri.localhost`
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

## 旧仓库归档

九个旧仓（DG-Kit / DG-Agent / DG-Chat / DG-Voice / DG-Market / DG-Web / DG-Wiki /
DG-MCP / DG-Playground）在迁移完成前**保持在线且自动化仍然是武装的**：DG-Kit 的
`release.yml` 在 push 时会 npm publish，几个应用的 Cloudflare Workers Builds 监听旧仓
且 push 即部署生产。

所以：**不要往旧仓推任何东西。**

归档顺序（每一步之间留出观察期）：

1. 关掉旧仓的 Workers Builds 集成 —— 否则它们会继续覆盖新部署
2. 停用旧仓的 GitHub Actions
3. 确认新部署稳定运行至少一周，同时逐一确认历史子域仍返回旧版
4. Archive（不是 delete）已经完成文档与构建迁移的旧仓，保留 issue、PR、release 与 commit 历史
5. 保留旧 Pages/Worker 与子域；除非以后明确决定下线历史版本，否则不删除

DG-Kit 和 DG-MCP 的迁移与对外发布必须先确认，本轮不归档这两个仓。Archive 可以撤销，
delete 不能；npm 上已发布版本也不删除。
