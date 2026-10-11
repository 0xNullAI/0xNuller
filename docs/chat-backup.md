# 聊天独立备份（未完成上线门槛）

在线主存储不是独立备份：AI 会话在 Auth D1 的 `server_conversations` 与
`server_conversation_messages`，真人私聊/群消息在 Chat `RoomDO` SQLite，真人附件在
`dg-chat-media` R2，私人 AI 附件在 Auth `PHOTOS` R2。完整备份必须在同一恢复点覆盖这些存储，
并在隔离环境验证可读、消息顺序、附件引用及删除状态。

仓库目前提供可运行的**加密封装和校验工具**、Auth D1 导出，以及按明确房间 ID 导出
RoomDO 消息和遍历当前 R2 媒体的入口。新 `RoomIndexDO` 可枚举部署后观察到的群和私聊，
但仍无法自动发现此前从未再次访问的旧 RoomDO；因此单独运行任何
一个 `capture-*` 命令**不是完整聊天备份**。
不要将这一工具或 Cloudflare 的时间点恢复称为已经通过恢复演练的生产备份。

在具备相应 Cloudflare 数据权限的运维环境执行；口令由仓库外的密钥系统提供，至少 20 字符，
不得写入命令历史、日志或仓库。`capture-d1` 会在系统临时目录短暂产生 Wrangler 明文 SQL，
退出时清除；运行环境必须使用加密磁盘并限制其他进程读取。导出的 D1 SQL 包含整个 Auth 库，
包括账号数据，而不只是聊天。输出目录应放在独立、受限的存储中，工具本身不上传对象。

```bash
# 将 CHAT_BACKUP_PASSPHRASE、AUTH_BACKUP_TOKEN 从仓库外的密钥系统注入当前进程。
node scripts/chat-backup.mjs capture-d1 /secure/backups/auth-YYYYMMDD --remote
node scripts/chat-backup.mjs capture-auth-media https://0xnullai.com /secure/backups/auth-media-YYYYMMDD
node scripts/chat-backup.mjs verify /secure/backups/auth-YYYYMMDD
node scripts/chat-backup.mjs restore /secure/backups/auth-YYYYMMDD /isolated/empty-restore
```

运维环境也可用一个新目录捕获同一操作批次的三份加密包，并立即做本地恢复结构演练：

```bash
node scripts/chat-backup.mjs capture-batch https://0xnullai.com https://0xnullai.com --index /secure/backups/batch-YYYYMMDD --remote
node scripts/chat-backup.mjs verify-batch /secure/backups/batch-YYYYMMDD
```

批次在 Auth D1、Chat 和私人附件捕获后，会再次导出 Auth D1，并逐行比较聊天消息、会话、
附件记录、房间书签、陪伴关系、Memory、摘要及账号删除表的规范化摘要。期间任何这些表的
新增、修改或删除都会使批次保持 `capturing` 并失败；不相关账户设置变化不会触发失败。
两次 D1 导出的明文仅在加密磁盘的受限临时目录短暂存在。此检查不能发现两次导出间发生又
撤销的写入，也不能给 Chat DO、R2 与 Auth D1 提供同一个事务恢复点；本地演练通过仍不等于
生产级一致备份。

`capture-scheduled` 是供**外部定时器**每次调用一次的入口，不会自行安装定时任务、上传异地存储或删除旧包。
它要求受限的真实备份根目录（不得为符号链接，权限不得开放给组或其他用户）和一份非空、
独立整理的历史房间清单；每次在根目录下创建唯一批次，依次捕获三份加密包、做结构演练，
并将 Chat 包与独立清单核对。`scheduled-result.json` 仅记录计数与状态，不记录聊天内容或房间 ID。
捕获开始前冻结独立清单供本批审计；捕获后若清单字节变化，结果标记为 `ledger-changed`。
清单与 Chat 包不匹配则标记 `inventory-mismatch`；恢复演练出现除“历史覆盖未验证”以外的任何问题，
或 D1 二次核对不一致，则标记 `integrity-failed` 并在 `blockingIssues` 中列出问题代码。
目前历史覆盖和跨存储恢复点仍未确认，因此**此命令永远不返回 0**：

| 退出码 | 含义                                                                  | 调度器处理                                     |
| ------ | --------------------------------------------------------------------- | ---------------------------------------------- |
| 3      | `captured-unverified`：可运行的检查全部通过，历史覆盖仍未验证         | 记录为“已捕获、未验收”，继续监控复制到独立存储 |
| 1      | `ledger-changed`、`inventory-mismatch`、`integrity-failed` 或执行失败 | 需人工处理                                     |

不能把定时执行、退出码 3 或文件存在当作生产备份已通过验收。口令和两个备份令牌仍须由仓库外密钥系统注入。

