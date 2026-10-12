# 0xNuller Chat

基于 Cloudflare Durable Objects 的房间、公开大厅和私聊模块。成员明确授权后，房间还可以控制其
共享的设备。Chat 要求登录且邮箱已验证；浏览器和 Android 使用 Auth 签发的短期 admission ticket，
房间、公开目录和私聊会在 Worker 入口重新校验。

- 统一主站：<https://0xnullai.com/chat>

## 功能

- 公开大厅、公开或私密房间、房间号与二维码邀请；邀请链接统一指向网页入口。
- 房间名必须手动填写 4–40 个字符；大厅显示在线人数，包括空房的 0 人。
- 任何群连续 30 天无人连接后自动回收房间、聊天记录和附件，旧房间号失效；私聊不受影响。
- 文字、图片和语音消息；媒体存储于 R2。
- 账户联系人和私聊；Chat 在统一主站中要求登录并验证邮箱。
- 没有系统推送；新消息以站内未读呈现。旧房间唤醒时删除已停用的 `push_outbox` 表。
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
真人私聊的图片与语音也使用该能力读取：浏览器仅在当前连接有效时加载附件，RoomDO
再次核对短期租约、账户和私聊撤销状态；私聊媒体响应不缓存。

运维备份接口使用独立的 `CHAT_BACKUP_TOKEN`，按明确房间 ID 分页导出服务器原始消息，并能
枚举及读取当前 R2 媒体。新房间索引记录已观察的群与私聊，独立备份令牌可以枚举索引或回填
可信清单中的旧房间；它不向客户端暴露令牌，也不能自动发现从未再次访问的历史 Durable Object；
执行、覆盖缺口和隔离恢复要求见[聊天备份文档](../../docs/chat-backup.md)。

## 部署

Chat 使用 `RoomDO`、`LobbyDO` 和共享的 `dg-chat-media` R2。历史独立域名已下线；部署顺序、
历史公开房间由大厅唤醒检查；未列入大厅且没有旧定时任务的历史私密房间，在下次连接或断开后纳入新计时。
共享存储和密钥要求见 [部署文档](../../docs/deploy.md)。

## 协议

[MIT](../../LICENSE)

统一主站中，房间所有者可从房间顶部的“房间 AI”添加或编辑现有人设；普通成员和真人私聊不提供该入口。
从场景库导入时保留完整文本，超过房间名字 40、人设 4000 字符限制会提示编辑后再保存；原场景不受影响。
Worker 同样拒绝超长配置并保留原配置，不再静默截断。后续角色和群记忆接入见
[真人社群与 Market 接入审计](../../docs/community-integration-audit.md)。

所有群与真人私聊都完整保存服务器历史，不按条数裁剪；新版每次读取 100 条并通过时间戳+消息 ID
游标分页，旧客户端仍收到最多最近 1000 条，未显示部分继续保存在服务器。任何群连续 30 天无人连接后
回收；群显式关闭后同样走清理流程。
服务器拒绝参与者伪造历史/系统帧，相同消息 ID 不覆盖已有正文。

每群最多配置一位 AI，名字和人设可从场景库填入后编辑。旧群若有多位 AI，优先使用
`ai:room`；没有主角色时沿用原有第一位附加角色的 ID，历史消息保留其原身份。
所有 AI 发言和设备命令仍由服务器校验当前 host 和已配置的精确角色 ID。
仅真人 @ 触发，每条消息最多回应一次，最多排队四条消息；AI 消息不会相互触发。
主机变化、切房或人设变化后丢弃在途结果。群上下文不读取账户私人关系和记忆。

群 AI 的新消息链路要求服务器确认真人消息后才触发模型。当前 host 先发送
`agent-claim {requestId, triggerId, roleId}`；RoomDO 只对本群已保存、仍是有效成员的真人 @ 消息签发一次性 grant。
每条消息最多一位已配置 AI，全群最多四个未完成 grant，并限制每分钟 12、每小时 120 个 grant；
过期或已领取的同一消息/角色不能重领。
AI 回复必须携带对应的 `triggerId` 和 `grantId`，并在同一 SQLite 事务中核验当前 host、角色配置和未用过的 grant 后写入。
host 还绑定其已验证账号；客户端不能以 `ai:*` peer ID 或复用在线 peer ID 进入房间来冒充 AI/host。
模型失败、断线、host/人设切换或没有回复时，不写入 AI 发言，也不标作已完成；grant 在五分钟后失效，
用户可发一条新的 @ 消息重试。发送者的乐观消息只有收到 RoomDO 回显后才算已保存，才可能触发 AI。

