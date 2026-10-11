# 0xNuller Market

中文 | [English](README.en.md)

用于浏览和分享角色、场景与波形的社区市场。

- 统一主站：<https://0xnullai.com/market>
- 历史版本：<https://market.0xnullai.com>

浏览无需登录。上传内容会自动归属当前账户；所有者可以编辑或删除自己的内容，管理员账户
可以处理历史内容。Market 不使用共享管理员口令或条目编辑口令。
已验证的发布账户在卡片和详情中优先展示，详情可直接打开其公开个人主页；可编辑的作品署名只是附加文字，不充当作者身份。旧作品若没有可验证账户则标为「未认证作者」，不会自动归属到同名用户。
登录用户的个人主页可读取该账户已验证且仍可见的公开作品，最多展示最近 8 件并可直达详情。作者查询同时按查看者的双向拉黑关系过滤；下架作品与手写署名不进入主页。
发现页上排是「浏览全部／我的收藏／关注作者」，下排是「角色／场景／波形」，创建入口位于分类行右侧。浏览全部可展开筛选排序和波形类型；筛选结果为空与网络加载失败分别提示。
浏览全部每次加载 50 条，可继续浏览后续公开作品；追加失败保留已显示内容并可重试。最新发布采用服务端游标：首屏固定当时的插入边界，后续按发布时间与作品 ID 前进；新发布内容不会把已浏览页推移，也不会混入这一轮浏览。隐藏或删除作品会立即从后续页消失，刷新列表可看到新作品。热门、浏览与下载排序仍是实时数据：浏览过程中数值变化可让作品跨越分页位置，因此这三种排序不保证一轮遍历的快照完整性，页面会提示刷新；客户端去重只避免重复展示，不声称修复漏项。旧 `offset` API 保持兼容。
游标接口为 `GET /api/items?pagination=cursor`，响应含 `nextCursor` 与 `pagination=stable|live`；后续页原样回传 `cursor`，不得改变筛选、排序或页大小。游标由服务端签名，篡改或混用筛选条件返回 400。稳定发布边界依赖 Market `0014_item_publish_order.sql`，须先应用迁移再上线使用该接口的 Worker／网页；旧 offset 列表不依赖新表。
角色和场景共用公开 `scenario` 存储，但 `content.kind` 明确区分。角色是可聊天、可建立私人关系的实体；场景只有环境与规则 Prompt，不拥有角色关系或记忆。旧结构化卡按角色读取，旧 prompt-only 卡按场景读取。多人场景停止发布和展示，真人群聊保留。

## 本地开发

```bash
npm install
npm run db:migrate:local -w 0xnullai-market
npm run dev -w 0xnullai-market
npm run test -w 0xnullai-market
npm run typecheck -w 0xnullai-market
npm run build -w 0xnullai-market
```

Worker 使用独立的 `MARKET_IP_PEPPER` 进行上传限流；不要把它写入仓库。

上传界面按职责拆分：`components/UploadDialog.tsx` 只协调表单状态、网络请求和关闭/刷新，
模板生成、文件/压缩包解析及手动 payload 校验集中在纯 TypeScript 的 `src/web/upload-model.ts`。
鉴权、账户归属和所有者编辑权限仍由 API 与 Worker 强制执行，前端上传模型不拥有这些决策。

## API

- `GET /api/items` — 浏览和搜索
- `POST /api/items`、`/api/items/batch` — 登录后上传
- `PATCH /api/items/:id` — 所有者或管理员修改元数据；场景条目也可修改完整剧本内容
- `DELETE /api/items/:id` — 所有者或管理员删除
- `GET /api/items/admin` — 管理员查看内容
- `PATCH /api/items/:id/moderation` — 管理员隐藏或恢复内容

生产迁移和预览步骤见[部署文档](../../docs/deploy.md)。

## 许可证

[MIT](../../LICENSE)

Prompt 粘贴保留完整文本；超过 100000 字符时明确拒绝保存，
不使用浏览器 maxlength 静默截断。复制 JSON 与下载采用同一份完整内容，复制权限失败会显示下载提示。

角色与场景共用 `scenario` 内容类型和基础 Prompt；角色的 `content.kind=character` 与 `content.characterCard` 保存公开人设，场景的 `content.kind=scene` 只保存环境规则。已发布卡片不能更改类型，转换需另建卡片。
发布、批量上传、所有者编辑、复制 JSON 与导入保留这些字段；旧 prompt-only 场景继续可浏览和编辑，但不再作为角色直接开始聊天。角色／场景浏览使用 `GET /api/items?type=scenario&kind=character|scene`；旧 `character=1` API 仍兼容已有客户端。隐藏与账户权限不变。
卡片与本地场景使用同一校验器和字段编辑器，私人称呼、关系、记忆不属于公开 payload。
创作者仍通过已有下载奖励与打赏获得站内 Credit，不提供现金提现。

