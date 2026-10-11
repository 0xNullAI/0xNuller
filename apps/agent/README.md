# 0xNuller Agent

中文 | [English](README.en.md)

通过文字对话调用设备工具。Agent 既可作为 `0xNuller` 的模块运行，也保留独立构建。

- 统一主站：<https://0xnullai.com/agent>
- 历史独立版：<https://agent.0xnullai.com>

## 功能

- 支持 OpenAI、Anthropic 及 OpenAI 兼容模型服务。
- 调整强度、播放或设计波形、定时执行和停止输出。
- 使用与 Voice 共用的场景，与 Control、Chat 共用设备连接和安全设置。
- 聊天记录由服务器保存，需要登录；场景与波形继续沿用共享内容同步。
- AI 私聊可上传图片或录制语音附件，账号与会话绑定后在时间线回放。图片只在用户点击
  「让 AI 看图」且当前模型明确声明视觉能力时，经过会话授权读取、压缩后短暂送入本轮模型请求；
  上传本身不会触发识别，图片字节不写入聊天历史。当前托管视觉代理只接受独立观察请求，
  不接受普通角色聊天历史，因此聊天看图暂限明确支持视觉的自备模型。录音可附用户确认的文字，
  与附件一起保存到服务器供后续 AI 回合阅读；没有附文字时仍只供回放，AI 不会假装听过录音。
  用户可明确点击「请 AI 回应文字」发起正常计费的回复；附件录音本身尚未自动转写。
- 私人图片、情境自拍和角色视频任务在同一聊天时间线显示状态与结果；聊天输入栏的「添加聊天内容」可直达角色关系设置中的生成页，也集中提供图片、语音附件、实时通话和摄像头观察入口。媒体任务与聊天消息由服务器分别保存，媒体卡不伪装成模型回复。生成时可单独勾选发送已导入的角色/当前场景快照与最近消息；默认均不发送，私人 Memory 不会自动发给媒体服务。
- 角色关系设置中的记忆页可直接更正已确认事实：新内容和旧事实停用由服务器一次提交，旧来源不会被复制到新事实。
- 网页版通过 Web Bluetooth 连接，安卓壳使用原生 BLE 传输。
- 可直接导入旧 DG-Agent 导出的 ZIP 或 JSON 聊天记录。

模型只能提交工具请求。设备安全策略、权限确认和命令队列在执行层生效，停止操作不依赖模型响应。
每轮请求只把当前已连接且可用的设备、能力和对应工具放入模型上下文；未连接设备不会以名称、状态
或工具定义出现。通用设备还必须先在「软件设置 → 关于」的全局本机开关中启用，并存在健康的振动
capability；开关关闭或设备断开后，下一轮即从上下文移除。

## 使用

1. 在「软件设置 → AI → 文本模型」配置服务。
2. 从顶部设备横栏连接设备。
3. 从 Market 导入角色，在聊天里选择角色与可选场景，然后开始对话。
4. 需要立即结束时，使用顶部横栏的停止操作。

网页版蓝牙需要 HTTPS 或 localhost，以及支持 Web Bluetooth 的 Chrome/Edge。

## 本地开发

在仓库根目录执行：

```bash
npm install
npm run dev -w @dg-agent/web       # 独立 Agent
npm run dev -w @0xnullai/web       # 统一外壳
npm run typecheck -w @dg-agent/web
npm run build -w @dg-agent/web
npm test
```

## 代码结构

```text
apps/agent/                         独立前端入口
apps/agent/src/components/SessionNavigation.tsx
                                    移动端、桌面端和统一外壳的会话导航视图
apps/agent/src/components/AgentModuleProjections.tsx
                                    统一外壳的设置注册与调试入口视图
packages/agent/runtime/             Agent 循环与工具调度
packages/agent/client/              会话客户端
packages/agent/providers-*/         模型适配器
packages/agent/storage-browser/     浏览器存储
packages/agent/waveforms/           Agent 波形能力
apps/web/src/modules/agent.tsx      统一外壳入口
```

设备协议、传输和安全能力来自 `packages/kit`；共享 UI、设置、场景和账户能力来自
`packages/platform`。