群主可明确选择两种模型模式：`host-byok` 仍由 host 浏览器的 provider/API key 调用并承担费用；
`managed` 在服务器确认真人 @ 与一次性许可后由 Chat 调用同一托管 LLM 代理，@ 发起人账户走平台 Credit
预留与实际用量结算，且仅支持文字、不会调用设备工具。失败或结算状态不明时不发布虚假的 AI 回复，
发起人应先查看 Credit 账本再发新 @；真实服务商端到端用量对账仍待预发布验收。
旧客户端可以继续收发真人群消息，但旧版群 AI 不会领取 grant，因此不能成功发表 AI 回复；
使用群 AI 需要更新客户端。更新后的客户端加入混合版本群时优先接管 host；新客户端不会为服务器拒绝或
未确认的消息发起模型调用。只有旧版客户端在线时，旧版 host 仍可能在本地尝试模型调用，
但服务器拒绝无 grant 的回复；群 AI 参与者应更新客户端，避免这类无效 BYOK 消耗。

输入栏可搜索 Market 公开角色/场景，预览并明确发送卡片引用；接收者通过链接打开公开详情。
只发送公开 ID 和显示名，不复制个人记忆或私有卡片数据。原图片/语音发送路径不变。

统一网页通过 `src/inbox.ts` 的 `loadChatInboxWithStatus()` 与 `selectChatInboxConversation()` 聚合
群聊、真人私聊和 AI 对话。Chat 在外壳中仅提供当前聊天正文，设备控制保留显式标签入口；
独立运行仍保留本地会话列表。列表取账户服务器的群成员记录与授权私聊摘要，不导出 owner key，
账号变化会丢弃旧加载结果和待处理选择。群聊或私聊来源短暂失败时，外壳保留已读取的一侧并提示缺失部分；
需要完整结果的调用方仍可使用 `loadChatInbox()` 的失败即报错契约。此接缝不授予房间访问或设备权限。

账户群书签 `GET /api/auth/chat-rooms?limit=100&cursor=…` 使用账号绑定的
`updated_at DESC, code ASC` 游标；客户端完整列表会逐页读取，任何一页失败都不把不完整前缀
写回本地缓存。无分页参数的旧客户端响应保持兼容。书签仅用于发现，群摘要和进入房间继续在
RoomDO 核验当前有效成员；移除成员后残留的书签不会获得消息或设备权限。分页不是跨并发修改
的全局快照；翻页期间被其他设备更新到第一页之前的书签，下一次刷新会重新显示。
群聊侧栏及统一消息列表默认只读取第一页（最多 100 群），通过「加载更多群聊」继续；刷新会重新
读取用户已经展开的页，不会把页前缀写成完整的本地群书签缓存。初次本地旧群迁移仅在确有旧记录时
进行一次完整比对。只加载第一页时不能据此断言账户没有其他群；后续页失败会保留已经显示的群，
但旧摘要和已读操作须重新验证。进入群与标为已读仍由 Chat 服务端检查当前成员资格。

设备控制页使用共享 `deviceConversationAccess` 契约：当前账户的每个群/私聊默认拒绝设备控制，
用户明确启用后才允许非停止命令进入既有 owner 校验。授权保存在当前浏览器，不跨设备自动授予。
房间 AI 还需原 `allowAi` 开关；全局安全限额、精确物理身份与 Chat lease 继续独立生效。
撤销授权或切换已授权会话会停止 Chat 持有的输出并清除临时开火状态；停止与释放通路不会因撤销被封锁。

## 引用回复

真人私聊、群聊和群内 AI 共用消息旁的「回复」入口，可引用文字、图片或语音消息，再发送文字、图片或语音回复。
输入栏保留引用预览并可取消；发送失败不清除草稿和引用。压缩、上传和录音期间固定引用来源，成功发送才清除；公开角色分享需先取消引用。真人语音结束录制后先在本地预览，明确确认才上传和发送；预览可丢弃，失败可重试同一录音及引用。
回复当前仍在场的参与者会携带精确成员 ID；回复 AI 会在预览中说明将提醒该 AI，同名角色不会按名字合并。
切换会话会重建输入栏，防止上一会话的引用、录音或草稿被发到另一会话。

