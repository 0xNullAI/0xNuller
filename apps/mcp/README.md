<div align="center">

# DG-MCP

**让 Claude Desktop 等 MCP 客户端直接控制 DG-Lab 郊狼 2.0 / 3.0**

[![npm](https://img.shields.io/npm/v/dg-mcp?color=0a84ff)](https://www.npmjs.com/package/dg-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/built%20on-%40dg--kit%2F*-0a84ff)](https://github.com/0xNullAI/0xNuller/tree/main/packages/kit)
[![官网](https://img.shields.io/badge/官网-0xnullai.com-58c8f2)](https://0xnullai.com)

中文 | [English](./README.en.md)

</div>

## 这是什么

DG-MCP 把郊狼设备暴露成一组 [Model Context Protocol](https://modelcontextprotocol.io) 工具，让任何 MCP 兼容的 LLM 客户端（Claude Desktop、Continue 等）能通过蓝牙直接驱动你的设备——`scan` / `connect` / `shock_start` / `shock_stop` / `shock_adjust` / `shock_change_wave` / `shock_burst` / `design_wave` / `emergency_stop` 全套都是普通的工具调用（旧版 `start` / `stop` / `adjust_strength` / `change_wave` / `burst` 名字仍可调用，但工具列表只展示新名）。

跑在 Node.js 里，通过 stdio 跟客户端通信。基于 [`@dg-kit/*`](https://github.com/0xNullAI/0xNuller/tree/main/packages/kit) 中台，跟 Agent / Chat 共享一份协议代码。

## 状态

- `1.0.0` 正式版，已发布到 npm
- v0.1.x 的 Python 实现归档在 [`archive/0.x-py`](https://github.com/0xNullAI/DG-MCP/tree/archive/0.x-py) 分支，PyPI 上仍可下载但不再更新

## 快速开始

### 安装

不需要预装，`npx` 直接拉：

```bash
npx dg-mcp --version
```

或者全局装：

```bash
npm install -g dg-mcp
```

### Claude Desktop 配置

打开 Claude Desktop 的配置文件，加入：

```json
{
  "mcpServers": {
    "dg-lab": {
      "command": "npx",
      "args": ["-y", "dg-mcp"]
    }
  }
}
```

要预加载波形包：

```json
{
  "mcpServers": {
    "dg-lab": {
      "command": "npx",
      "args": ["-y", "dg-mcp", "--waveforms-dir", "/Users/you/wave-pack"]
    }
  }
}
```

重启 Claude Desktop，对话框里跟 Claude 说"扫描一下郊狼"，它就会调 `scan` 工具找设备。

## CLI 选项

```bash
dg-mcp [options]

  --waveforms <path>      启动时加载一个 .pulse 或 .zip 文件（可重复）
  --waveforms-dir <dir>   加载目录下所有 .pulse / .zip
  --library-dir <dir>     用户导入的 / AI 设计的波形持久化到这个目录
  --help, -h
  --version, -v

  环境变量等价：
  DG_MCP_WAVEFORMS        冒号分隔的多路径
  DG_MCP_WAVEFORMS_DIR    同 --waveforms-dir
  DG_MCP_LIBRARY_DIR      同 --library-dir
```

## 工具列表

### 设备控制（来自 `@dg-kit/tools`）

| 工具                     | 用途                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| `shock_start`            | 冷启动通道，一次设强度 + 波形（旧名 `start`）                    |
| `shock_stop`             | 停止通道；省略 `channel` 停全部（旧名 `stop`）                   |
| `shock_adjust`           | 相对调整强度（±10/步，5s 内最多 2 次）（旧名 `adjust_strength`） |
| `shock_change_wave`      | 不动强度，仅换波形（旧名 `change_wave`）                         |
| `shock_burst`            | 短时拉到目标强度后自动回落（5s 内最多 1 次）（旧名 `burst`）     |
| `design_wave`            | 用 `ramp / hold / pulse / silence` 段落组合新波形                |
| `vibrate_start`          | 负鼠设备启动通道振动，可选带 `pattern` 节奏预设                  |
| `vibrate_stop`           | 停止负鼠振动；省略 `channel` 停全部                              |
| `vibrate_adjust`         | 相对调整负鼠振动强度（5s 内最多 2 次）                           |
| `vibrate_change_pattern` | 不动强度，仅切换负鼠振动节奏预设                                 |
| `vibrate_burst`          | 负鼠短时脉冲后自动回落（5s 内最多 1 次）                         |
| `set_indicator_color`    | 设置爪印 / 灵猫边缘控制 / 负鼠的指示灯颜色，纯外观               |

### MCP 专属

| 工具                     | 用途                             |
| ------------------------ | -------------------------------- |
| `scan`                   | 扫描附近设备                     |
| `connect` / `disconnect` | 蓝牙连接管理                     |
| `get_status`             | 当前连接 / 强度 / 波形 / 电池    |
| `list_waveforms`         | 列出所有可用波形                 |
| `load_waveforms`         | 运行时导入新的 `.pulse` / `.zip` |
| `emergency_stop`         | 立即归零                         |

## 安全

- 强度量程是 **0-200**。冷启动工具自动钳制初始强度 ≤10，请从低强度开始
- 默认软上限是 200；如果你需要更严格的硬限制，让 LLM 客户端策略层加约束
- 设备物理拨轮可以单独叠加强度——MCP 只是输入源，不是绝对天花板
- 任何时候说"紧急停止"，AI 会调 `emergency_stop` 立即归零

## 系统要求

- Node.js ≥ 20
- 支持 BLE 的主机（macOS / Linux 走 BlueZ / Windows 配 noble 兼容适配器）
- DG-Lab 郊狼 2.0（D-LAB ESTIM…）或 3.0（47L121…）

### macOS

首次跑会弹蓝牙权限申请，允许即可。

### Linux

noble 需要 BLE 抓包权限：

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

## 架构

```
        ┌─────────────────────┐
        │ MCP 客户端           │  Claude Desktop / Continue / ...
        └──────────┬──────────┘
                   │ stdio
        ┌──────────▼──────────┐
        │      dg-mcp         │  本仓库
        ├─────────────────────┤
        │  src/server.ts      │  → 把 @dg-kit/tools 工具定义转 MCP schema
        │  src/coyote-device  │  → DeviceClient，驱动 @dg-kit/protocol
        │  src/waveform-lib   │  → 内置 + .pulse/.zip + JSON 持久化
        │  src/noble-shim     │  → noble Characteristic → CharacteristicLike
        └──────────┬──────────┘
                   │ shared
        ┌──────────▼──────────┐
        │     @dg-kit/*       │  core / protocol / tools / waveforms
        └─────────────────────┘
                   │ BLE
        ┌──────────▼──────────┐
        │  Coyote 2.0 / 3.0   │
        └─────────────────────┘
```

## 开发

```bash
git clone https://github.com/0xNullAI/0xNuller.git
cd 0xNuller
npm install
npm run build
npm run dev          # tsx 热重载
```

## 相关项目

| 项目                                                                  | 用途                                   |
| --------------------------------------------------------------------- | -------------------------------------- |
| [DG-Kit](https://github.com/0xNullAI/0xNuller/tree/main/packages/kit) | 共享的 TypeScript 中台（被本项目消费） |
| [Agent](https://github.com/0xNullAI/0xNuller/tree/main/apps/agent)    | 浏览器版 AI 控制器                     |
| [Chat](https://github.com/0xNullAI/0xNuller/tree/main/apps/chat)      | 多人房间与私聊                         |

## 协议

[MIT](./LICENSE)
