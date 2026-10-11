# 0xNuller Auth Worker

统一主站的账户服务，提供注册、登录、资料、联系人、私聊入口、同步数据和账户角色。账户服务
不持有或控制蓝牙设备。

## 路由与存储

- 路由：`/api/auth/*`
- D1：账户、会话、资料、联系人、私聊索引、同步内容、角色和用户反馈
- R2：用户资料照片
- Service Binding：向 Chat 发送账户拥有的联系人与私聊事件

`GET /api/auth/users/:username` 和照片内容需要登录。主页资料、关注数对登录用户公开，
旧 `user_profiles.visibility` 值不再作为读取门禁，旧客户端提交该字段也会被忽略。
旧 `discoverable` 也不再作为发现列表门禁，未填写资料的新账号同样会出现；拉黑仍双向隐藏。相册照片保留逐张
`public/friends/private` 授权，尤其不自动公开旧私密照片；生日仍只给本人。
这一调整复用现有表和列，无需生产数据迁移。
主页链接只接受不含内嵌账号密码的 HTTP(S) 地址；读取旧资料时也会过滤异常链接。

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
用户反馈会先写入 D1，再尽力转发到维护邮箱；邮件临时失败不会丢失已保存内容。公开反馈接口按
来源哈希限制为每小时最多 5 次，不保存原始 IP。

管理面板将付费充值和 Credit 赠送分开记账。充值要求外部支付流水；赠送由系统生成唯一编号并要求
填写原因，不计入充值收入。两类人工入账都记录操作管理员并受单笔和每日上限约束。

## 本地验证

在仓库根目录执行：

```bash
npm run typecheck -w @0xnullai/auth-worker
npm run test -w @0xnullai/auth-worker
npm run types:check -w @0xnullai/auth-worker
npm run db:migrate:local -w @0xnullai/auth-worker
```

## 数据迁移

个人记忆使用 migration `0026_personal_memories.sql`，通过 `/api/auth/personal-memories`
读取、`PUT /api/auth/personal-memories/:id` 保存、`DELETE` 同路径删除。所有请求只作用于当前
登录账户，响应不缓存；保存和删除要求当前 `version`，创建使用 0。每账户最多 200 条，正文
最多 4000 字。删除清除标题和正文、保留版本墓碑防止旧请求复活；删除账户级联清除。
这是用户手工维护的私人内容，不属于公开资料、Market 或群聊，也尚未自动注入模型上下文。
上线账户页个人记忆前必须应用此附加迁移，不能修改已有迁移。

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

`0028_character_relationships.sql` 新增账号私有角色关系；`character-relationships.ts` 负责账户隔离、
同角色单活跃关系、版本 CAS 和删除墓碑。`GET /api/auth/character-relationships?characterId=...` 可过滤当前角色，
`GET/PUT/DELETE /api/auth/character-relationships/:id` 操作单条关系；PUT 的完整字段为
`version, characterId, aiNickname, userPreferredName, relationshipType, notes`。此数据不扩展公开内容或设备权限。

`0027_server_conversations.sql` 为 `/api/auth/conversations` 新建私有会话及消息表，采用服务器
revision CAS、消息编号合并与永久删除墓碑。GET 使用 `(updatedAt,id)` 游标避免同毫秒遗漏；
PUT/DELETE 要求 `expectedRevision`，创建为 0。设备状态、权限、工具调用和非白名单 metadata
不会恢复到云端会话。单次提交最多 2 MB、10,000 条消息。
`GET /api/auth/conversations/:id/messages?before=<sequence>&limit=20` 按服务端序号分页读取当前
账号未删除会话的消息，返回正序 `items`、下一页 `nextBefore`、当前 `revision`、单调
`lastSequence` 和实际保留的 `messageCount`，不聚合整段历史。取消摄像头观察会留下序号空洞，
完整恢复以 `messageCount` 核对，不能把最高序号当作现存消息数。旧版 PUT
仍有上述整段会话上限。`POST /:id/messages` 对现有会话按 `expectedRevision` 增量追加最多
20 条用户或助手消息，或单向延长已有助手消息正文；重复编号和内容一致时幂等返回，
缩短或改写会冲突，不聚合旧消息；单批次最多 256 KB。
`GET /:id?window=20` 只返回最近 20 条供语音和视频构建上下文；它们的字幕写回已使用增量追加。
`PUT /:id/relationship` 按版本绑定同一角色的私人关系，不重写长会话消息。
`0062_video_reply_staging.sql` 为视频问答加入独立的暂存表：`POST /:id/video-replies`
只暂存已保存用户提问的 AI 回复，普通会话读取、搜索、导出和 Memory 均不读取暂存表；
`PUT` 才把回复原子提交为普通助手消息，`DELETE` 只能取消尚未提交的回复，无法删除已提交
或已被其他端看到的内容。相同编号的迟到重试会被取消/已提交墓碑拒绝，服务端分钟任务将
超过十分钟仍未提交的正文清空为取消墓碑。墓碑按会话保留直到会话删除，以防旧请求复活。
`PUT /:id/metadata` 只允许更新标题和场景，响应不带消息正文。要兑现无限对话，
仍须让文字聊天和历史页面按需加载，并梳理新建会话与其他整段读取入口。

`0053_conversation_attachments.sql` 增加私人 AI 会话附件记录。`POST /api/auth/conversations/:id/attachments`
先保存并校验图片/语音对象，返回待提交附件；客户端确认账号和会话未切换后调用
`POST /api/auth/conversations/:id/attachments/:attachmentId/commit`，才生成用户消息。
`GET` 附件列表及 `.../:attachmentId/content` 每次校验登录账号与未删除会话，不发布 R2 对象地址。
独立备份使用至少 32 字符的 `AUTH_BACKUP_TOKEN`，由服务端 Secret 配置；
`POST /api/auth/backup/attachments/list` 按对象键分页枚举已提交附件，
`POST /api/auth/backup/attachments/content` 再次核对 D1 记录和 R2 大小后返回字节。
`POST /api/auth/backup/attachments/head` 只返回已提交对象的大小与 ETag，供导出后的
一致性复查。
这两个接口不接受普通登录凭据，客户端不得持有令牌；加密捕获与隔离演练见
[聊天备份](../../docs/chat-backup.md)。
图片仅接受净化后的 JPEG/PNG/WebP；语音仅接受容器签名匹配的 WebM/Ogg/MP4，尚无病毒扫描或
音频语义审核。附件本身不赋予 AI 视觉/听觉能力；无能力时只保存和回放。未提交对象 24 小时后
清理；会话/账号删除后通过持久化删除队列重试 R2 清理。摘要只显示 `[图片]`/`[语音]`。