```bash
node scripts/chat-backup.mjs capture-scheduled https://0xnullai.com https://0xnullai.com /secure/independent-room-ledger.json /secure/backups --remote
```

批次目录固定包含 `auth-d1/`、`chat/`、`auth-media/` 和只含状态/计数的结果文件。
批次结果另记录三个加密组件的逐文件 SHA-256 汇总指纹；`verify-batch` 会在恢复演练前核对，
以拒绝误换、增删或修改某个组件后仍碰巧得到相同计数报告的批次。指纹不包含明文内容，
也不证明三个来源具有同一事务恢复点，且结果文件本身须由受限备份存储保护。
目录必须事先不存在；任一捕获失败会保留 `capturing` 标记，不能验证为完整备份。
当前历史房间覆盖仍是 `unverified`，因此命令会保留已加密捕获物、标记
`captured-unverified` 并以非零状态退出，供后续核对；不能把这个批次称为已验收的生产备份。
三个捕获仍不是同一事务恢复点，批次入口不会消除该限制。

`capture-d1` 也接受 `--local` 用于本地测试。`pack <source-dir> <backup-dir>` 可将**已经导出的**
DO 快照和 R2 对象连同 D1 SQL 封装；输入目录只允许普通文件，不允许符号链接。每个对象使用
AES-256-GCM 独立随机 nonce，加密清单记录相对路径、大小和 SHA-256；密钥通过随机 salt 和
scrypt 从口令派生。`verify` 不落明文文件，并会读取、认证每个密文；`restore` 只写尚不存在的新目录，
不得直接指向现役数据库或媒体桶。任何媒体都须在隔离恢复后再验证引用和权限，校验通过不等于
业务恢复成功。

Chat Worker 的 `/api/groups/backup/messages`、`media-list`、`media` 只接受服务端配置的独立
`CHAT_BACKUP_TOKEN`（至少 32 字符），令牌不能下发给 App。客户端不提供备份入口。运维者需
先从可信资产清单准备 JSON 数组形式的房间 ID 文件，随后在受限环境运行：

```bash
# CHAT_BACKUP_TOKEN 和 CHAT_BACKUP_PASSPHRASE 由仓库外的密钥系统注入。
node scripts/chat-backup.mjs capture-chat https://0xnullai.com /secure/room-ids.json /secure/backups/chat-YYYYMMDD
# 新索引上线并完成历史回填之后，也可按索引捕获：
node scripts/chat-backup.mjs capture-chat https://0xnullai.com --index /secure/backups/chat-YYYYMMDD
node scripts/chat-backup.mjs verify /secure/backups/chat-YYYYMMDD
```

若有从旧部署记录、既有备份和运维资产清单**独立整理**的完整房间清单，可将它保存为
`[{"code":"...","kind":"group"|"dm"}]`，用下列命令与已加密的 Chat 包核对。
命令逐项比较房间 ID、类型和消息文件，输出只含计数；发现缺失、额外房间或类型不符时退出码为 1。
不要把同一房间索引的导出再当成“独立清单”，否则无法发现索引本身漏掉的旧房间。

```bash
node scripts/chat-backup.mjs audit-history /secure/backups/chat-YYYYMMDD /secure/independent-room-ledger.json
```

即使 `inventoryMatched` 为 true，结果中的 `historicalCoverage` 仍为 `unverified`。
清单来源、核对人、核对时间和恢复点仍需独立留痕，且还须完成跨存储一致性和隔离恢复演练；
此命令不更改备份包，不会自动提升验收状态。

可以在**隔离主机**上对同一批次的三个加密包执行恢复演练；命令只在系统临时目录解密，
将 D1 SQL 导入临时 SQLite，逐房间检查消息数量、时间和 ID 顺序、媒体对象大小与双向引用
（消息缺附件或媒体无对应消息都会失败），
同时检查 AI 会话 metadata 可解析、消息角色与顺序字段有效、收件箱序号不超出会话记录，
以及 AI 私聊附件是否仍关联有效消息。陪伴关系、活跃个人记忆的来源消息与反向索引、
长对话摘要的关系和来源消息也会逐项核对；缺失 Memory 表或断开的关联不能通过演练。
已删除记忆若仍保留标题、正文或反向来源索引，演练也会拒绝通过，避免隔离恢复后重新暴露本应擦除的内容。
房间墓碑、Chat 账号删除墓碑与 Auth D1 的账户删除作业
也会检查；缺少 Auth 删除标记表不能通过演练。输出仅包含计数和问题代码，
不包含内容；任何问题会使退出码为 1。

演练还会把 Auth D1 的 `user_chat_rooms` 群聊书签与 Chat 房间索引交叉核对，缺表、缺房间或类型不符均不通过；
这只能证明已存书签的覆盖，不能发现无书签的旧房间。恢复的媒体消息引用会验证对象 ID 与大小的基本格式，
避免损坏引用被计作可恢复附件。

