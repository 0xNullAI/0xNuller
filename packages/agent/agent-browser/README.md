# @dg-agent/agent-browser

浏览器端 Agent 组合层，负责把 Web Bluetooth、浏览器存储、语音、模型 provider 和运行时
装配为可直接供界面使用的客户端。

```ts
import { createBrowserAgentClient } from '@dg-agent/agent-browser';
```

Android 可通过注入原生连接能力复用同一组合层；安全与账户同步由各自共享包提供。

`@dg-agent/agent-browser/llm` 的 `createBrowserLlmClient` 是 Agent、Chat 与 Video 共用的文本/视觉请求工厂；
托管与自定义两种 provider 都走 `@dg-agent/providers-openai-http`，托管账户头、全局 HTTP 代理和图片能力
都在这里解析。`discoverBrowserProviderModels` 与 `testBrowserProviderConnection` 为自定义接口的设置
提供同一套浏览器边界。

通用设备经 `@0xnullai/device-runtime` 的 AI allowlist 与 schema adapter 注入。Agent 这里只将
共享定义适配到 runtime registry；权限、quota、trace 和 stop 顺序仍由 Agent runtime 执行。

个人 Agent 组合显式启用服务端私人关系与记忆：每次模型迭代重新读取当前账号数据，不使用本地持久缓存。
只有来源为 `web` 且不含群会话标记的个人对话会加入这些资料；系统提醒和传感器回合不读取。
旧版外部消息桥接留下的会话（metadata 含 `bridgeOrigin`）仍按外部会话处理，不读取私人资料。
专属 AI 名字覆盖公开人设中的自称，用户称呼和共同约定作为引用资料加入；这些资料不能授予工具或设备权限。
账号切换、接口失败或关系删除时不沿用旧数据，原设备执行边界与停止规则不变。

个人会话按 `session.metadata.promptPresetId` 选择角色，缺失时才使用当前全局选择。
可选的 `session.metadata.sceneId` 只叠加已保存的场景环境 Prompt，不能替换角色身份或取得私人记忆；
显式空字符串会清除场景。旧版把纯 Prompt 场景存入 `promptPresetId` 的会话仍按场景呈现。
首次成功读取该角色的私人关系会绑定 `relationshipId` 并随回合保存；删除关系后不会自动改绑新关系。
已导入的公开场景与旧版纯 Prompt 自定义场景只提供环境规则，不读取角色关系上下文，
也不提供角色记忆检索、记忆建议或主动消息工具；已建立的内置角色继续沿用原有关系行为。

默认组合使用 `ServerSessionStore` 与不落盘的 trace；未登录可打开界面，但真实消息必须先通过
服务器保存。服务销毁时解除账户订阅，设备连接实例继续由外壳保持。
组合层可选注入 `taskRunReporter`，供统一应用把 Agent 回合连接到服务器 TaskRun。网页用户回合
须传入服务器分配的 `runId`；内部回合缺少该编号时仍可生成文字，但不会提供工具。

个人 Agent 的通用工具包括 `memory_search`、`memory_propose`、`task_plan_list/save`、`file_list/read` 和
`reminder_propose`。只向本人当前网页私人会话开放，并在执行时重新校验账号与会话；群、旧版外部桥接会话和系统触发不暴露。
记忆写入仅产生待确认候选，计划保存采用版本 CAS，文件只读当前会话已上传内容。定时工具强制创建暂停草稿，
用户在定时消息界面检查后开启才会发送。没有配置网络搜索服务时不宣称已搜索，也不提供任意 URL 抓取。

私人Agent的 `allowPersonalContext` 组合同时显式启用托管消费会话关联，将正在执行的session
传给provider账务头；不从全局选中角色推断。公共房间/默认组合不启用这项私人关联。