客户端只发送 `replyToId`；RoomDO 从当前房间的历史解析发送者与最多 500 字符的引用，不接受客户端伪造的引用正文。
服务器历史只保存来源 ID，分页重放时重新解析；来源已回收或不可用时显示「原消息已不可用」，不额外保留正文副本。
旧无引用消息及旧客户端保持兼容。群 AI 的当前上下文包含引用片段，不能据此获得任何设备或私有记忆权限。
点击已加载消息中的引用可定位并聚焦原消息，不自动读取其他房间或无限加载历史。
媒体回复沿用原上传凭据、格式和大小校验，上传前后复核同一房间与凭据；切房后的压缩或录音结束不会发送旧消息。
群 AI 仍仅接收文字和引用片段，媒体消息明确标注未提供视觉内容或转写，附件提醒不代表多模态识别。
本轮不增加跨房间转发；房间成员/私聊准入与设备最终执行校验保持原样。

## 真人聊天记忆共享

已于 7.0.0 下线：个人记忆不再向真人私聊或群聊共享，聊天设置中也没有对应入口。

## 收件箱服务器摘要

统一收件箱使用 `POST /api/dm/inbox`，客户端携带 Auth 已签名的 digest ticket 和匹配的 `X-Account-Id`。
Worker 只查询 ticket 中允许的 DM，RoomDO 再校验撤销时间与本实例代码；返回最新消息时间、最多 160 字符预览或图片/语音标记，响应禁止缓存。
该路径不读取浏览器的已读缓存，也不把全部历史条数当成未读数。尚无服务器账户已读游标时 `unread` 为 null。
群成员记录更新时间不作为最新消息时间，群摘要与未读暂为未知；旧独立 DM 侧栏的本地读标记实现仍保留兼容，统一收件箱不再调用它。

后续服务端契约需要：账户签名的群摘要 ticket（明确房间范围、aud、sub、iat、exp）、每条消息的稳定递增序号与可信发送账户 ID、
按账户/会话存储的单调已读游标。读取摘要必须重查撤销/成员资格，设置已读必须验证游标对应本会话可见消息；计数排除本账户发送。
仅传递用户可读的 lastMessageAt/preview/unread，不传 owner key 或其他房间正文。现有 ts+id 可用于历史分页，但不能直接当单调消息序号。

DM server read state now uses additive DO tables `message_sequences` and `dm_read_cursors`.
Sequences are permanent, monotonic, and independent of timestamps/peer IDs; deleting a message
retains an ID tombstone and does not reuse its sequence. Existing rows are assigned sequence
numbers but their author remains unknown. New DM sockets bind the signed admission ticket's
account to the server attachment; old hibernating sockets remain compatible but cannot establish
trusted authorship until reconnecting. Unknown authors after a cursor keep unread unknown.

The unified inbox consumes `lastSequence`, `readSequence`, and `unread` from `/api/dm/inbox`.
“标为已读” obtains a fresh DM admission ticket (Auth rechecks mutual follow/block), then sends
`POST /api/dm/read {ticket,sequence}` with matching `X-Account-Id`. Read-only digest tickets
cannot advance cursors. The DO rechecks room/revocation and atomically advances MAX; future
sequences fail. Account-change subscriptions discard in-flight A-B-A responses. Counts exclude
messages whose trusted sender is the reader; neither browser read marks nor client sender IDs
are used. Reading can be explicit in the unified inbox or follow rendered DM messages as described below;
migration of the legacy standalone DM sidebar is not implemented. This grants no media or device
permission. DM membership tickets retain
the existing 60-second validity window and proactive room revocation behavior.

DM automatic reading now follows rendered server messages: only history/server chat frames set
`serverConfirmed`; optimistic sends and local notices cannot mark history read. ChatPanel observes
the latest confirmed bubble for at least 500 ms with IntersectionObserver while the document and
Chat tab are visible. Hidden/unmounted views revoke the preflight guard. The admission account is
invalidated on any A-B-A identity transition, and switching conversations during ticket retrieval
cancels the request. `POST /api/dm/read` additionally accepts `{ticket,messageId}` exclusively of
`sequence`; the DO resolves that ID against its own retained messages and permanent sequence ledger.
Missing/deleted/foreign IDs fail; a newer message arriving concurrently is never swallowed.
Successful acknowledgement refreshes the shared inbox. Failed reads remain server-unread and show
a quiet sync-status message; explicit inbox acknowledgement remains available.

Group membership and inbox state now have their own server boundary. The Chat Worker overwrites
`X-Chat-Account` with the verified `chat` ticket subject before forwarding a group upgrade. Only
successful `hello` admissions create `group_memberships` rows; legacy hibernated sockets without a
verified account are never inferred from nicknames, peer IDs, bookmarks, or owner keys. Disconnects
and ordinary transport switching retain membership; the explicit Exit action sends
`membership-leave`. Its version check prevents a late leave from revoking a later rejoin.

