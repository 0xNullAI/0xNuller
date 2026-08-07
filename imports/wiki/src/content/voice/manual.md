# DG-Voice · 使用手册

打开就像打电话一样跟 AI 保持连线的实时语音控制器。

> [GitHub](https://github.com/0xNullAI/DG-Voice) · 在线体验（部署后）：voice.0xnullai.com

## ⚠️ 当前状态：v0.1.0，语音尚未接通

这份手册描述的是**目标形态**。DG-Voice 现在已经能跑、有测试覆盖的部分：

- 四种设备（郊狼 Coyote / 负鼠 Opossum / 爪印 paw-prints / 灵猫边缘控制 civet-edging）统一连接入口，一个按钮全覆盖
- 完整安全链：策略引擎（强度上限、冷启动钳制、burst 上限）、权限确认、串行命令队列、紧急停止
- 与 DG-Agent 一致的视觉设计（配色、圆角、深浅主题）

**还没有的部分**：实时语音连接本身、设置面板、安卓壳、正式部署。首页的"实时语音通话"区块目前是占位符——如果你是来找一个能直接打电话式对话的语音助手，现在还不是时候，请先关注 [DG-Agent](#/agent/manual)（文字/按住说话）作为可用替代。

以下内容按建成后的样子写，供预览和给贡献者对齐目标。

## 这是什么

DG-Voice 打开页面即保持一条到 LLM 的实时语音连接——不用按住说话，不用打字。模型跑在实时语音服务商那边（xAI Grok / OpenAI Realtime / Azure OpenAI Realtime / 智谱 GLM-Realtime），**自己决定**什么时候开口、什么时候调用设备工具；DG-Voice 只负责接通音频、在每次工具调用前后守住安全链。

跟 [DG-Agent](#/agent/manual)（文字聊天 + 按住说话）是姊妹项目，共享同一份 [`@dg-kit/*`](#/kit/overview) 协议层和同一套设计语言，但 Agent 循环完全不同——DG-Voice 没有"轮次"概念，模型自己管调度，DG-Voice 不写一行调度循环代码。

## 浏览器要求

- **Chrome 或 Edge**（Web Bluetooth 依赖）
- 麦克风权限
- 一个受支持 provider 的 API Key（自备）

## 使用流程（目标形态）

1. 打开页面，选择/配置一个语音 provider（xAI / OpenAI / Azure / 智谱 GLM）并填入自己的 API Key
2. 按需连接设备——支持郊狼、负鼠、爪印、灵猫任意组合，可同时连多个
3. 点"开始通话"，一次性授权后进入持续连接状态，像打电话一样跟 AI 对话
4. AI 根据对话内容自主决定何时调用设备工具，所有调用都过安全链
5. 说"挂断"或按常驻按钮结束通话，`emergencyStop` 立即归零

## 工具详解

与 [DG-Agent 的 13 个设备工具](#/agent/manual)完全一致（来自 `@dg-kit/tools`）：

- 郊狼：`shock_start` / `shock_stop` / `shock_adjust` / `shock_change_wave` / `shock_burst` / `design_wave`
- 负鼠：`vibrate_start` / `vibrate_stop` / `vibrate_adjust` / `vibrate_change_pattern` / `vibrate_burst`
- 传感器（爪印/灵猫）：`set_indicator_color`

与 DG-Agent 不同的一点：DG-Voice 不按连接状态过滤工具列表——13 个工具一次性全部声明给模型，未连接对应设备时工具调用会在执行层被拒绝并附带原因，而不是从工具表里隐藏。这是因为大多数实时语音 provider 不支持通话中途更新工具表，全量声明规避了这个限制。

## 支持的语音 Provider

| Provider | 音色 | 特点 |
|---|---|---|
| **xAI Grok** | 26 内置 + 自定义音色选用 | 基线实现，$0.05/分钟 |
| **OpenAI Realtime** | 10 内置 | 与 xAI 同一套客户端，零改动 |
| **Azure OpenAI Realtime** | 10 内置 | 同上，纯配置差异（部署名代替模型名） |
| **智谱 GLM-Realtime** | 7 内置 | 唯一不需要任何网络请求换票的 provider——本地签 HS256 JWT 直连，国内用户最省 |

四家都是**浏览器直连**，不经过任何服务端中转——DG-Voice 本身没有后端，纯静态托管。

## 安全约束

- 强度量程 0-200，冷启动自动钳制到低强度
- 通话开始前需要一次性授权，通话中不再逐次弹窗打断"打电话"体验，但硬上限和策略引擎全程生效，模型无法绕过
- 常驻"挂断并停止"按钮，随时紧急归零所有已连接设备
- 页面隐藏/离开、安卓端锁屏都会自动触发挂断 + 紧急停止

## 隐私

- API Key 自备，只存在你的浏览器本地（localStorage），不经过任何 DG-Voice 服务器
- 没有服务端中转、没有数据库——语音音频直接在你的浏览器和你选择的 provider 之间传输
- 蓝牙数据完全本地

## 免责声明

> **本项目仅供学习交流使用，不得用于任何违法或不当用途。**
>
> 强度从低开始，熟悉响应曲线再放开上限。任何时候不舒服，说「挂断」或按下常驻按钮立即归零。
>
> 使用者自行承担一切风险，项目作者不对因使用本项目而导致的任何损害承担责任。