`0064_voice_attachment_asr.sql` 为已提交的私人语音附件增加按需转写任务。用户先通过
`GET /api/auth/conversations/:id/attachments/:attachmentId/transcription` 看到报价，再明确同意
最高 Credit 与价格版本，才可 `POST`。服务端重新校验账号、会话与私有 R2 对象，仅支持
Opus 编码的 WebM/Ogg；现有可回放的 MP4 录音不进入自动识别。WebM 录音逐包改封装为
Ogg Opus（不解码、不重编码），同时按 Opus 包头计算时长；超过 5 分钟或无法解析的录音在
冻结 Credit 之前就被拒绝。录音经 WebSocket 发给豆包流式语音识别 2.0（输入流式模式
`bigmodel_nostream`），R2 对象不设公开 URL。服务端持有 `VOLC_SPEECH_API_KEY`，资源 ID 与
每小时 Credit 单价来自 `AI_PRICE_TABLE` 的 `asr` 路由；缺任一配置时入口显示未启用，不调用模型。
冻结按 5 分钟音频计，结算按服务商最终结果中的 `audio_info.duration`。
服务商结果仅作为私有待核对草稿，用户将其填入普通输入框并自行发送后，才成为聊天消息及
Memory 可读原文。连接中断、5xx 和缺少时长的结果保留冻结与 `needs_review`，不自动重试或
伪造文字；连接未建立或服务商明确拒绝（4xxxxxxx）时释放冻结。已持久化结果若结算失败由分钟
任务重试，冻结过期后不迟扣。管理员的只读 `/api/auth/admin/billing/asr-reconciliation` 和
设置页队列显示异常账务，不展示录音或转写正文，也不提供猜测性补扣。

当前钱包表旧 `usage_kind` CHECK 没有 ASR 枚举，转写预留暂以 `agent` 枚举承载，
`model_id=voice-asr`（更早的任务为 `qwen3-asr-flash`）、独立任务表与账本 metadata 标明 ASR；
这只是兼容桥接，后续扩展钱包枚举时须迁移所有引用该表的外键，不能直接重建既有账本。

`0065_managed_tts.sql` 为 Video 按需朗读增加平台 Credit 任务。`GET /api/auth/managed-tts`
返回托管报价（每万字符 Credit 与价格版本）；每条 `POST` 必须携带本次文本、唯一任务 ID、
确认的最高费用与价格版本，可选共享音色目录中的 `voice`。服务端限制 500 个 Unicode 码点，
最多按每码点 2 个计费字符预留，再以 HTTP Chunked 调用豆包语音合成 2.0
（`/api/v3/tts/unidirectional`，`X-Control-Require-Usage-Tokens-Return: *`）。`VOLC_SPEECH_API_KEY`
与有效的 `AI_PRICE_TABLE`（`tts` 路由）缺一则报价停用。分块返回的 MP3 直接校验后放进私有 R2；
浏览器仅从登录账户的 `GET /api/auth/managed-tts/:id/audio` 取音频，原文不写入 D1。
结算只用服务商最终对象中的 `usage.text_words`，成功任务的音频最多存 24 小时，账号删除与定期
任务清理。音频开始前被明确拒绝时释放预留；超时、流中断、缺少字符数或账务未确认时保留待核对
状态，不自动重新生成，不伪造字符数或追扣。持久的已确认字符用量由分钟任务补结算。
旧钱包 CHECK 暂以 `usage_kind=agent` 承载，`model_id=managed-tts`（更早的任务为
`cosyvoice-v3-flash`）、任务表和账本 `kind=tts` 区分朗读；这不把自带代理的使用记作平台 Credit。

`0056_conversation_digests.sql` 为私人角色会话增加独立的长对话概述、重试状态和单独默认关闭的
关系授权。用户在记忆设置中开启后，分钟任务才把该关系中较早的双方文字消息分批发送给火山方舟（见下文
「托管后台 AI」）；
最近 20 条保留原文。概述只用于同一会话的连续性，不变成已确认记忆或工具执行凭证。关闭授权
删除既有概述；来源改动、删除或角色身份变化使旧概述失效。此迁移尚需在部署前按数据迁移流程执行。
可选 `sceneId` 与角色的 `promptPresetId`、私人 `relationshipId` 分开保存在已有 metadata JSON 中；
清除场景时发送空字符串，避免部分更新保留旧值。这项会话字段扩展不需要新增 D1 迁移。

旧 `agent_sessions` 表及接口保留。新接口首次访问时逐条验证并惰性导入尚未迁移的 ID；坏记录在
列表 `migrationErrors` 中报告，原文仍留在旧表，不能静默删除。一个 ID 转由新 API 管理后，旧
客户端后续对同 ID 的改写/删除仍留在旧表，**不会覆盖新会话或复活新墓碑**。旧客户端可继续读取
旧表，但不能将旧同步端当作新版会话的协同编辑端；需要所有写入端升级后再统一迁移切换。新 API
暂不将变更双写回旧表，避免恢复整快照覆盖与设备权限元数据。

`0029_memory_scopes.sql` 为既有个人记忆增加账户/关系范围、长期/中期/关系历史层级、候选/确认状态、
来源会话与消息、到期时间和可空置信度；旧记录仍是账号范围的已确认长期记忆。默认个人记忆列表只返回
账号范围；`?scope=relationship&relationshipId=...` 返回当前账户的指定活跃关系记忆。
PUT 支持 `scope, relationshipId, tier, state`，来源只能由服务端产生；CAS 和删除墓碑保持不变。
中期条目在生成或用户确认/编辑后保留 30 天；长期和历史条目没有默认到期时间。
每日清理会抹去到期中期条目的标题与正文并保留版本墓碑，避免过期摘录继续占用每账户
200 条活跃记忆额度，也避免旧请求把已过期内容复活。

