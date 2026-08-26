# 0xNuller Agent

中文 | [English](README.en.md)

通过文字对话调用设备工具。Agent 既可作为 `0xNuller` 的模块运行，也保留独立构建。

- 统一主站：<https://0xnullai.com/agent>
- 历史独立版：<https://agent.0xnullai.com>

## 功能

- 支持 OpenAI、Anthropic 及 OpenAI 兼容模型服务。
- 调整强度、播放或设计波形、定时执行和停止输出。
- 使用与 Voice 共用的场景，与 Control、Chat 共用设备连接和安全设置。
- 对话、场景与波形保存在浏览器；登录后可同步受支持的数据。
- 网页版通过 Web Bluetooth 连接，安卓壳使用原生 BLE 传输。
- 可直接导入旧 DG-Agent 导出的 ZIP 或 JSON 聊天记录。

模型只能提交工具请求。设备安全策略、权限确认和命令队列在执行层生效，停止操作不依赖模型响应。
每轮请求只把当前已连接且可用的设备、能力和对应工具放入模型上下文；未连接设备不会以名称、状态
或工具定义出现。通用设备还必须先在「软件设置 → 关于」的全局本机开关中启用，并存在健康的振动
capability；开关关闭或设备断开后，下一轮即从上下文移除。

## 使用

1. 在「软件设置 → AI → 文本模型」配置服务。
2. 从顶部设备横栏连接设备。
3. 选择场景并开始对话。
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

旧版记录迁移步骤见[聊天记录迁移说明](../../docs/agent-history-migration.md)。

## 协议

[MIT](../../LICENSE)
