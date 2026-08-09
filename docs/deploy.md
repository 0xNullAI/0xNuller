# 部署

统一外壳占据根域，四个后端 Worker 按**路径路由**接管各自的 API。

```
0xnullai.com/*                  → 0xnuller         纯静态，无 Worker 代码
0xnullai.com/api/auth/*         → 0xnullai-auth    D1
0xnullai.com/ws/*               → 0xnullai-chat    Durable Objects + R2
0xnullai.com/api/lobby/*        → 0xnullai-chat
0xnullai.com/api/upload/*       → 0xnullai-chat
0xnullai.com/api/media/*        → 0xnullai-chat
0xnullai.com/api/items*         → 0xnullai-market  D1 + R2
0xnullai.com/api/admin/*        → 0xnullai-market
0xnullai.com/api/realtime       → 0xnullai-voice   Durable Object（体验版计量）

llm.0xnullai.com                → 0xnullai-llm-proxy   免费 provider，独立子域
```

免费 provider 的代理留在自己的子域上：它不属于统一外壳的接口面，客户端用绝对地址
直连，挪进根域没有收益，只有风险。

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

**chat 必须排在 auth 前面**：auth 有一个指向 `0xnullai-chat` 的 service binding（拉黑时
推送私聊吊销），而绑定一个还不存在的脚本会让 auth 部署直接失败。

```bash
npm run build            # 全仓，各模块的 dist 都要在

# 1. 市场 —— 库已在线且有内容，不要重建
npm run deploy -w 0xnullai-market

# 2. 聊天（含 DO；已在线的话跳过创建，直接 deploy）
#    先于 auth，因为 auth 要绑定它
wrangler r2 bucket create dg-chat-media
wrangler secret put DM_TICKET_SECRET --config apps/chat/wrangler.jsonc
npm run deploy -w 0xnullai-chat

# 3. 账号服务 —— 库已建（ed58c339…，region ENAM）
wrangler d1 migrations apply 0xnullai-auth --remote  # 0005_dm_threads 是新增的
wrangler secret put IP_PEPPER        --config workers/auth/wrangler.jsonc
wrangler secret put DM_TICKET_SECRET --config workers/auth/wrangler.jsonc  # 与 chat 同值
npm run deploy -w @0xnullai/auth-worker

# 4. 体验版语音（含 DO）
wrangler secret put XAI_API_KEY --config apps/voice/wrangler.jsonc
wrangler secret put TRIAL_KEYS  --config apps/voice/wrangler.jsonc
npm run deploy -w 0xnullai-voice

# 5. 免费 provider（独立子域，和上面互不影响）
wrangler deploy --dry-run --config workers/llm-proxy/wrangler.toml
wrangler secret put PROXY_API_KEY --config workers/llm-proxy/wrangler.toml
npm run deploy -w 0xnullai-llm-proxy 2>/dev/null || \
  wrangler deploy --config workers/llm-proxy/wrangler.toml

# 6. 外壳——最后
npm run deploy -w @0xnullai/web
```

## Worker 改名的切换

`dg-market` / `dg-chat` / `dg-voice` / `dg-llm-proxy` / `dg-speech-proxy` 全部改成
`0xnullai-*`。**改名不是原地重命名**——部署会创建一个新脚本，旧的还在，而且路由仍
指向它。逐个切：

```bash
npm run deploy -w 0xnullai-market
curl -s https://0xnullai.com/api/items | head -c 200   # 确认新脚本接管了路由
wrangler delete --name dg-market                       # 确认无误后删旧脚本
# chat / voice 同样三步，用各自的路由做验证
```

**Secret 不跟着改名走。** Secret 是绑在脚本上的，新脚本一开始一个都没有。两个
proxy 尤其要小心，因为它们的 secret 就是它们能工作的全部理由：

```bash
wrangler secret put PROXY_API_KEY    --config workers/llm-proxy/wrangler.toml
wrangler secret put DASHSCOPE_API_KEY --config workers/speech-proxy/wrangler.toml
```

**顺序是「先部署新脚本 → 补 secret → 再把自定义域切过去」。** 反过来做，
`llm.0xnullai.com` 会指向一个没有 key 的脚本，免费 provider 当场全线 502——而那是
对用户的产品承诺，不是可降级的功能。切完先用一次真实请求验证，再删旧脚本。

（`0xnullai-speech-proxy` 是给别人自建用的模板，我们并不托管，所以它只是改个默认
名字，没有切换风险。）

**chat 与 voice 带 Durable Object，改名等于换一套新命名空间。** 这是刻意接受的：
当时房间还是临时的（最后一人离开 10 分钟后 RoomDO 自删消息、R2 媒体与 storage），
所以真正会丢的只有切换那一刻还开着的房间、公开讨论区的历史，以及体验额度重置一次。
**切换选在低峰时段**，并且接受公开讨论区从空开始。

D1 库名仍是 `dg-market`：绑定按 `database_id` 走，库名只在控制台里出现。改库名要新建
库再搬 44 条真实内容，为一个用户永远看不到的字符串冒数据风险不值得。R2 桶名同理，
`dg-chat-media` 不动——桶根本不能改名，只能新建再逐个对象搬。

**为什么必须现在改，而不是以后。** DO 命名空间按脚本名划分，wrangler 只有
new_classes / new_sqlite_classes / renamed_classes（同脚本内）/ deleted_classes，
没有跨脚本转移。所以改名的代价完全取决于那一刻 DO 里存着什么。改名时房间是临时的，
存的东西本来就会自己消失；等房间变成永久群组、承载长期聊天记录之后，同样一次改名
就是真正的数据丢失。**这是最后一个免费窗口。**

**窗口已经关闭。** 房间现在是永久群组：RoomDO 的自毁 alarm 没有了，消息、R2 媒体、
群主密钥哈希和公开设置都长期存在 DO 里。`0xnullai-chat` 这个脚本名从此不能再改，
RoomDO / LobbyDO 也不能挪进别的 script——两者都等于让所有群组变成访问不到的孤儿。

群组不会无限长：每个群保留最近 1000 条消息，被挤掉的消息连同它的 R2 对象一起删；
最后一人离开 10 分钟后 RoomDO 的 alarm 会把没有任何消息引用的对象扫掉（上传后没
发出去的附件走的就是这条路）。所以 R2 用量跟的是「在线群数 × 1000 条」，不是历史总量。

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