```bash
node scripts/chat-backup.mjs exercise /secure/backups/auth-YYYYMMDD /secure/backups/chat-YYYYMMDD /secure/backups/auth-media-YYYYMMDD
```

当前 `capture-chat` 的 `historicalCoverage` 固定为 `unverified`，因此现有生产捕获**不会**
通过完整覆盖门槛。不能仅手工改为 `verified`：必须先独立核对历史房间清单、索引和跨服务
删除状态，并记录由谁、何时、按什么恢复点确认。Auth R2 私聊附件使用独立的
`AUTH_BACKUP_TOKEN`（至少 32 字符）通过 `/api/auth/backup/attachments/list` 与 `content`
按已提交 D1 记录分页导出；令牌只留在运维环境，绝不下发客户端。`capture-auth-media`
将附件元数据与字节另行加密打包，演练将它们与 D1 记录逐项比对，缺少或多出对象都失败。
`capture-auth-media` 在读取所有字节后重新分页列出 D1 附件，并用只读 `head` 接口
复查每个 R2 对象的 ETag；`capture-chat` 同样重列 Chat R2 的键、大小和 ETag。
下载 Chat 媒体时还会将实际字节数与清单大小核对，即使 ETag 相同也拒绝截断响应。
导出窗口内发现增删或替换会中止打包，需重新捕获。
此入口只覆盖已提交的私人 AI 聊天附件；待提交附件和同桶中的资料照片、媒体生成任务产物
不在这个聊天备份包内，不能把它当作整个 Auth R2 桶的备份。
三个捕获命令并非同一事务；导出期间附件变更仍需补抓或重新捕获。账号删除墓碑目前也会令演练失败，
直到旧备份清理或密钥销毁策略可以证明恢复不会复活数据。通过本地结构演练仍不能证明
多个存储处于同一个事务恢复点，也不能代替 staging 中的真实读回和权限验证。

`capture-chat` 对每个房间按游标读取两遍原始消息；每页还核对 RoomDO 报告的总消息数，
并要求其持久房间身份与请求 ID 完全一致。索引或人工清单误列从未创建的房间时，备份接口
返回冲突并中止捕获，不能将空响应当成已备份的空房间。
页间总数变化或末页提前结束会中止捕获。两遍的消息 ID、顺序或内容不一致时也会中止，
要求重新运行。随后遍历 R2 当前对象并逐一下载。下载媒体后还会逐房间重读消息，并重新列出账号删除墓碑；索引模式也会重列
房间身份与删除状态。导出窗口内如有消息增删改、账号删除或房间墓碑变化，捕获会中止，
而不是将不同时间的状态封装在同一包。通过上述检查后才加密并逐文件校验。明文只短暂出现在
受限临时目录；运行环境同样需要加密磁盘。`coverage.json` 明示房间
枚举来源和 `historicalCoverage: unverified`。新索引在群/DM WebSocket 路由到 RoomDO 前持久登记；
索引故障时拒绝新连接。群被关闭或到期回收时写入墓碑，之后的登记不会抹去墓碑。
`/api/groups/backup/rooms` 仅接受独立备份令牌，按 100 条游标列出状态；
`/api/groups/backup/rooms/backfill` 接受最多 100 个经运维清单核对的 `{code,kind}`，来源记为
`historical-hint`。回填仅登记已知身份，**不会**凭空扫描 Durable Object 命名空间，也不等于
证明该房间仍有消息。现有账号反向注册表只覆盖已观察的群，不含所有旧群和所有 DM；必须与 Auth
D1、历史运维清单和旧备份核对，缺少任何房间就不得标为完整备份。跨 D1、DO、R2 的导出也还不是同一
事务快照；若导出期间消息或媒体变化，需补做增量捕获与恢复验证。此入口尚未部署到生产。

账号删除先在 `AccountRegistryDO` 保存不可撤销墓碑，再把账户删除作业 ID 同步到房间索引；
索引导出的 `account-tombstones.json` 随加密包保存。索引写失败会使 Chat 删除调用返回待重试，
不能把旧备份中该账户的数据直接恢复上线。墓碑能标识删除，但还未实现跨所有旧快照的自动清理、
密钥销毁或可证明的遗忘流程。

**上线前待完成：** 核对并回填未再次访问的旧版 RoomDO、逐房间一致性导出与
增量/删除墓碑；为 R2 媒体建立跨服务引用校验；定时执行、异地保存、保留期和失败告警；
在隔离 staging 回读 AI、DM、群和附件。账号删除、消息删除、旧群到期后的备份清理或加密密钥
销毁必须定义可证明的策略，避免旧快照复活已删除内容。现有工具不自动执行这些操作。