`POST /api/auth/memory-context` 接受 `conversationId` 和可选 `query`（最多 1000 字），核验服务器会话
绑定的私有角色关系后，返回近期消息、关键词相关的中期/长期/关系历史。只纳入确认且未过期记录；
同一响应的 `historyRecap` 还可按查询从更早的**同一会话用户原话**返回最多 6 条、每条最多
500 字的摘录及来源消息 ID。它只是本次读取时生成的上下文，不写成已确认记忆或替代服务器原文；
助手推测不会进入此层。消息修改/删除或会话删除后，下次读取不再返回旧摘录。没有匹配词时为空。
检索词会匹配较早用户消息的完整正文，返回内容仍限制为命中位置附近最多 500 字，避免长消息后段的
相关原话完全漏检，也不把整条长消息送入模型。
显式“小林”一类昵称会先在服务端原文中筛选，再取最近 48 条候选；避免大量较新的同主题、
不同人消息挤掉较早的指定人物原话。昵称必须仍出现在返回的摘录内，长消息中相距过远的
人物与事件不会被自动拼接或推断为同一事实。
有查询时先在 D1 按所有者、关系、账号开放设置、状态和到期时间筛选最多 200 条，再对获准记录做
本地中文双字片段与英文词匹配、有限的“小/阿＋一字”昵称字面匹配、词频加权和覆盖率重排，
同分按更新时间排序。
昵称门控不理解别名、真实人物身份或同名关系；无先行指代的“她”可能返回多条候选，调用方应追问。
`memory-context.retrieval.test.ts` 的 9 条合成、明确指代问题 Top1 从原排序的 4/9 到 9/9；
这不是线上准确率或泛化保证。已确认事实的检索路径仍是确定性关键词检索，没有语义向量搜索或额外读取时模型调用；
不会把私有记忆送给新的检索服务商。删除、过期与开放撤销仍由 D1 决定，检索排序不授予权限。
更广的 30 题匿名中文多会话诊断与当前缺口见[私人记忆检索评测](../../docs/memory-evaluation.md)；
9 题小样本不能代表别名、同名、否定、纠错或语义召回质量。
`0042_account_memory_access.sql` 使账号范围的记忆对每段 AI 聊天默认关闭。`GET/PUT
/api/auth/conversations/:id/memory-access` 仅允许拥有该已绑定私人关系的账号读取/按版本 CAS 更改；
开启后才把账号记忆加入该聊天的上下文，关系自身的记忆保持独立。读取上下文时复核会话修订和
开放设置版本；权限核验失败不回退加载全局记忆。真人私聊和群聊的逐会话共享仍需单独的成员权限契约。

`0046_human_memory_shares.sql` 为真人私聊与群聊增加独立的逐条共享授权，默认无授权。
`GET /api/auth/human-memory/conversations` 分页返回当前仍有权访问的聊天；`GET /shares`、
`PUT /shares/:memoryId` 和 `GET /received` 用 `kind=dm|group&id=...` 指定一段聊天。
PUT 需要授权 `version` 与原记忆 `memoryVersion`，仅可开放本人已确认、未删、未过期的账号范围记忆。
授权表只存 owner、聊天和记忆 ID，不复制正文；`GET /received` 以 `offset` 分页，接收者
每次读取时从权威记忆表投影标题、正文、
种类、版本和更新时间。删除与纠正会影响之后读取，关系范围记忆、候选内容和来源 AI 会话标识
不会给真人。所有接口需当前已验证邮箱的登录账号与匹配的 `X-Account-Id`，响应不缓存。
DM 每次复核当前双方线程、互相关注和 block；删除 DM 线程、取消任一方向关注会原子关闭旧授权，
重建聊天或重新关注不使之复活。群成员资格由 Auth 通过 Chat service binding 携带短期签名
`chat` 票据读取 RoomDO 权威成员状态，用户书签只用于候选列表；共享绑定群成员版本，退出、被移除、
恢复再加入后旧授权失效。已有阅读或复制无法从对方手里撤回。此接口不写 Chat 消息历史，
也不授权房间 AI 或真人访问 AI 聊天的 `account-memory-access`。
`POST /api/auth/memory-context/suggestions` 只从该会话最近消息产生可核对的用户原文摘录，以及用户明确
以“记住：”或“我们约定：”开头的候选。全部候选必须人工核对后确认，不从 AI 回复或角色扮演推断用户事实，
不伪造置信度。相同来源幂等，用户删除的来源候选不自动复活。SQL 触发器在源会话删除、源消息删改或关系
删除时清空关联内容并保留墓碑；写入再次核验来源与活跃关系，不能通过并发更新创建失效来源记录。

附加迁移 `0047_segmented_memory_sources.sql` 让同一次手动整理还可产生一条同一私人关系最近 2–3 段
聊天的中期分段原文候选。只选本人、已绑定该关系和角色卡、未删除会话中的用户消息，每段最多 2 条、
每条原文最多取前 300 字展示；这是抽取式摘录，不是抽象摘要或自动事实推断，也不调用新模型。
候选 `state=suggested`，确认前不进入模型上下文。`sourceRefs` 仅在本人记忆响应中给出会话和消息 ID；
真人共享仅可投影账号记忆的标题/正文，公开卡也不包含来源。来源索引只存 ID；写入时用 D1 中的
owner、关系、角色卡绑定、消息角色和完整原文逐条复核。任一来源消息删改、会话软删或关系重绑会清空
该候选正文并保留版本墓碑；原关系删除沿用 0029 的失效规则，账户删除通过外键级联清除索引。
候选删除或到期清理后也会移除反向来源索引，墓碑仍阻止旧来源集合复活。
同一来源集合删除后不会复活。中期候选保留原 30 天到期清理；跨会话候选到期后即使清理任务尚未执行也不能确认续期。
当前 UI 展示来源数量，尚不能逐条
跳转原消息。
同一会话较长时，整理接口还把离开最近 12 条短期窗口的用户消息按固定 8 条完整分段；
每次最多返回最近 3 个已完成分段。每条原文最多展示前 300 字，只处理原文长度 4–1000 字的
用户消息，未满 8 条的尾段留待下一次整理。候选依来源集合幂等，不收录助手消息，确认前不进入
模型上下文；确认后的摘录在模型上下文中单独标为“历史原话”，不作为核实过的事实。
源消息、关系或会话变更沿用 0047 的墓碑撤除。更旧的未整理内容仍可由查询相关的只读
`historyRecap` 从服务器原会话检索；它本身不是语义摘要，也不保证覆盖超出候选窗口的所有历史。
另有单独授权的同会话后台概述，可在来源与关系仍有效时作为不可靠的连续性资料返回，
不与这些经确认的记忆或原文摘录混为一谈。

