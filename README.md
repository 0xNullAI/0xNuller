<div align="center">

# DG-Voice

**打电话式的实时语音 AI，控制 DG-Lab 设备**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/built%20on-%40dg--kit%2F*-0a84ff)](https://github.com/0xNullAI/DG-Kit)

中文 | [English](./README.en.md)

</div>

## 这是什么

DG-Voice 打开就像打电话一样跟 AI 保持连线——不用按住说话，不用打字。模型跑在实时语音服务商那边
（xAI Grok / OpenAI Realtime / Azure OpenAI Realtime / 智谱 GLM-Realtime），自己决定什么时候开
口、什么时候调用设备工具；DG-Voice 负责接通音频、在每次工具调用前后守住安全链，其余不插手。

跟 [DG-Agent](https://github.com/0xNullAI/DG-Agent)（文字聊天）是姊妹项目，共享同一份
[`@dg-kit/*`](https://github.com/0xNullAI/DG-Kit) 协议层和同一套设计语言，但 Agent 循环完全不
同——这里没有"轮次"的概念，模型自己管调度。

## ⚠️ 当前状态：v0.5.0，核心功能已实现但未经真实账号验证

**已经能跑、有测试覆盖的部分**：

- 两种设备（郊狼 / 负鼠）统一连接入口，一个按钮全覆盖，设备层已支持传输层注入（为安卓 Tauri BLE
  铺路）。**不支持爪印 / 灵猫这两种传感器设备**——纯只读传感器接入实时语音会话的价值不足以对应
  它的复杂度，这是明确的范围决策，不是待办
- 完整安全链：策略引擎（强度上限、冷启动钳制、burst 上限）、权限确认、串行命令队列、紧急停止。
  权限确认用的是与 DG-Agent 逐字一致的四档弹窗（仅本次 / 拒绝 / 允许 5 分钟 / 允许本会话，后两档
  折叠在「高级选项」里防误触），弹窗显示的是**过完策略引擎之后的实际命令**，不是模型的原始请求
- 通话中的对话记录会**追加**成完整会话日志（按 provider 的 item_id 归并流式增量），不是只显示最后一句
- 实时语音连接层：`RealtimeSession`（openai-realtime 方言，覆盖 xAI/OpenAI/Azure）+
  `GlmRealtimeSession`（智谱变体）+ `VoiceToolBridge`（工具调用桥接，含并行调用等待与音频排空
  时序）。`session.update` 已改为经典/稳定版事件格式——最初按更新的字段格式写的版本被一次真实
  xAI 联调直接拒绝（报错 "Invalid event received"），已修正
- **人设系统**：内置 7 个场景 + 自定义场景 + 从 DG-Market 导入，都是锁定的持久化 preset，不是自由
  文本框——真正发给模型的 `instructions` 由代码拼装（人设 + 设备能力 + 剧情映射 + 安全规则 +
  实时设备状态），用户改不了安全规则那部分，设备状态会在通话中随连接/强度变化自动刷新并重新推送
- xAI 音色列表运行时调用 `GET /v1/tts/voices` 获取（有 key 才会拉取，失败自动回退到内置列表）
- 设置面板（provider 选择 + 密钥/模型/音色/语速 + 场景 + 权限 + 安全上限）、通话面板（通话中会
  变成居中的通话界面，带计时和实时字幕）、设备状态栏（连接后常驻显示，强度实时刷新，样式与
  DG-Agent 一致）
- 与 DG-Agent 一致的视觉设计（配色、圆角、深浅主题）
- 70 个单元测试

**尚未做到的部分**：

- **还没有完整跑通过一次真实通话**（已修若干实测暴露的 bug：工具桥无限递归崩溃、音频上下文被浏览器
  自动播放策略静音、事件名家族不匹配、权限档位被静默改写导致任何档位都不弹确认——最后这条是安全
  问题，详见 CLAUDE.md）——已确认 `session.update` 的旧字段格式会被真实服务端拒绝并已
  修正为经典格式，但修正后的版本仍未用真实账号完整验证到底（含一次工具调用）。代码里标了
  `NOT LIVE-VERIFIED` 的地方是接下来最可能还需要调整的点
- 安卓壳还没搭（设备层已经做了传输注入的准备工作，安卓端同样只做郊狼 + 负鼠，不接传感器）
- 自定义音色上传、连接测试按钮、费用计时器等体验细节还没做

如果你有对应 provider 的 API Key，欢迎实测并反馈报错信息——这是目前推进这个项目最有效的方式。

## 特性

- **多 Provider** — xAI / OpenAI / Azure 一套客户端零改动通用；智谱 GLM 免服务端中转，浏览器
  本地签 JWT 直连
- **完整工具集** — 与 DG-Agent 一致的 13 个设备工具，全部由模型自主决定何时调用
- **安全保障** — 强度上限、冷启动钳制、burst 上限、通话前一次性授权、紧急停止随时可按
- **完全本地** — 无服务端中转、无数据库；设置存 localStorage，API Key 自带
- **不重复造轮子** — 设备层来自 `@dg-kit/*` 1.13.0，是四个下游项目共用的同一份实现

## 本地开发

```bash
git clone https://github.com/0xNullAI/DG-Voice.git
cd DG-Voice
npm install
npm run dev
```

打开 http://localhost:5173/。Web Bluetooth 需要 **Chrome 或 Edge**。

## 架构

```
src/
  lib/            纯 TS：设备层、安全链、实时语音客户端（无 React 依赖）
  hooks/          React 绑定
  components/     UI（ui/ 是从 DG-Agent 逐字拷贝的 shadcn 组件）
  styles/         设计 token，与 DG-Agent/DG-Chat 共享同一套
worker/           Cloudflare Worker，纯静态资源托管
```

设备层、安全链的具体分工细节见 [CLAUDE.md](./CLAUDE.md)。

## 安全

- 强度量程 0-200，冷启动自动钳制到低强度
- 通话前需要一次性授权，通话中不再逐次弹窗打断体验，但硬上限和策略引擎始终生效、模型无法绕过
- 常驻「挂断并停止」按钮，随时紧急归零

## Sister Projects

| 项目 | 用途 |
|---|---|
| [DG-Kit](https://github.com/0xNullAI/DG-Kit) | 共享 TypeScript 中台（本项目消费） |
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | 浏览器版 AI 控制器（文字聊天） |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | 多人 P2P 房间 + 远程控制 |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP) | MCP 服务端，供 Claude Desktop 等使用 |

## 协议

[MIT](./LICENSE)