公开角色头像可在编辑器上传 JPEG、PNG、WebP（最多 4 MB），存入独立 Market R2 bucket，
角色内容只保存不可变 `portraitId`。未发布素材仅上传账户可预览；素材只随可见角色当前版公开，
替换、移除或下架后收回访客读取权限。旧版图片仍由作者预览。图片在服务器校验格式和尺寸并剥离元数据；这与聊天设置中的
私人 AI 头像完全分开。`0008_character_portraits.sql` 是兼容增量迁移，旧条目继续使用 emoji。
部署前须创建 `dg-market-character-portraits` R2 bucket 并核对 Market Worker 绑定；本地验证不代表
远端资源或迁移已经配置。上传中断和删除失败的保留记录由每日任务重试。编辑器可先从在线草稿
移除头像，再删除未被任何当前或历史角色版本引用的图片；数据库触发器阻止删除与发布并发造成失效引用。
已完成但被作者替换后遗留的素材，还需要独立的资产管理和长期回收策略。

创建入口统一打开角色、场景或波形编辑流程。角色和场景使用同一页面编辑器，名称和基础 Prompt 是必填核心；角色可加公开人物字段及头像，场景不包含人物字段。波形发布弹窗只接受波形。Market 不再提供内置原创起点或多人场景创建。
编辑器使用可刷新地址 `/market?editor=new&kind=character|scene` 或 `/market?editor=<itemId>`。直接打开已发布卡片的编辑地址时会重新读取当前卡片并检查账户所有权，
浏览器前进/后退也会恢复页面状态。发布后地址转为该公开卡的详情链接。

- `POST /api/items/character-portraits` — 登录作者上传公开图片，返回不可变素材 ID
- `GET /api/items/character-portraits/:id/content` — 当前公开角色可供访客读取，草稿仅作者读取
- `DELETE /api/items/character-portraits/:id` — 作者删除未被当前或历史版本引用的素材

编辑器预览的公开字段与私人 AI 实体设置分离，已保存的旧版字段继续保留。
登录账户可显式保存、恢复在线草稿；草稿由 Auth 数据库按账户隔离、版本冲突检查并随注销级联删除，不进入公开目录。
发布内容以 `revision` 递增；所有单人 Prompt 卡（含旧 prompt-only 场景）修改前的版本写入 `character_item_versions`，过期编辑返回 409。
所有者可在编辑器查看旧版并载入编辑区，只有再次点击保存才会发布新的版本；历史接口不向其他用户开放。
已导入用户保留原人设快照；场景设置中可检查公开卡的新版本并手动采用，原私人关系和记忆不随之改变。
这些能力依赖 Market `0007_character_versions.sql`、`0012_unified_prompt_card_versions.sql` 与 Auth `0038_character_drafts.sql`；后者仅扩展历史归档触发器，旧场景正文无需转换。本地验证不代表生产已迁移。

编辑器支持导入 CCv2/CCv3 `.json`、带 `ccv3`／`chara` 文本块的 PNG/APNG，以及根目录
`card.json` 的 CCv3 CHARX：常规人物字段进入可编辑的人设，原始 JSON 可进入账号在线草稿。
发布时默认只发布人设投影；作者明确勾选后，原始 JSON 才随公开卡和后续版本一起发布，供下载与
继续编辑。原件可能包含扩展字段，勾选前应检查隐私与使用权。旧客户端编辑公开卡时保留已发布原件；
新版编辑器可显式移除。列表不返回原件，详情接口返回完整卡。PNG/APNG 与 CHARX 原容器
经客户端和 Worker 同一受限解析器验证后保存到 Market R2 私有前缀，在线草稿只保存所属账户可读的
文件 ID 与名称；离页、刷新或跨端恢复后仍可原样下载。上传失败不会把未保存附件伪装成已保存草稿。
导入检查本地资产路径、引用、被引用资产的扩展名与文件签名、数量及解压大小，不下载外部 URI。
图片和附属资产不会自动成为公开头像或公开资源；含未公开本地资产引用的原始 JSON 不允许发布。
可发布的原始 JSON 仍需作者再次确认隐私和传播权。角色书运行时检索尚未实现。输入文件最大
20 MB，角色 JSON 最大 120 KB。