`0048_memory_facts_people.sql` 增加关系内人物别名索引和原子事实的替换链。
`/api/auth/memory-people` 仅供本人管理当前活跃关系的人物，`/link` 用版本 CAS 把有效的已确认关系事实关联人物；
`DELETE /api/auth/memory-facts/:id/person` 可解除关联，保留事实正文和人物别名。
`POST /api/auth/memory-facts/:id/supersede` 要求同一关系内另有已确认的新事实，旧事实随后不再进入检索上下文。
`POST /api/auth/memory-facts/:id/correct` 可用旧事实版本及新 `kind/title/content` 一次提交手工更正；
服务端在同一事务中新建确认事实并停用旧事实，继承旧事实的私人范围、层级与人物关联，
不把旧来源消息伪装成更正内容的来源。旧来源或新事实后续删除都不会让旧事实复活。
查询命中重叠别名时优先更长的明确名称，例如“产品组张伟”不再同时命中仅叫“张伟”的其他人；
没有限定语的“张伟”仍可返回两个同名人物，分别询问两人也会保留两个候选。
所有接口复核账户、关系、有效期与版本；公开卡和真人聊天不继承私人关系别名。

`0037_auto_memory.sql` 增加关系级默认关闭的自动发现开关和后台提取队列。`GET/PUT
/api/auth/auto-memory/:relationshipId` 要求当前账号拥有该关系，PUT 使用版本 CAS；开启会将
该关系所有含用户消息的已有会话排队，随后新增用户消息经触发器排队；分钟 cron 每轮处理一段有界消息，关闭立即清除待处理任务与处理进度。
GET/PUT 响应还返回当前关系的待处理、重试和连续失败暂停的会话数量，不返回消息内容或其他关系的任务。
`0055_memory_extraction_progress.sql` 记录各会话的处理游标；分钟任务仅在方舟密钥与价格表都配置后
按原始顺序每次最多分析 16 条、每条最多 1000 字的用户消息，仍有内容时逐分钟续跑，
避免长聊天或两次定时任务间的消息突发被跳过。更正旧消息会回退游标重新核对，
更换关系则重置进度；不读取 AI 回复、群聊、工具或设备数据。
模型输出必须引用原消息 ID 和连续原文；向服务商发送前重查开关与任务租约，写入前再次核验账号、
关系、开关、消息原文与任务租约；200 条记忆额度已满时不会为无法保存的候选调用模型。
已在传输中的请求无法被另一 Worker 强制撤回。生成的
条目的展示标题与正文均取自所引用户原话，不使用模型改写，避免把否定句改写为相反事实。
条目永远是待核对候选，用户逐条确认才进入后续检索，删除墓碑不会被自动重建。

`0030_companion_schedules.sql` 提供账号/私人角色关系/会话绑定的定时消息与站内通知。
`GET /api/auth/companion-schedules?relationshipId=...` 列表；`PUT/DELETE /:id` 要求 `version`
CAS（创建 0），支持一次性本地日期或每周星期、本地 HH:mm、IANA 时区、安静时段、暂停与删除。
账号最多 50 项；消息最多 1000 字；每条规则设定账号滚动 24 小时发送阈值 1–3，两条发送至少
相隔 30 分钟，超过阈值顺延。安静时段内延期，夏令时不存在的一次性时间拒绝、每周跳过；重复
小时只取第一实例，不双发。当前版本发送用户明确设置的“定时消息”模板，0 Credit，无模型生成、
无 BYOK、无设备调用；不要将其描述为智能主动推理。
同一私人关系若用户尚未回复上次主动消息，会按连续未回复次数推迟至少 24、48、96 小时，
随后最多一周；关系下任何私人会话的新用户消息解除退避。生成模型前先检查，消息写入事务中
也复查最近 24 小时是否出现新的未回复主动消息，避免并发任务连续触达。

分钟 cron 每轮最多处理 20 项，发送声明、聊天消息、会话 revision、通知与任务推进在同一 D1
事务完成；幂等键按任务和本地 occurrence 组成，重叠 cron 不会重复发送。异常回滚后从一分钟
指数退避到一小时；会话或关系删除会暂停任务。关闭页面不影响后台执行。`GET
/api/auth/companion-notifications` 返回当前账号最近 100 条站内通知，`PUT /:id/read` 标记已读；
系统推送（FCM）已移除：用户多在国内，多数手机没有 Google 服务。新消息只以站内未读呈现。
旧版 Android 仍可能调用 `/api/auth/push/registrations`：注册返回 410，撤销返回 404（旧客户端视为
已撤销，不再重试），均不记错误日志。`push_registrations`／`push_deliveries`（0049、0057）保留在 D1
中但不再写入或发送；账号删除仍会清除该账号的旧注册。删表需另写迁移，并在不再有旧版 Auth 运行后进行。

Wrangler 源码增加 `* * * * *` 分钟触发，原 `17 4 * * *` 清理任务仍仅每日执行；尚未部署。
上线前应先迁移 0030，再部署 Auth 并确认 cron 实际注册、时区/DST 与通知链路。执行时使用当前
实际时间检查安静时段，不用延迟 cron 的旧 scheduledTime 推断用户是否允许接收。

`0031_agent_tasks.sql` 和 `agent-workspace.ts` 提供 `/api/auth/agent-tasks` 与
`/api/auth/conversation-files`；所有调用必须指定当前 `?conversationId=...`，由账号与服务器会话双重隔离。
任务 PUT 使用版本 CAS，最多 20 个步骤、每会话 100 个计划；计划状态不代表外部操作完成。
文件只接受 UTF-8 文本/Markdown，校验扩展名、MIME、编码、NUL 与 64 KiB 字节上限，每会话最多 20 个文件；
列表不包含正文，单条读取才返回文本。文件不可原地覆盖，删除保留墓碑。删除来源会话会清空计划及文件内容。

`0050_agent_runs.sql` 将实际 Agent 运行与可编辑计划分开；`0052_agent_run_owner.sql`
为运行增加一次性创建窗口执行权，需先迁移再部署依赖该列的 Worker。`POST /api/auth/agent-runs`
要求已存在的本人会话及唯一 `requestId`，返回服务端 `runId`；重复请求返回
`claimed: false`，不能据此重新执行。只有首次创建响应含 `ownerToken`，客户端仅在当前窗口内存持有；
同一会话已有 active 运行时，服务端原子拒绝新运行；刷新或切窗后不能以新的请求编号并行重放。
读取运行可跨端，领取新工具及结束运行必须提供该令牌。切号或刷新后不恢复执行权，已有运行留待核查，
不会用新 `callId` 在另一窗口重放。每个工具的 `callId` 只可领取一次，随后用领取令牌
上报结果；未上报、未知或待处理的调用会使运行进入 `needs_review`，30 分钟未更新的运行
由分钟任务标记待核查，绝不自动重放。读取、领取、结果与结束都必须绑定会话和账号。
Web Agent 将 `requestId` 用作发起该任务的用户消息 ID，便于跨窗口对照运行与聊天记录。
如果回复交付失败，客户端可以把已报告的终态保守降级为 `needs_review`，不能反向提升为完成。
这套记录来自浏览器，标为 `client-reported`，只用于保守去重及审计；不能据此声称服务器已验证
设备或外部服务确实完成操作。来源会话删除时，运行记录一并删除。

