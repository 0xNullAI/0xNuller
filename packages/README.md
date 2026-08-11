# Packages

本目录按依赖方向分为三层：

- `kit/`：已发布到 npm 的设备协议、安全、工具和传输基础包。
- `agent/`：无 UI 的 Agent 类型、运行时、provider、存储与浏览器组合层。
- `platform/`：0xNuller 应用共享的账户、同步、内容库、设置、原生桥接和设计系统。

每个包都有自己的 README 和单一入口。复用时优先依赖最小层级：协议应用使用 `kit`，自建
Agent 使用 `agent/core + runtime + provider`，只有 0xNuller 外壳能力才依赖 `platform`。
设备控制权限不会从账户、模型或 UI 包隐式获得。