The exact owner key may list the latest 200 verified members and remove/ban/restore them through
the Group Members dialog. Legacy host authority alone cannot moderate membership. Both removal
and ban block automatic rejoin until explicit restore; restore permits a new join rather than
silently reactivating membership. Each transition increments the durable version. Removal closes
all sockets for that account, and every subsequent frame rechecks active membership/version,
including repeated hello frames. Room closure/expiry removes active memberships. These records
have no effect on device owner keys, strength limits, or final execution checks.

`POST /api/groups/inbox {ticket,rooms}` accepts a fresh verified Chat ticket and up to 50 room
selectors. Each DO independently verifies an active durable membership; `user_chat_rooms` remains
only a bookmark/discovery list and is never an authorization source. Authorized summaries include
nullable unread/lastSequence/readSequence and a 60-second `group-read` ticket bound to account,
room and membership version. `POST /api/groups/read {ticket,sequence}` (or messageId) rechecks all
three plus room closure and supports monotonic read advancement. Removal/rejoin invalidates old
read tickets immediately through the version check. Responses are private/no-store; clients pin
account identity including A-B-A transitions. Group requests use the new `/api/groups/*` Chat
route, which must ship with the Worker configuration; no new secret or service binding is needed.

Groups reuse the permanent message sequence ledger; trusted account senders exclude one's own
messages from unread counts. Room-AI messages use a distinct synthetic sender so they count for
the host too. Old history/anonymous senders remain unknown until explicitly acknowledged. The
unified inbox now offers real summaries and explicit mark-as-read for verified group memberships.
Group automatic reading also uses the shared visible-message observer: a server-confirmed bubble
must be displayed for 500 ms in the active Chat pane. The account captured when joining is
synchronously invalidated on A-B-A transitions, leaving or switching rooms. Before submitting
that exact messageId, the client obtains a fresh membership-scoped ticket and rechecks visibility;
the DO rechecks membership version at the final write. Summary lastSequence is never substituted
for the displayed message. Failure leaves server read state unchanged and preserves the explicit
inbox retry action. All saved group codes are de-duplicated and queried sequentially in batches
of at most 50, preserving the supplied order. Each batch obtains a fresh Chat ticket; A-B-A
changes abort the in-flight request and all remaining batches. Successful batches remain visible
when another fails; failed rooms retain null unread/time and the unified inbox explicitly reports
partial loading. A room omitted by a successful authorized response remains unverified, distinct
from a failed request. Independent batches are not a global atomic snapshot; acknowledgement
always revalidates current membership. Account deletion revocation was added in the subsequent
rollout described below; dormant historical coverage remains limited.

### Historical account deletion authority audit (before the rollout, 2026-09-29)

This audit records the pre-change risk and the design constraints behind the implementation below.
Its present-tense descriptions refer to the state before the revocation registry was added.

Verified source paths: `workers/auth/src/index.ts` account DELETE / `severDm`,
`workers/auth/src/photo-lifecycle.ts` finalize/maintenance, Auth `wrangler.jsonc`,
Chat `worker/index.ts` admission/revoke routes and `worker/room-do.ts` attachments/membership.
Auth already has the `CHAT` service binding to `0xnullai-chat` and the shared ticket secret.
Chat has no reverse Auth service binding or account-to-all-rooms registry today.

Current deletion first writes `account_deletions`; authentication excludes marked users, then
`finalizeAccountDeletion` deletes the user's photo prefix and the D1 user (cascading related D1
rows). Failed photo/user deletion is retried by maintenance. It does **not** notify Chat.
`severDm` is a separate best-effort block/unfollow notification; `/api/dm/revoke` closes room
sockets and stores a ticket revocation timestamp, but deletes neither messages nor media.
Existing WebSockets do not periodically revalidate Auth session existence or ticket expiration.
Therefore, removing Auth sessions is not proof of closing Chat sockets, and the 60-second ticket
TTL only bounds new ticket admission/reuse, not already-connected sockets. Group memberships,
read cursors, message author records, and Chat R2 objects are independent of Auth D1 cascades.

The audit identified these ordered steps; the following section records the implemented access
revocation subset and the remaining content-erasure limits:

