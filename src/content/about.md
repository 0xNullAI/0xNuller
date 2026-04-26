# 关于

DG 系列是围绕 DG-Lab 郊狼 2.0 / 3.0 的开源工具集，目标是让 LLM 直接控制脉冲设备这件事变得**安全、可复用、跨产品**。

## 项目家族

```
DG-Kit (中台)
  ├── DG-Agent  浏览器版 AI 控制器
  ├── DG-Chat   多人 P2P 房间
  └── DG-MCP    Claude Desktop / Continue 等 MCP 客户端的桥
```

## 设计准则

**一份代码，三个产品**。蓝牙协议、波形数据、工具定义这些会反复用到的核心，永远只写一次，发到 npm 上让所有消费者拿去——这是 DG-Kit 存在的全部理由。

**安全是协议层的事**。强度上限、冷启动钳制、紧急停止、回合限速，这些约束嵌在 `@dg-kit/protocol` 和 `@dg-kit/tools` 里，LLM 调用工具时无法绕过。UI 层的"安全提醒"是辅助提示，不是真正的防线。

**完全开放**。不收集数据、不走自己的服务器、不上传任何东西。会话、波形库、设置全在你浏览器里；MCP 服务器走 stdio，跟 Claude Desktop 之间没有第三方。

**先做对，再做快**。三个项目都从原型迭代过来，每一次重构（DG-Agent 抽中台、DG-MCP 从 Python 改写为 Node、DG-Chat 把 684 行 BLE 替换为 18 行 shim）都是在已经跑通的基础上精简。新功能进协议层之前，会先在某个消费者验证跑通再往中台抽。

## 协议

整个家族都是 [MIT](https://opensource.org/license/mit) 协议。商业自由使用，无任何 attribution 强制要求（但欢迎在你的项目 README 里链回来）。

## 免责声明

> 本系列项目仅供学习交流使用，不得用于任何违法或不当用途。使用者应自行承担使用所产生的一切风险和责任，项目作者不对因使用本系列项目而导致的任何直接或间接损害承担责任。

## 参与

每个项目的 GitHub 仓库都接受 issue / PR：

- [DG-Kit](https://github.com/0xNullAI/DG-Kit) — 协议层、波形、中台修复
- [DG-Agent](https://github.com/0xNullAI/DG-Agent) — UI、LLM 集成、桥接器
- [DG-Chat](https://github.com/0xNullAI/DG-Chat) — P2P、房间体验
- [DG-MCP](https://github.com/0xNullAI/DG-MCP) — MCP 工具、Node BLE
- [DG-Wiki](https://github.com/0xNullAI/DG-Wiki) — 你正在看的这份文档站

DG-Agent 的开发分支是 `dev`（不是 `main`）；其它项目都用 `main`。改文档？最方便就是右上角点 **↗ pr** 直接在 GitHub 上提。

## 致谢

感谢 [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE) 公开郊狼 BLE 协议规范，让这一切成为可能。