### 私人人物与关系生命周期（0032）

`/api/auth/companion-life?relationshipId=...` 列出人物、事件、共同经历与当前关系阶段；
`PUT/DELETE /:id` 使用版本 CAS。人物关联仅允许同账号、同关系的已保存人物，删除人物时
解除事件引用并增加版本；删除关系清空这些记录正文，旧客户端不能复活墓碑。
每段关系最多 200 条（保留一个关系阶段位置），单条正文 4000 字；日期为有效 YYYY-MM-DD。
阶段由用户编辑，暂停/结束会通过事务触发器暂停定时联系，调度提交与发送也再次校验阶段。
恢复关系不自动恢复旧定时消息。阶段不能单独删除绕过暂停，用户可明确改为重新联系。
这些是用户陈述，不是对第三方社交网络的抓取，也不会向群或公开角色卡投影。

Private appearance: migration `0034_character_appearance.sql` adds account/relationship-scoped
visual preferences without changing public cards. GET/PUT `/api/auth/character-appearance/:id`
require an active owned relationship; PUT `{photoId,scale:15..70,position,version}` uses CAS and
only accepts ready owned photos. Deleted source images resolve to null. No model/device permission
is granted by selecting an image. Apply the migration through the normal release process.

`0033_media_jobs.sql` 新增私人媒体后台任务；现在只提供图片，旧的情境自拍与视频任务仅保留为
历史记录。`GET /api/auth/media-capabilities` 返回唯一的 `image` 能力和报价；`GET /api/auth/media-jobs?conversationId=...`、`GET /:id` 读取任务，
列表按创建时间降序、同毫秒按 ID 升序返回最多 100 条，并以 `nextBefore` 提供下一页位置；
继续传 `before=<nextBefore>` 可读取长会话中更早的媒体任务，不遗漏同毫秒记录。
`PUT /:id` 以客户端稳定 ID 创建，正文为 `kind:'image',prompt,relationshipId,conversationId,
featureCharacter,acceptedCredits,priceVersion`（旧客户端的 `useConversationContext`、
`useCharacterContext` 仍可选）。同 ID 仅允许完全相同请求重放，不能覆盖。`kind:'video'` 返回
400「角色视频已下线」，`kind:'selfie'` 提示改用「让角色出镜」。
`DELETE /:id` 取消排队任务或删除终态资产；执行中需等待结果。全部接口要求当前账户
`X-Account-Id`，不缓存；`GET /:id/content` 也走认证。图片返回 `photoId`，沿用既有私有照片
及角色头像选择，最多60个照片槽。旧视频结果仍只从本人任务读取。对象均放在账户照片前缀，已有账户
删除流程会清理整个前缀。删除重试保留任务墓碑；已删除照片不会被任务内容接口重新展示。

图片由火山方舟 Seedream 生成（见下文「托管后台 AI」），模型与单张报价来自价格表的 `image`
路由，报价版本为 `ark-image:<表版本>:<Credit>`；缺密钥或价格表时 UI 明确禁用，不会使用用户
BYOK。请求固定单张、`b64_json` 返回、关闭水印，不依赖 24 小时过期的结果 URL。沿用
`credit_reservations` 的既有 `video` 类别（旧 CHECK 约束），`model_id` 为 `ark:<模型>`，账本
metadata 记录 kind、model 与 jobId，未重建余额表。创建和预留原子，私有资产保存后结算，失败
释放；每账户最多3个进行中任务。一分钟cron调用 `runMediaJobs`，每批3个、独占租约、失败退避
最多5分钟，一小时过期释放，不在重试期间重复POST。未完成的旧视频任务会被标为失败并释放冻结；
已保存的旧视频仍可查看。

图片base64直接清理元数据后保存。上游POST未提供幂等能力：提交超时/进程中断且无持久化结果时
标记 `submission_unknown` 并释放用户Credit，不自动重发（平台可能仍承担上游成本）。已持久化R2
结果可恢复结算。

附加 migration `0060_media_billing_reviews.sql` 为已落盘但账务不能安全终结的媒体留下账户隔离的审计记录。
R2 写入后若 D1 结算暂不可用，图片任务进入 `storing` 重试原预留的结算，不重新提交非幂等的
provider POST；已有结果先于一小时任务超时判断。若原冻结已超过严格两小时有效期，或同 key
预留/账本缺失、冲突、已释放或已结算但任务未交付，则不追加扣费、不展示资产，API 将该任务投影为
`needs_review`，统一 Credit 流水亦标为待核对。仅过期 pending 冻结会原子释放，避免迟扣已重新
可用的余额；账本冲突的仍有效冻结保留原状态。审计中的 R2 对象和相册占位不会由 cron 清理，
用户不能删除或预览，待运营核对后另行处理。附加 migration `0061_media_billing_review_notes.sql`
提供管理员审计备注。管理员以匹配的 `X-Account-Id` 访问
`GET /api/auth/admin/billing/media-reconciliation?before=<sequence>`，每页最多 30 条，查看任务、
预留和同 key 使用账本的当前证据；`POST /api/auth/admin/billing/media-reconciliation/notes`
提交 `{eventId,id,accountId,note,observed:{createdAt,jobUpdatedAt,reservationStatus,reservationUpdatedAt}}`。
备注需要当前观察版本并可按 eventId 幂等重试，最多返回最近 5 条；接口不提供媒体正文或下载地址。

运营核对时，先记录任务 ID、用户、冻结键、报价与状态，再独立检查对应 R2 对象、provider 任务结果、
预留状态以及 `credit_ledger` 是否存在**同账号、同冻结键、准确负金额**的唯一使用记录。
记录证据和处置决定为备注。当前没有自动解除审计、补扣、退款或交付入口；不能仅凭 R2 对象存在
或管理员备注就使资源可见。账务冲突、账号/关系已删除或证据不足时保持冻结并升级人工处理。
部署前先应用 0060、0061，再升级 Auth；未迁移的 Worker 请求会失败关闭。