私有容器最多每账户 20 个、总计 100 MB、每天上传 20 次；编辑器的「管理私有原文件」能列出、下载
和明确删除本人的文件，补救上传已成功但响应丢失的孤儿文件。删除当前草稿引用的文件前须先从草稿
移除并保存；删除其他文件会提示可能使其他草稿的引用失效。账号注销后 Market 每日分批询问 Auth
账户活跃状态并重试清除 R2/D1，处于删除中的文件保持标记直到清理成功。此任务未执行生产迁移或
部署；发布顺序为先上线带 `MARKET` 服务绑定和账户活跃查询 RPC 的 Auth，再应用 Market
`0010_character_container_drafts.sql` 并上线含上传、私有 HEAD 校验及编辑器的 Market。现有 Market
Worker 已是 Auth 服务绑定的目标；在其新 HEAD 接口上线前，Auth 对私有文件 ID 的草稿写入会拒绝，
旧 prompt-only 草稿照常保存。不能先上线新 Market 编辑器再上线 Auth：旧 Auth 会丢弃新草稿中的
`sourceFileId`，造成跨端原文件引用缺失。若服务绑定暂不可用，新 Auth 会拒绝带文件 ID 的写入。

- `POST /api/items/character-container-drafts` — 所属账户上传私有 PNG/APNG 或 CHARX
- `GET /api/items/character-container-drafts` — 仅列出本人文件元数据
- `GET /api/items/character-container-drafts/:id/content` — 仅所属账户下载原文件
- `HEAD /api/items/character-container-drafts/:id/content` — Auth 校验归属及 R2 原件存在
- `DELETE /api/items/character-container-drafts/:id` — 仅所属账户删除原文件

- `GET` / `PUT` / `DELETE /api/auth/character-drafts/new` — 当前账户的新角色草稿
- `GET` / `PUT` / `DELETE /api/auth/character-drafts/:itemId` — 当前账户对应公开卡的编辑草稿
- `PATCH /api/items/:id` 的 `expectedRevision` — 阻止过期编辑覆盖更新
- `GET /api/items/:id/revisions`、`GET /api/items/:id/revisions/:revision` — 所有者/管理员查看公开角色历史

公开内容可通过 `/market?item=<id>` 直达详情，独立于当前列表分页；已下架或读取失败会显示错误。
Chat 的公开角色分享只携带该公开引用，不包含个人关系与记忆。
主站中的公开角色详情提供「开始聊天」：重新读取可见卡，在当前登录账号幂等建立私人角色关系，
导入该版本的人设快照并打开新 AI 会话。首次发送后聊天记录才进入服务器；角色卡之后发布的新版本
不会自动覆盖私人关系、记忆或已采用的人设。独立 Market 站点继续提供原有导入指引。
公开场景详情提供「导入场景」：重新读取可见卡并确认写入当前账号的个人内容，但不改变当前选中的
角色、不创建会话或私人关系；用户可随后在角色聊天中选择该环境。

## 收藏与可解释发现

登录用户可以在公开详情中收藏/取消收藏，并从「我的收藏」跨端读取最多 200 项可见内容。
收藏归属服务端认证账户 ID；作者显示文字不参与归属。收藏与取消为幂等状态操作，不发放 Credit。
隐藏或删除内容不出现在收藏和推荐中，隐藏内容不占可见收藏限额。

「为你发现」从最近和下载较多的公开角色卡中，优先展示与已收藏公开标签重合的内容，逐项显示推荐理由。
它会依据账号明确选择的「不感兴趣」「少看相似标签」「少看这位作者」减少对应推荐，并提供偏好列表与撤销。
同一已验证发布账户最多占 2 个推荐位；前 30 个位置中，每 5 个尝试留 1 个给最近 30 天发布、
已验证作品不超过 2 件的新作者。作者身份只取 Auth 已验证归属，不信任手写署名；无法验证作者的
旧卡仍可推荐，但不声称其作者身份。候选池仍限最近 50 件与热门 50 件，故新作者曝光是池内保证，
不是全站均衡分发。它不读取聊天、记忆、人际关系或设备数据，也不使用语义画像或向量召回。
偏好仅当前账号可列出或删除，每账号上限 200 条；注销后 Market 每日分批检查 Auth 状态并清理。

- `GET /api/items/discovery?mode=favorites|recommended` — 当前账户的收藏/推荐
- `GET /api/items/:id/favorite` — 当前收藏状态
- `PUT` / `DELETE /api/items/:id/favorite` — 收藏/取消，必须带匹配账户的 `X-Account-Id`
- `PUT /api/items/:id/discovery-feedback` — 当前账号按固定理由隐藏角色或已验证作者
- `GET /api/items/discovery-feedback` — 当前账号查看自己的负反馈
- `DELETE /api/items/discovery-feedback/:kind/:id` — 当前账号撤销偏好，kind 为 item 或 creator

