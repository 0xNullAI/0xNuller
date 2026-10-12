# @0xnullai/auth

统一账户客户端，支持注册、登录、邮箱验证、找回密码、资料、头像/相册、联系人、私聊票据、
房间同步、AI 用量和管理员汇总。

```ts
import { login, me, subscribeAuthChanges } from '@0xnullai/auth';
```

网页使用 HttpOnly Cookie，Android 使用 Bearer Token；本包不提供任何设备控制接口。
登录用户的主页与联系人发现默认公开，旧版 `discoverable` 写入值不再用于隐藏账号；
拉黑仍阻止双方读取主页，单张相册照片继续按独立可见范围授权。

`listPersonalMemories`、`savePersonalMemory`、`deletePersonalMemory` 操作服务器上的私人记忆，
不在浏览器持久化。保存和删除携带版本，冲突直接返回错误供用户重新读取；这些内容不会出现在
公开资料或随角色卡发布。

角色私人关系 API 位于 `/api/auth/character-relationships`，客户端提供列表（可按 `characterId` 过滤）、
单条读取、CAS 保存及删除。`characterId` 对应共享场景 ID（包含内置角色），创建后不可变；
同一账户每个角色仅一条活跃关系。个人 AI 名字、用户称呼、关系类型及备注不写入公开卡片或群聊。
删除清空私人文本并保留关系 ID 墓碑，阻止旧客户端复活；新的关系可以使用新的 ID。
请求携带当前 `X-Account-Id` 并校验返回时的账号，响应禁止缓存。

记忆管理兼容既有账号记录：`listPersonalMemories(relationshipId?)` 可读取指定私人关系，保存时可带
`scope/relationshipId/tier/state`。`getMemoryContext(conversationId, query?)` 返回经服务端所有权和来源
校验的短期消息、中期摘录、长期记忆与关系历史；`suggestConversationMemories(conversationId)` 生成
等待用户确认的原文摘录/显式记忆请求。候选和已过期记录不会进入检索结果，来源字段不接受客户端伪造。
已确认的跨会话或较早同会话原文摘录在 Agent 上下文里单独标注为历史对话资料，避免与
用户手工保存的事实混为一谈；当前纠正优先。
较早同会话的完整八条用户消息窗口每次最多生成三个待确认候选；再次审阅会继续回填尚未
处理的窗口，已拒绝或删除的窗口不会重新生成。原始聊天记录仍保存在服务器会话中，
候选窗口不等于自动确认的长期记忆。
`getAutoMemorySettings` / `setAutoMemorySettings` 管理当前账号的一段私人关系自动发现开关；
客户端不保存开关副本，切号后拒绝旧响应，所有自动候选仍需用户确认。
`getAccountMemoryAccess` / `setAccountMemoryAccess` 管理单段已绑定 AI 私聊读取账号级记忆的授权，
默认关闭并按服务端版本更新；请求和响应都绑定当前账号，关系级记忆不受此开关影响。
`listMemoryPeople`、`saveMemoryPerson`、`deleteMemoryPerson`、`linkMemoryPerson`、
`unlinkMemoryPerson`、`supersedeMemoryFact` 和 `correctMemoryFact` 管理单一私人关系的人物别名与事实纠错；
`correctMemoryFact` 一次提交用户写下的新内容并停用旧事实，不复制旧事实来源；
调用携带账户身份，版本冲突由服务端拒绝，切换账号后的旧响应不能用于更新界面。

私人多模态对话使用 `PrivateConversationChannel`：账户身份固定，服务器 revision 保护写入；
冲突重读后只重试新增消息 ID，不重放或覆盖旧 transcript。`conversation-selection` 只在当前页面
保存账户、对话、角色与关系 ID，切换账户清空；不保存正文。`preparePrivateConversation` 在启动
语音／摄像头前加载同一会话近期文字和 `loadPrivateCompanionContext` 的关系与多层记忆，
并从服务器会话返回可选 `sceneId`；媒体端只把已导入的场景卡叠加为环境，不替换角色身份。
显式绑定已删除或不可用的关系不会悄悄切换成另一段关系。

`listCompanionLife/saveCompanionLife/deleteCompanionLife` 保存同一私人关系中的人物、事件关联、
共同经历和关系阶段。共享私有上下文读取该关系的记录，最多 30 条/8000 字符，作为资料 JSON，
不把人物备注视为外部联系授权。账号切换丢弃尚未完成的上下文读取。
语音、视频和文字 Agent 共用的私人上下文总计最多 16,000 字符；按私人称呼与关系、可选会话概述、
限额关系生平、已确认记忆、较早原话的顺序放入完整资料块，超额资料留在服务器但不进入这次模型输入。
媒体会话另为近期完整消息预留输入空间，不会截断 JSON 资料块形成半条记忆。

### Private character appearance

`./appearance` stores a private relationship's photo ID, 2D overlay scale/position and CAS version
through `/api/auth/character-appearance/:relationshipId`. The worker validates an active owned
relationship and ready owned photo; deleted photos resolve to the default portrait. No external
image URL is accepted. `./appearance-react` fetches authenticated platform photos into temporary
object URLs and revokes them on account changes/unmount. Voice shows the speaking state as a ring;
Video overlays the portrait in DOM only, outside capture/model frames. This is a 2D camera overlay,
not 3D rendering or spatial tracking.

Unified Inbox: `listPrivateConversationSummaries({limit,cursor})` requests the account-owned
`/conversations?summary=1` projection (metadata and bounded last-message preview, no transcript or
device state). Page cursors and deletion tombstones match the existing API. Display migrationErrors
instead of silently dropping unreadable legacy rows. `selectAgentInboxConversation(id)` stores a
single account-bound, one-time navigation intent until Agent mounts/activates; account switches
invalidate it, including switching back to the same account. Consumers can debounce the body-free
`0xnullai:conversation-updated` browser event to refresh after successful saves/deletes.

`startAgentRun` allocates an account-bound server run for an existing conversation before a Web Agent
reply. `claimAgentRunCall` allows one execution per model call ID; `recordAgentRunCall` and
`finishAgentRun` report the observed outcome. `getAgentRun` / `listAgentRuns` support recovery
and inspection. All returned evidence is explicitly `client-reported`; it does not prove that an
external action or local device command actually happened.

AI 私聊附件由 `PrivateConversationAttachmentChannel` 处理。图片与语音先上传到会话绑定的私有
R2 对象，再在同一账号/会话仍有效时显式提交为用户消息；列表和内容每次重新鉴权，客户端
切号会使旧通道失效。成功提交后会通知统一消息列表刷新摘要；未提交或切号的结果不发通知。
语音附件可在提交时附上用户确认的文字，作为同一条服务器用户消息正文供后续 AI 回合读取；
服务端会明确标注未自动核对录音，列表只向所属账号回传这段文字。没有附文字时仅保存与回放，
模型没有经验证的视觉/语音输入能力时不会收到伪造的识别文本。
Voice/Video 准备同一会话时会过滤附件的空正文占位；当它们占满最近 20 条服务器消息时，
才向前读取最多 6 页、每页 20 条消息，并继续按固定字数截取真实文字给模型与记忆检索，
不下载完整长会话，也不把附件当作已识别文字。分页期间会话或账号变化会中止准备。