「让角色出镜」（`featureCharacter:true`）取代了单独的情境自拍：同时发送当前账号已导入的
角色卡/场景快照、最近4条对话（最多450字符）和角色形象参考图。参考图优先使用本关系在
`character_appearances` 中选择的私人形象照片，其次是角色卡记录的已发布 Market 头像（经
`MARKET` Service Binding 匿名读取）；两者都没有时只用文字描述。角色卡引用前复核关系角色 ID、
会话角色 ID、当前场景 ID 和账号归属；找不到或类型不符即拒绝，不回退到公开 Market 最新版，
也不改变已接受报价及幂等键。参考图在执行时读取，不写入任务记录。卡片与图片只作为媒体视觉
参考，不授予设备或工具权限；私人 Memory、关系备注和朋友圈不自动发送。

`0035_companion_generations.sql` 增加真正的主动AI生成。原定时接口额外接受
`mode:'model',acceptedCredits,generationPriceVersion,contextConsent:true`，列表响应附带
`capability`（默认老请求仍为免费模板）。报价是价格表 `background` 路由下单条消息的上限
（最大输入与 1024 输出 token），版本为 `ark-proactive:<表版本>:<Credit>`；缺方舟密钥或价格表时
禁用，价格表版本变化自动暂停等待重新确认。成功后按实际 token 用量结算，不超过用户确认的上限。
用户在同一定时面板勾选AI模式并明确授权上下文与自动扣费，停止/暂停优先于发送，仍无任何设备工具。

经火山方舟（见下文「托管后台 AI」）生成，1024 输出 token 上限，不传tools。仅发送本角色关系资料、最近6条会话及
最多4条有效且已确认的关系记忆，整体参考资料最多8000字符；候选记忆、其他账户与其他关系
不会参与。只接收完整纯文本回答，剔除think块，不保存或展示推理字段，消息标明“AI主动消息”。
每个occurrence/version持久化生成结果，独占请求、每账户最多1个生成中，成功后与消息、通知和
原Credit账本扣费在同一个事务提交。通知事务失败可复用结果重试，避免再次付费调用；模型失败、
提交结果不明或10分钟中断会释放Credit并暂停，用户可重新启用。取消/删除后的补偿不依赖due列表，
原安静时段、每账号24小时上限和30分钟间隔均适用。模型请求结束再复查安静时段，最终SQL重查
关系、会话、版本、频率和预留状态；关系暂停/结束时不能投递。不存在智能猜测用户朋友圈的默认
后台采集。生成前再次验证定时规则和私人会话绑定；参考资料只取该会话最近的用户/助手消息、
本关系已确认记忆，以及用户手动保存的朋友与事件，不发送系统消息或其他账户的人物资料。
上下文为有上限的完整 JSON。此路径已通过本地SQLite并发/失败/隔离与UI授权测试，实际付费
provider验收仍未执行。

`GET /api/auth/conversations?summary=1` preserves normal pagination, migration diagnostics and
account isolation while returning only IDs/revisions/timestamps, public session metadata and at
most 160 characters of the latest user/assistant message. It does not materialize complete message
arrays. Deleted rows return empty metadata/preview for cross-device Inbox removal.

## 充值订单与对账（0036）

新增 `0036_billing_orders.sql`，只新增订单、事件、支付关联和退款申请，不重建既有钱包账本。
`GET /api/auth/billing/catalog` 返回沿用的4档人民币/Credit价格；`PUT /orders/:id` 使用
`packageId,priceVersion` 创建不可变待确认订单，客户端不能指定到账Credit或自行标记付款。
`GET /orders` 使用数字游标 `before` 分页，`POST /orders/:id/cancel` 需 `version`；
`POST /orders/:id/refund-request` 需 `version,reason`，仅记录本人充值退款申请，不发起转账。
每人最多5笔未过期待确认订单、订单24小时过期。所有账户请求固定 `X-Account-Id` 并禁止缓存。

在线支付明确未接通：`/api/auth/billing/webhook` 始终503，不接受浏览器跳转、未签名通知或
客户端声称付款。管理员在原管理界面新增的订单对账面板核对外部真实流水后，调用
`POST /api/auth/admin/billing/orders/:id/confirm-payment` 或 `/confirm-refund`，参数为
`paymentId,eventId,amountMinor,currency,confirmedExternalPayment:true`。只有未封禁管理员能处理。
`GET /api/auth/admin/billing/reconciliation` 提供最近100条实际处理事件与待核对原因。

内部 `applyVerifiedBillingEvent` 是未来已验证商户通知可复用的领域边界，目前只接受manual
管理员核实来源。事件ID+不可变载荷哈希防重放改写；原付款流水只能关联一个订单和一次到账。
新订单与旧人工充值共享流水命名空间、原管理员24小时200,000 Credit限额及原审计表，避免
同一收款又在旧界面重复入账。支付事件、关联、订单状态、Credit到账及审计在D1同事务提交。
金额/币种不符、迟到付款、旧流水复用或并发状态变化记录为needs_review，不能静默增加余额。

退款当前仅支持整单外部人工核实，订单申请不冻结Credit也不转现金。核实已实际退款后，只有
可用Credit足够（排除其它AI预留）才原子扣回并标记refunded，负数refund条目显示“退款扣回”。
已消费、被预留或其它差额进入人工对账，不制造负余额、不破坏活跃语音/媒体预留。管理员应
先核对余额与差额再到支付渠道处理退款；此面板并不保证或执行原路现金退回。创作者仍只取得
站内Credit，本功能不是创作者提现。账号删除沿用现有账本级联清除政策；商户上线前需要明确
支付凭证法定留存与账户删除的处理方式，不能默认把当前策略当作商户合规验收。

计费一致性补强：通用文字/视觉结算现在以事务中的pending状态作为写账条件，并返回实际最终
状态，避免release先完成后仍扣费。Market打赏也在同一事务校验扣除预留后的余额，只有真实
扣款成功才增加作者Credit，两个并发请求不能透支。统一账本区分主动AI、生成图片（含旧情境自拍）及退款扣回，
保留原语音、文字与生成媒体的同余额计费。BYOK费用不属于站内账本。

## 托管后台 AI

记忆候选提取、长对话概述、AI 主动消息和生成图片统一使用火山引擎方舟（`ark-client.ts`），
不再使用 MiniMax。需要两个 Worker 密钥：`VOLC_ARK_API_KEY` 与 `AI_PRICE_TABLE`（结构见
[`@0xnullai/ai-pricing`](../../packages/platform/ai-pricing/README.md)）。任一缺失或价格表无效时，
上述功能都按“未配置”关闭；仓库中不保存任何模型价格。

- 文字走方舟 OpenAI 兼容 `POST /api/v3/chat/completions`，模型取价格表 `background.model`，
  只在主模型失败后尝试 `background.fallbackModel`。请求总是带 `thinking:{type:'disabled'}`，
  不传工具，只接受 `finish_reason=stop` 的非空正文。