以上私有接口返回 `Cache-Control: private, no-store`。客户端切换账号后清除收藏界面并丢弃在途响应。
本轮新增 Market `0011_character_discovery_feedback.sql`，未执行远端迁移。先部署带批量
`marketCreatorsForItems` RPC 的 Auth，再应用 0011 并部署 Market；旧收藏、关注、举报和 Credit 下载奖励
不参与负反馈或排序写入。

「角色详情打开 → 开始聊天」仅对已登录账户记录按钮路径的最小事件：公开 item ID、账号 ID、UTC 日、
动作类型与服务端时间；每账号/角色/日/动作去重，每账号每天最多 100 个该类事件。`start` 在私人关系
建立且人设快照导入成功后才由客户端发送，失败不妨碍用户进入聊天；它衡量的是完成「开始聊天」
入口的账户，不证明已发送消息或收到模型回复。事件不含 relationship/conversation ID、聊天正文、
记忆、设备信息或私人头像，30 天后由 Market 定时删除，注销账户后也随账号清理。只有管理员可读
近 30 天至少 5 个不同账户涉及的公开卡聚合 `openedAccounts` 与 `startedAccounts`；作者与访客没有
逐人记录、聚合统计或关系访问接口。管理员可从 Market「角色入口指标」查看同一聚合。事件由登录客户端上报，受限额与去重保护，但不是防篡改的
会话完成证明。

- `POST /api/items/:id/character-detail-open` — 当前账号明确打开公开角色详情
- `POST /api/items/:id/character-start` — 当前账号完成 Market「开始聊天」入口
- `GET /api/items/admin/character-conversions` — 管理员查看满足人数门槛的 30 天聚合

## 可信作者与关注

详情里的「发布账户」由 Auth 已验证的 `market_claims` 归属记录提供，显示名可变、账户 ID 稳定。
卡片手写 `author` 仅为署名，不能用来获得关注身份；旧未验证卡片不猜测归属。
Auth RPC `marketItemCreator` / `marketCreatorItems` 排除封禁及注销处理中账户，返回公开 ID、用户名与显示名；
不返回邮箱、聊天、记忆或账户权限。Market 再次过滤下架/删除条目。

登录用户可关注最多 200 个发布账户，并在「关注作者」查看这些账户最近登记的最多 200 条可见作品。
关注不改变真人社交关注/私聊权限，不奖励 Credit，不提供提现。「管理已关注作者」允许移除已失去公开内容的账户。
PUT 会同时校验当前登录账户和用户刚选择的发布账户 ID，避免内容归属改变后关注到另一个人。
需要 Auth RPC 挂接及 Market `0006_creator_follows.sql` 迁移后才可启用；服务缺失时明确报错。

- `GET /api/items/:id/creator-follow` — 可信发布账户与当前关注状态
- `PUT /api/items/:id/creator-follow?creatorId=<id>` — 明确关注当前显示的发布账户
- `GET /api/items/creator-follows` — 当前用户的关注管理列表
- `DELETE /api/items/creator-follows/:creatorId` — 取消关注，包括已无公开内容的账户
- `GET /api/items/discovery?mode=following` — 关注作者发现流

### 在线草稿自动保存

角色编辑停止输入 1 秒后会串行写入服务器草稿，使用上次确认的 revision 做 CAS；不会写入
localStorage/IndexedDB。初次读取失败或已有未恢复的远端草稿时不会自动覆盖，作者可恢复草稿，
或明确选择用当前内容替换。网络错误/版本冲突保留当前输入并暂停后续自动写入；手动保存沿用
原 revision，不盲目取最新版本覆盖。可重新读取，再确认恢复远端内容。

发布与头像清理共用串行草稿写入队列。发布先暂停自动保存并保存最终快照，再发布并按最终
草稿 revision 清理；期间禁用表单编辑。账号切换永久撤销旧编辑器保存能力，重新登录同账号
也不能复用旧在途任务。公开原件的发布勾选仍需每次检查，不作为可自动恢复的发布授权。

编辑器自身返回/取消、Web 侧栏/手机底栏和浏览器同文档前进后退在未保存时请求确认。
自动保存完成后不阻挡；账号切换和退出登录永远不受旧编辑器保护阻挡。隐藏的 Market 编辑器
不拦截其他模块之间的导航。刷新/关闭仍依赖浏览器 beforeunload 提示（浏览器可能不显示）。
自动保存失败时未保存内容仅留当前页面。Shell 启动前产生、没有导航序号的旧历史条目无法推断
前进/后退方向：拒绝离页会恢复可见 URL，但该旧条目的 URL 可能被替换；新建条目保留前进历史。

