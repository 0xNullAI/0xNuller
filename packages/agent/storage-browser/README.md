# @dg-agent/storage-browser

Agent 浏览器存储实现：网站使用服务器会话，设置与旧 IndexedDB 数据保留兼容迁移边界。

```ts
import { BrowserSessionStore, BrowserAppSettingsStore } from '@dg-agent/storage-browser';
```

第三方模型 API Key 仅保存在当前设备，不进入账户同步。

`BrowserDiagnosticStore` 将调用方已限制容量的诊断记录异步增量写入 IndexedDB，串行化写入和
删除。Agent 日志最多保留 100 条、256000 UTF-16 code units，单条大请求截断；开启诊断时才
加载和迁移旧 localStorage 日志，迁移保存成功后删除旧记录。保存失败通过共享设置警告反馈。

## 服务器会话（网站默认）

`ServerSessionStore` 是网站默认历史存储，通过 `/api/auth/conversations` 读写，以 revision
做并发校验并按会话串行保存；网络失败不回退 IndexedDB，也不覆盖另一端。纯追加消息遇到
跨端 409 时，仅在近期窗口能核对共同消息、角色与场景未变且没有旧消息改写时，最多两次
重新读取版本并合并远端新消息；超出窗口、元数据变化或历史冲突仍显式 409。请求携带
当前账户 ID，账户切换使未完成结果与旧 snapshot 失效；同账户 profile 刷新不取消会话。
已保存会话新增的用户/助手消息和流式助手正文的单向延长只把变更的消息提交到 `/messages`；
场景与标题变更只提交受限元数据并返回版本，不传输聊天正文；不支持的历史改写仍走旧版
整段 PUT，因此长历史写入上限尚未完全解除。
只有设备状态或本地运行字段变化时不写服务器，也不推进会话 revision；当前设备状态仍只在本机保留。
打开的服务器会话同次返回消息和 `lastSequence`；存储层以不可上传的内部标记将序号附在该快照，
供聊天视图在消息尾部实际可见后标记已读。收件箱较新的摘要序号不能代替已展示快照的序号。
未登录可显示空会话，但发送第一条消息要求登录。服务器仅保存公开对话字段与
`sessionTitle`、`promptPresetId`、`relationshipId`、`sceneId`；设备状态、权限与工具执行数据不上传。

原 `BrowserSessionStore` 保留用于旧数据兼容，不再被网站组合层创建。账户分区的旧记录只在
该账户登录后迁移；上传后回读比较消息与元数据（不比较服务器更新时间），事务确认本地
原件未变后删除。旧删除墓碑也需要服务器确认，不删除较新的远端内容。失败保留原件并提示。

所属不明的匿名／未分区记录不会自动认领。设置 → 数据的迁移入口预览数量与标题，明确显示
目标账户；用户确认后使用按账户和原件派生的新 ID 复制，回读验证再删除。其他账户分区始终
排除。`TransientSessionTraceStore` 不持久化或恢复正文 trace；模型调试记录仅保留在当前页面。
兼容用的 `BrowserSessionTraceStore` 原样保存旧 trace 与新的 `tool-unknown` 事件，回读时不把
待核对结果解释为成功或失败。网站默认仍使用临时 trace，不将正文 trace 写入本地数据库。
旧诊断数据库未自动删除，也不再读取；它不作为新会话来源。