`App.tsx` 保留会话生命周期、权限与停止顺序；`SessionNavigation` 只把入口提供的会话操作
投影为移动端抽屉、独立版桌面侧栏或统一外壳列表，不执行运行时工具或设备操作。
`AgentModuleProjections` 只注册入口准备好的传感器、波形、数据与调试视图，并管理调试弹层
的开合；设置保存、设备联动、会话导入导出和安全决策仍由 `App.tsx` 提供的动作处理。

## 导入旧版对话

在旧 DG-Agent 的「设置 → 数据」中导出 ZIP，然后在 0xNuller 的「设置 → 数据 → 导入」中
选择该文件。旧版单个 JSON、多会话 JSON 和新版 ZIP 都可以导入；同 ID 冲突会明确拒绝覆盖，
导入失败不会清空现有记录。模型密钥、设备连接和权限不会导入。

旧本地已分区记录在所属账户登录后自动迁移，服务器回读验证后才清理原件。未分区与匿名记录
需在「设置 → 数据 → 旧本地聊天迁移」中预览并确认当前账户，使用新会话编号导入。网络失败
与并发冲突保留原件。切换账户会停止旧会话活动并撤销尚未批准的权限。

## 协议

[MIT](../../LICENSE)

“专属关系”中可以管理该角色的私人记忆：记录人物、偏好、事件与共同约定，按长期、中期摘录和关系历史
分类。“整理近期对话”生成当前聊天的用户原文摘录、同一私人关系最近 2–3 段聊天的跨会话分段摘录，
以及以“记住：”或“我们约定：”开头的候选；核对、修改并
确认后才供后续检索使用。它不会自动把角色扮演或 AI 猜测当成真实经历。删除或修改来源消息会撤除其派生
记忆；删除候选后同一来源不自动重新生成。跨会话摘录只复用用户原文片段，不是模型生成的抽象摘要，
界面可展开查看来源会话与消息编号，但还不能逐条跳转原消息；拒绝候选会留下服务器墓碑，避免同一来源自动再生。账号的通用个人记忆在「我的 → 个人记忆」二级页管理。
私人关系记忆页还可主动开启自动发现：服务器会把该关系已有和新发的用户消息分批送交 MiniMax，之后新消息生成
待核对候选；默认关闭，服务未配置时不能开启。关闭只停止后续分析，不删除已确认记忆。
记忆设置可刷新查看当前关系的待处理会话数、重试数及连续失败后暂停的任务数。
同一设置页的“人物别名与事实纠错”可为当前关系保存人物别名、将已确认事实关联人物，
或在先保存新事实后替换过时事实。别名只帮助检索当前关系的事实；替换会保留旧事实的修订记录，
旧事实不再进入 AI 上下文。人物别名与用于叙事的“重要人物/共同经历”目前是不同记录，
不会自动互相同步。

会话工作区可保存多步骤计划、标记进度并上传 UTF-8 文本/Markdown 资料。AI 可按需读取当前会话的文件，
也能草拟计划或待确认记忆；文件中的文字不会获得系统指令或设备授权。定时消息工具仅保存暂停草稿，需在
定时界面手动开启。计划的完成标记只是记录，外部操作是否完成应以对应工具结果或用户确认判断。

`CharacterAppearancePanel` includes a local 512×512 canvas avatar editor: mouse/touch drawing,
color, brush width, white eraser and clear. Preview is a temporary object URL. Only the explicit
“确认上传并设为私人头像” action uploads PNG to the existing private photo API and updates the
relationship appearance with CAS; opening/previewing/cancelling never replaces the current photo.
Account changes revoke the drawing and prevent an in-flight upload from assigning the old image
to another account. Unsupported canvas browsers can use upload or the existing photo picker.

个人会话的角色身份固定在 `promptPresetId`；聊天输入区可单独选择或移除 `sceneId`。切换场景
只更新同一条服务器会话的环境 Prompt，不另建角色，也不替换关系、记忆或消息。旧版把纯 Prompt
场景存进 `promptPresetId` 的会话继续作为场景读取，不把它当作拥有私人关系的角色。
旧场景会话可保留已有文字历史；新空会话不能仅凭场景开始聊天，旧场景会话也不能直接
转为语音或摄像头观察。用户需打开角色聊天，再把场景作为可选环境绑定。