## 公开角色举报与审核

原生公开角色详情提供登录后的举报入口，理由固定为危险内容、骚扰、隐私、侵权和垃圾信息；
不收集自由文本或聊天记录。每个账户对同一条目只受理一次，24 小时最多新增 10 条举报，
重复提交幂等且不消耗额外名额。旧波形/普通场景继续使用原管理流程。

Market 管理员可打开「举报审核」，分页查看待处理项目、隐藏角色或驳回举报。
隐藏会结案该角色所有待处理举报；原有管理员隐藏接口也同步结案，删除标记为 removed。
恢复角色不会重新打开已结案举报，重放旧审核请求不会再次隐藏已恢复角色。
举报者身份不出现在任何列表响应中，作者没有举报读取权限。内部账户 ID 用于去重与限流，
当前保留于审核记录；尚未增加独立的举报保留期/账户删除清理任务。

- `PUT /api/items/:id/report` — `{reason}`，仅可见原生角色
- `GET /api/items/admin/reports?offset=0` — 待审核队列，每页 50 条
- `PATCH /api/items/admin/reports/:reportId` — `{action:"hide"|"dismiss"}`

接口由 Auth RPC 验证有效账户，审核另验 admin；均要求匹配的 `X-Account-Id`，返回 private/no-store。
客户端账号切换撤销在途响应。并发审核后请刷新队列；offset 分页不是内容快照。
需先执行兼容增量 Market `0009_item_reports.sql`；本轮仅在测试 SQLite 执行，未迁移远端。
审核是人工处理，不声称自动内容检测或申诉处理；既有管理页的隐藏/恢复入口保留。

### 手绘公开头像

CharacterStudio 的「绘制公开头像」提供 512px 白底画板，支持鼠标/触控、颜色/笔粗/橡皮、清空及最近 20 步撤销。预览确认后才上传 PNG（最多 4 MB），返回 portraitId 进入现有在线草稿与发布版本；原头像在确认成功前保持不变。笔画不写本地持久存储，也不自动上传。未确认画作阻挡发布并纳入离页保护；取消需确认，失败可重试。账号切换销毁画板并废弃旧上传结果。不支持 canvas 的浏览器仍可使用文件上传与 emoji。素材删除沿用先清除草稿引用、再检查版本引用的现有流程；被替换但未引用素材的自动回收仍未实现。

### 当前草稿真实试聊

「试聊当前草稿」直接调用已有托管网关 `/v1/models` 和 `/v1/chat/completions`，复用
`@0xnullai/llm-providers` 的唯一网关地址。先读取实时模型价格/版本与可用余额，再由用户点击
「发送并使用 Credit」启动非流式真实请求；最多 6 轮、每条 4000 字、Prompt 32000 字、每次
最多 512 输出 Token。超出试聊限制不截断草稿，也不发起收费请求。

发送白名单仅包含模型、输出上限、当前名字/Prompt/公开人物设定和页面内的文字轮次，不带
工具、设备、私人记忆、来源原件、图片、正式 conversation/relationship 身份；不写正式聊天、
公开计数或本地持久存储。草稿指纹变化卸载试聊并中止旧请求；关闭、离开 Market、隐藏页面、
账号切换也取消请求。A→B→A 不复用旧响应。取消只能保证停止浏览器等待/交付，不承诺撤销
上游已经产生的用量。成功显示网关返回的 `credit_charged`；失败不猜费用，需查看现有账本。
现有账本归文本/Agent 用量、会话归属 unknown，尚无独立 preview 计费类别。

本地验收：在已授权 origin 上登录有 Credit 的测试账户，打开任意草稿→试聊→确认实时价格
与余额→发送一句话→查看真实回复/结算值和账本；编辑 Prompt 后旧试聊应清空。无网关、登录
或余额时显示真实错误，不提供假回复。该开发轮仅跑协议/UI 回归，未请求生产付费模型。

### 旧多人场景下线

`0013_retire_multi_scene.sql` 删除旧 `multi-scene` 条目并阻止再次写入。Worker 同时拒绝该类型的列表、上传与修改，公开详情不再返回它。迁移不会修改旧角色／场景正文或版本号；旧 Prompt 卡通过内容推断类型。生产环境应用迁移与部署新 Worker 前须完成备份和既有迁移账本核对。