- 图片走 `POST /api/v3/images/generations`（Seedream），模型取 `image.model`。
- 每次调用把 feature、模型、token 数和按价格表折算的 Credit 记入 Worker 日志（`ark_usage`），
  不记录正文，便于核对成本。
- 记忆提取和长对话概述对所有账号免费（包括自带密钥用户），不预留也不写 Credit 账本；主动消息
  与生成图片沿用预留 → 执行 → 结算/释放账本。

## 账号删除与 Chat 撤销

账号删除先写入现有 `account_deletions` 标记，立即停止登录和新票据。标记保留 `dm_threads`
和旧服务器群书签，直到 Chat 确认撤销：Auth 使用专用短期签名令 Chat 写入永久账号墓碑，逐群
撤销有权威索引的成员与旧书签提示，再逐条确认已知私聊的撤销。任一服务失败都返回 202 并保留
数据库账号作为可重试任务；只有全部确认后才删除照片前缀与账户行。失败任务在分钟 cron 按
1 分钟至 1 小时退避重试，每日维护仍会兜底。删除请求的签名仅经 Auth→Chat service binding
发送，不会交给浏览器。

这条链路撤销服务器访问，不负责删改其他参与者的共享聊天正文，也不能凭旧本地书签枚举所有
历史休眠群。新 Chat 绑定和 Durable Object 迁移必须与 Auth 改动一起部署；上线前须验证失败
重试、旧票据、跨服务顺序及共享内容的保留政策。详见
[Chat 撤销边界](../../apps/chat/README.md#account-deletion-revocation-registry-additive-rollout)。

上线前尚需产品/运营选择商户（例如适用地区的微信/支付宝、Stripe或其它），提供测试商户配置、
结算主体/币种、退款规则及回调域名。随后实现对应官方checkout、签名验签、主动查单、退款API、
完整账单下载对账与真实沙盒验收，再启用在线支付。当前未调用付款/退款API、未使用生产凭据，
不能将此订单与人工对账底座描述为已完成真实支付。

Market 可信作者通过 `public-market-creator.ts` 读取已验证作品归属；RPC 仅输出账户公开 ID、用户名与显示名，
不读取私人对话/记忆。按查看者查询作者作品时也排除双向拉黑。封禁或注销处理中账户不会出现在映射中。Market 仍负责作品是否公开可见，
可编辑署名字段不参与身份判定；账户改名保持同一个关注身份。
在线角色草稿保存在 Auth `0038_character_drafts.sql` 的私有表，经现有会话验证后按账户隔离，
以 CAS 版本避免跨端覆盖；已发布角色草稿还需已验证的 Market 条目归属。账号删除时外键级联清除草稿，
公开 Market 只保存已发布卡及其公开版本。
`PUT /api/auth/character-relationships/ensure` 为当前账号和所选卡幂等建立私人实体，空称呼沿用公开名称；
已主动删除的关系不会因重新打开聊天而自动复活，用户仍可在设置中显式新建。

## 文字账务恢复（0039）

`text-billing-outbox.ts` 复用现有预留/账本与分钟 cron；migration0039 仅新增表和索引，旧 RPC、
旧预留及费率保留。新 `reserveManagedTextCredits` 仅接受文字白名单模型，验证账户并完成
原预留后登记任务；任务登记成功才允许代理启动生成。随机 capability 仅返回内部服务，
`checkpointManagedText` / `inspectManagedText` / `finalizeManagedText` 不要求持有浏览器凭据，
不作为公开 HTTP API，不允许由客户端指定结算账户。后台不调用 provider、不保存聊天正文。

确认 usage checkpoint 与终结决策持久化；结算账本、冻结终态、任务终态同事务更新，重复结算
使用原 reservation key。10 分钟没有心跳或 checkpoint 的任务由 cron 恢复，每轮20项、失败退避
30秒至5分钟。已知用量结算；无用量或超过原2小时冻结期限标记 needs_review 后释放，不估算
扣费、不迟扣可能已经花出的余额。needs_review 保存在表中，运营处理页面仍待实现。
任务登记失败会释放刚验证账户的新预留；若进程在登记前宕机或数据库连释放也失败，则预留
仍可能保留到原TTL。以 `Text billing registration cleanup deferred` 日志及无对应outbox的预留
核对，确认没有运行中的旧代理请求后才能人工释放；不能批量释放全部无outbox的旧版预留。
部署前顺序为 migration0039 → Auth → LLM proxy，分钟 cron 配置已存在，无新云资源。

运行期间代理每分钟持久化心跳，心跳 RPC 3 秒内未确认则中止后续转发与交付；未知用量保留
任务待核对，不宣称释放成功。心跳不刷新原预留的2小时TTL，过期会拒绝续约。

## 文字对账运营记录（0040）

`GET /api/auth/admin/billing/text-reconciliation` 以稳定 rowid 游标 `before` 每页30条列出
pending、needs_review 及已有人工记录的任务；明确投影账户/模型/预留/确认费用/实际扣费、
用量计数及最近5条备注，不返回 capability 或原始 metadata。所有请求禁止缓存，需要未封禁
管理员及匹配的 X-Account-Id，其他账户角色不能读取或写入。

`POST .../notes` 接受 `id,eventId,note,observed:{state,status,updatedAt,confirmedCharge}`。
0040仅新增不可变审计表及索引；事件ID与操作员/任务/备注/观察状态的哈希保证幂等，冲突返回409，
写入时再次检查管理权限与所见状态。记录管理员、时间、原观察状态，不改变任务、冻结或账本。
自动恢复完成后已有备注仍可查看；备注并不表示财务已修复。记录按现有账户删除策略随任务清除。

未知用量、冻结已过期及相反账本终态不能通过此面板猜扣款；确认用量仍由0039后台恢复。
当前未提供人工强制结算、退还或释放入口，避免管理操作侵占活跃请求或已消费余额。

AI conversation inbox (migration 0041): `GET /api/auth/conversations?summary=1&order=recent`
returns `lastMessageAt` (server acceptance time, nullable for historical/empty conversations),
`lastSequence`, `readSequence` and `unread`. Read state begins unknown (`null`); unread counts
assistant messages after the acknowledged sequence, not user/system messages. Message inserts
allocate monotonic per-conversation sequences in SQL, including scheduler writes; streaming
content appends and metadata edits do not create messages or move inbox timestamps. Legacy
lazy imports allocate sequences but do not invent acceptance timestamps. Recent pagination
uses descending acceptance time and ascending ID; concurrent activity can move rows across
pages, so refresh the first page to discover activity during pagination.

`PUT /api/auth/conversations/:id/read {sequence}` requires the matching `X-Account-Id`,
rejects future sequences/deleted or foreign conversations, and atomically advances with MAX.
It does not mutate conversation revision or resurrect tombstones. The unified inbox offers
explicit mark-as-read; automatic acknowledgement on visible Agent rendering is not implemented.
Group/DM unread remains outside this API and is still unknown without its own server read cursor.

`GET /api/auth/credits/activity?view=timeline` 为新版单一账户消费时间线，原无view接口兼容保留。
以原预留key归并usage账本，保留pending/released/过期及无预留的旧账本；不把预留显示成扣款。
按预留创建时间（独立账本按记账时间）及稳定ID分页，cursor可跨同毫秒记录，状态变更不改变ID。
只读owner-scoped联查media_jobs取得真实任务/关系/会话；新主动generation从预留时的
`reservation_context` 快照取得会话及关系，保留计划ID；旧记录不借当前可编辑的计划倒推。
群聊 @AI 从 Chat 签名票据写入不可变的房间、触发消息和角色快照，不把房间编号冒充私人会话。
文字/Voice现有记录缺少会话关联时返回null，不倒推。
只返回状态白名单异常，不返回provider错误原文、prompt、capability或资产路径。需要账号固定
头，响应no-store。此视图不改变余额、预留TTL或任何价格；群聊快照需要Auth 0063 migration。

## 消费会话快照（0043）

新增 `reservation_context` 保存真实预留的账户、conversationId、runId 和当时会话的relationshipId。
`reserveManagedTextCredits` 的可选 `context` 与 `reserveVoiceCredits` 第4参数均是
`{conversationId,runId}`；Auth验证当前账户拥有且未删除的服务器会话，预留创建后写入不可覆盖
快照，成功才返回上游调用授权。重复key不补写或替换关联；新预留的快照写失败则释放该账户hold，
若连清理数据库也不可用，原TTL仍适用。关联只用于财务归属，不提供设备或记忆访问权限。

旧调用缺context保留unknown，不能借当前设置重建历史。Agent 私聊有服务器 TaskRun 时，文字
`runId` 关联该任务；同一任务中的每次 provider 请求仍使用各自的 Idempotency-Key 独立预留和结算。
尚无 TaskRun 的旧文字调用保留每次请求的 Idempotency-Key 作为 `runId`；Voice runId 与通话字幕
History 的 callId 一致。此关联方便账务归集，不把客户端 TaskRun 收据变成服务端执行证明。
流水从快照读取新文字/Voice关联，旧媒体仍读取其原任务事实。迁移0043与Auth先于新客户端部署；
原订单、价格、余额及结算RPC不变。新context被拒绝时不启动provider，无生产调用或部署。
主动AI消息在创建预留的D1事务中写同类快照，后续计划更改或删除不改变原账务归属。
群聊 @AI 使用独立 `0063_group_ai_reservation_context.sql`，仅接受Auth验证过的Chat签名票据；
快照保存失败即释放新冻结，不开始模型请求。旧群聊消费不补猜历史关联。

## Voice 过期冻结审计（0044，未部署）

`finalizeVoiceReservation` 在账务写入时，以余额相同的严格两小时 TTL 检查冻结。
过期 pending 预留同事务写 `voice_billing_reviews` 并改 released，不插入扣费账本；
重复/并发请求返回 `needs_review`、`charged: null`。请求时间与数据库当前时间取较晚值，
避免排队的旧 RPC 在冻结已被余额重新使用后迟扣。事务失败保留原状态以便重试。
有效期内已结算记录仍返回原扣款，之后到期不会改写历史。

账户设置的统一流水显示“语音冻结已过期，已转人工核对；未追加扣费”，状态为已释放、
实际扣款为空。管理页的 Voice 审核队列与文字队列并列显示（0045）；运营也可只读查询 D1
`voice_billing_reviews`，按 `created_at, reservation_key` 排序，并用 `user_id` 与
`reservation_key` 联查 `credit_reservations` / `credit_ledger`。`observed_duration_ms`
是提交的确认时长，`requested_credits` 是请求报价而非实扣，`reason` 说明过期原因；
不能用该报价直接追扣。本批未开放人工强制结算或消除审计记录的入口。
先迁移 0044，再升级 Auth 与 Voice Worker；缺迁移时失败关闭。未部署、未调用真实支付。

兼容旧 `settleVoiceCredits` 和通用 `settleCredits` 的 Voice 预留也委派同一终结域；
旧返回契约把 needs_review 映射为 released/charged:null，完整原因仍保留审计和流水。
不接受调用者任意提供的扣费数字。

## Voice 按用量结算（0070）

新版 Voice Worker 在 `finalizeVoiceReservation` 中提交逐轮累计的服务商用量（输入/缓存/输出的
文本与音频 token）、已上报轮数与缺失轮数。Auth 以 `AI_PRICE_TABLE` 的 `realtime` 路由计价并封顶于
冻结额度，价格版本记为 `realtime:<表版本>`，账本 metadata 保存模型、用量与轮数；没有可计费用量时
释放冻结。缺价格表时返回 `rejected`，由 Worker 稍后重试，不按默认价扣费。存在未上报用量的轮次、
或用量超出冻结时，只扣已上报部分（封顶），并在同一事务写入 `voice_usage_reviews`；
`GET /api/auth/admin/billing/voice-reconciliation` 的首页同时返回 `usageItems` 供运营只读核对。
不带用量的旧版本任务仍按原确认时长规则完成。0070 只新增表，旧代码不读写它。

## Voice 审核备注（0045，未部署）

`GET /api/auth/admin/billing/voice-reconciliation` 返回过期 Voice 审计记录与当前预留状态，
支持精确 `accountId`、包含边界的 `from`/`to` 毫秒筛选和 `before` 序号分页，每页30条。
同毫秒记录按行序号稳定分页。查询无缓存，只返回时长、报价、实扣、价格版本与最近5条备注，
不含通话内容。所有接口均验证活跃管理员与固定 X-Account-Id。
`POST .../notes` 要求 eventId、目标 id/accountId、note 和 observed(status/updatedAt/charged)。
观察状态已变或目标账户不匹配返回409；相同事件与载荷重试幂等，不同载荷冲突。追加备注时
再次在 SQL 内校验管理员权限和删除状态。新表保留操作者、观察快照、事件hash与时间。
只可追加不可改写；不标记完成，不自动追扣，不修改原审计、预留或账本。删除账户时按原级联
删除关联记录。部署前先应用0045，现有文字审核行为不变。