1. In the same durable deletion workflow, freeze Auth access and persist an idempotent Chat
   revocation outbox **before** cascading `dm_threads` or bookmarks. DM peers can be snapshotted
   from trusted `dm_threads`; user-editable group bookmarks are discovery hints, not a complete
   authoritative membership inventory. Do not swallow Chat failure and return deletion-complete.
2. Add a Chat-owned reverse registry of verified account-to-room admissions plus permanent account
   revocation tombstones. A new account registry DO/binding would need a new additive deployment
   migration; no current binding provides this index. Register before accepting a new membership,
   reject registrations for revoked accounts, and make deletion/fan-out acknowledgement idempotent.
   Recheck registration completion before replaying history so join-vs-delete races cannot create
   an untracked surviving socket. Existing group membership rows need explicit backfill coverage;
   ordinary DO namespace routing does not provide a complete list of all old room instances.
3. Use the existing Auth-to-Chat binding with a purpose-specific signed account-revoke command
   (deletion job ID, subject, issued time; never public Chat/read tickets). Chat first records the
   permanent account tombstone, then enumerates the trusted reverse registry and version-revokes
   group memberships / DM access, closes matching live sockets, and acknowledges each target.
   Retry failed targets from the durable outbox. DM rooms with legacy anonymous attachments can
   be severed as a whole; anonymous historical group sockets cannot safely be attributed to an
   account. A migration must force their reauthentication or report that coverage as incomplete.
4. Separate access revocation from content erasure. Remove that account's private read cursors and
   membership display data, retaining only minimal non-resurrection tombstones. Define the shared
   transcript retention/anonymization rule before touching other members' group/DM history or media.
   Only trusted new sender-account records support targeted attribution; random historical peer
   IDs and nicknames cannot prove authorship. Message/media cleanup needs idempotent reference-aware
   work so a shared media reference is not deleted on a guessed identity.
5. Finish the Auth deletion job only after required Chat acknowledgement and defined content tasks;
   return pending while retrying. Test crashes between steps, duplicate deliveries, concurrent join,
   old signed tickets, hibernating/anonymous sockets, removal/rejoin versions, partial room failures,
   account A-B-A, and keeping other participants' messages and device stop paths intact.

No deletion broadcast, new binding, remote migration, account erasure, or production action was
performed for this audit. The existing Auth-to-Chat binding is usable; authoritative reverse-room
coverage and an acknowledged retry protocol are the remaining prerequisites for complete cleanup.

### Account deletion revocation registry (additive rollout)

Chat now requires the `ACCOUNT_REGISTRY` binding and appended SQLite DO migration
`v2-account-registry`. Each signed account has a durable reverse admission index and permanent
account tombstone. New group admission writes the index before forwarding; missing bindings or
registry failures deny admission. Existing authenticated memberships are indexed when observed
(join, group inbox/read, upload), never inferred from anonymous peers or user bookmarks.

Auth calls `POST /api/groups/account-deletion` with `{token,cursor?}`. The HMAC ticket uses
`aud: "chat-account-delete"`, `sub`, `deletionId` (including `userId:requested_at`), `iat`, and `exp`.
It first persists the tombstone, then returns `accountId`, `deletionId`, `tombstoned: true`, pending
`rooms` (100 per page), `nextCursor`, `coverage: "registered-and-observed"`, and
`legacyCoverage: "unknown"`. Auth must recheck the first page after processing all pages.
`POST /api/groups/account-deletion/room` with `{token,room}` accepts either a pending room or an
additional legacy server bookmark hint. It revokes the account membership, clears its read cursor,
closes its sockets, then acknowledges the room; non-2xx results remain retryable. A late observed
legacy membership is refused, revoked locally and acknowledged even after the account was deleted.
Existing DM signed revoke remains separate.

Room sockets now carry a server-enforced lease ending at the signed ticket expiry, capped at
65 seconds after admission. Incoming valid frames, outgoing payloads and upload authorization
check expiry; alarms schedule socket closure. Legacy attachments without an expiry cannot read or
write when next observed. Alarm delivery can be delayed, but no payload is authorized past expiry.
Clients reconnect and reauthenticate. Group inbox/read and upload also check the registry on each
request; lobby admission/snapshots check account tombstones.

This does **not** enumerate dormant unindexed historical groups, erase shared transcripts, revoke
previously downloaded files, or make existing anonymous `/api/media/:code/:id` cached URLs private.
Legacy lobby subscriptions have no account identity; account-specific immediate revocation of those
public discovery sockets needs a separate identity/lease migration. Do not report these as erased
or fully enumerated by the deletion acknowledgement.
