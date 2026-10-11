# Agent 架构

Agent 是统一 Web/Android 产品内的功能模块，不再是独立产品 runtime。本文只补充
`docs/architecture.md` 中与模型驱动控制相关的边界。

当前工具路线集中在郊狼及其他已支持设备的控制。记忆是陪伴产品的核心上下文服务，
主动消息和媒体生成也由各自产品服务负责；它们不依赖扩充设备工具集。文件、任务、提醒等
非设备工具可在有明确场景、权限和结果边界时逐项增加，不与记忆本身或角色 Prompt 混为一谈。
语音通话在开始时载入私人关系和 Memory，并提供只读 `memory_search` 供通话中按问题再次检索；
该检索只接受当前账号、会话和关系，返回资料与原话来源，不进入设备工具执行器。

## 当前链路

```text
apps/agent UI
  -> packages/agent/agent-browser 组合层
  -> packages/agent/client
  -> packages/agent/runtime
  -> @dg-kit tools / safety / protocol 契约
  -> 外壳提供的浏览器或 Tauri 设备 session
```

`apps/web` 装配 Agent 界面，`android/app` 提供 Android 生命周期与 Tauri BLE 能力。浏览器内嵌
runtime 仍是默认路径；CLI 或 daemon 目前不是交付物。

## 包职责

- `apps/agent`：React 渲染、用户输入、会话展示、界面专用 hook。
- `packages/agent/agent-browser`：不依赖 React 的浏览器服务组合。
- `packages/agent/client`：embedded/remote client 边界。
- `packages/agent/runtime`：轮次、工具执行、命令队列、策略、trace、触发器。
- `packages/agent/core`：建立在 `@dg-kit/core` 上的 Agent 契约。
- `packages/agent/providers-*`：模型 provider HTTP 适配。
- `packages/agent/audio-browser`：浏览器语音适配。
- `packages/agent/storage-browser`：设置、会话和 trace 持久化。
- `packages/agent/bridge`：远程消息桥接及其权限/队列边界。
- `packages/agent/waveforms`：Agent 面向共享波形库的适配层。

会话导航只读取服务端摘要，内容搜索在服务端按账户过滤。Agent 界面首次读取最近 20 条消息，再按服务端序号加载更早页；UI 窗口带只读标识，存储层拒绝将它作为完整会话写回。导出逐页读取完整原文并核对会话版本，若跨端编辑发生于导出期间则报错重试。已有角色绑定的个人网页会话发送新消息时，也从近期窗口启动，只允许在该窗口上增量追加消息或修改标题/场景；任何其他变更拒绝整段重写。新会话、首次绑定角色、桥接会话与旧记录迁移仍读取完整会话。模型输入另有 32,000 字符上限，并可通过独立的 Memory 服务检索较早事实。用户只说“继续说”等无关键词续聊请求时，Memory 服务取同一私人会话最近的较早用户原话片段，以及该关系已确认的记忆；片段保留来源消息编号，仍只是参考资料，不作为事实或设备指令。

模型输入预算同时计算人设、私人 Memory、设备说明、当前回合临时内容和近期历史；超出时只裁掉完整的较早用户回合，最新用户原文不截断。服务器原始消息仍完整保存。较早内容由用户开启的会话摘要提供连续性，已确认事实由独立 Memory 检索提供，二者不能互相提升为真实事实。参考 [Mem0 的记忆 CRUD 与范围过滤](https://docs.mem0.ai/platform/quickstart) 和 [其图记忆设计](https://docs.mem0.ai/open-source/features/graph-memory)，下一阶段优先评测检索质量、别名与纠错，再考虑引入向量或图索引；[对话记忆检索研究](https://arxiv.org/abs/2603.02473) 也提示单纯增加写入摘要复杂度不能替代检索评测。第三方服务不得绕过现有账号/关系隔离、删除墓碑和用户授权。

## 不变量

- UI 调用 Agent client，不自行构造协议帧，也不绕过安全层。
- `session.messages` 只存用户可见对话；工具结果、拒绝、失败、定时器进入 session trace；临时触发
  信息不持久化。模型上下文不得把缺少配对结果的历史工具叙述重新当成普通助手事实。
- runtime 和 provider 包不依赖 React 或 app 源码。
- 设备队列和播放状态按设备隔离；波形定义只按类型共享，与 Control、Chat、Voice 使用同一规则。
- 工具结果拒绝、失败或待核对时，同批后续普通调用停止；郊狼旧别名、负鼠及通用设备的停止/急停工具仍可执行。若任务收据服务不可用，停止继续尝试但结果标为待核对。
- 模型文字不能作为设备执行凭证；共享 runtime 在展示或朗读前核对本回合收据，也拦截“我把郊狼打开了”“刚帮你把设备关掉了”等完成式措辞。计划与假设不视为执行结果。收据确认的是本地执行边界的返回，仍不能替代真实硬件状态验收。
- 浏览器/Tauri 差异终止于组合或 transport 层，不进入工具语义。

## 多台郊狼如何由 AI 选择

Agent 会把每一台当前连接的郊狼作为独立目标展示给模型。即使两台设备名称完全相同，状态中也会
分别列出它们的 A/B 通道强度、上限、波形状态和一个临时 `targetId`。设备名称只帮助人阅读，
AI 的每个 `shock_*` 调用都必须逐字填写 `targetId`；应用不会把一个调用广播到多台设备，也不会
根据名称猜测目标。

`targetId` 是一次物理连接的临时身份，不是蓝牙地址、设备名称或可持久化标识。设备断开后，旧
身份立即失效；同一设备重新连接也会获得新身份。这样旧会话、延迟到达的模型调用或同名设备都
不能意外命中另一台仍在线的设备。

一次调用的实际路径是：模型选择当前 `targetId`，runtime 读取该实例的实时状态并执行安全策略，
需要时请求用户权限，再检查 Agent 的设备租约，最后由目标路由器重新确认身份和连接状态并写入
这一台设备。每个目标有独立的串行命令队列；停止仍保持可达，紧急停止仍可覆盖所有在线实例。

单台设备也使用同一套 `targetId` 规则，因此从一台增加到多台时不会改变工具语义。当前多实例
精确路由只覆盖郊狼；负鼠和两个只读传感器仍各自最多连接一台，通用实验设备使用其独立的
`deviceId`/`featureId` 能力路由。

## 测试

纯 runtime 状态与工具策略测试放在 `packages/agent/runtime` 源码旁；provider、storage、bridge、
浏览器组合测试各自留在所属包；React 交互测试放在 `apps/agent` 源码旁，`src/__tests__` 只用于
app 级组合契约。

新增设备工具必须覆盖 schema/registry、runtime 执行、安全拒绝、未连接行为及对应设备类型。
全仓规则见 `docs/testing.md`。
