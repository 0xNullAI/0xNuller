<div align="center">

# DG-Kit

**DG-Lab 郊狼 2.0 / 3.0 的共享 TypeScript 中台**

[![npm: @dg-kit/core](https://img.shields.io/npm/v/@dg-kit/core?label=%40dg-kit%2Fcore&color=0a84ff)](https://www.npmjs.com/package/@dg-kit/core)
[![npm: @dg-kit/protocol](https://img.shields.io/npm/v/@dg-kit/protocol?label=%40dg-kit%2Fprotocol&color=0a84ff)](https://www.npmjs.com/package/@dg-kit/protocol)
[![npm: @dg-kit/waveforms](https://img.shields.io/npm/v/@dg-kit/waveforms?label=%40dg-kit%2Fwaveforms&color=0a84ff)](https://www.npmjs.com/package/@dg-kit/waveforms)
[![npm: @dg-kit/tools](https://img.shields.io/npm/v/@dg-kit/tools?label=%40dg-kit%2Ftools&color=0a84ff)](https://www.npmjs.com/package/@dg-kit/tools)
[![npm: @dg-kit/transport-webbluetooth](https://img.shields.io/npm/v/@dg-kit/transport-webbluetooth?label=%40dg-kit%2Ftransport-webbluetooth&color=0a84ff)](https://www.npmjs.com/package/@dg-kit/transport-webbluetooth)
[![npm: @dg-kit/transport-tauri-blec](https://img.shields.io/npm/v/@dg-kit/transport-tauri-blec?label=%40dg-kit%2Ftransport-tauri-blec&color=0a84ff)](https://www.npmjs.com/package/@dg-kit/transport-tauri-blec)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![CI](https://github.com/0xNullAI/DG-Kit/actions/workflows/ci.yml/badge.svg)](https://github.com/0xNullAI/DG-Kit/actions/workflows/ci.yml)
[![官网](https://img.shields.io/badge/官网-0xnullai.com-58c8f2)](https://0xnullai.com)

中文 | [English](./README.en.md)

</div>

## 这是什么

DG-Kit 是 [DG-Agent](https://github.com/0xNullAI/DG-Agent)、[DG-Chat](https://github.com/0xNullAI/DG-Chat)、[DG-MCP](https://github.com/0xNullAI/DG-MCP) 三个项目共用的核心代码库。把蓝牙协议、波形数据、工具定义这些会在浏览器和 Node 都需要的部分抽出来发到 npm，三个项目各自只写自己独有的 UI / MCP 服务 / P2P 房间逻辑。

简单说：**一份协议代码，三个产品共用**。改一次，三个项目同步受益。

## 六个包

| 包 | 用途 |
|---|---|
| **`@dg-kit/core`** | 基础类型与抽象接口（`DeviceState` / `DeviceCommand` / `SensorState` / `DeviceKind` / `DeviceClient` 等） |
| **`@dg-kit/protocol`** | 四种 47L12x 家族设备的蓝牙协议适配器（郊狼 V2/V3、爪印传感器、灵猫气压传感器、负鼠振动控制器），与传输层解耦 |
| **`@dg-kit/waveforms`** | 内置波形、`ramp / hold / pulse / silence` 段落编译器、`.pulse` 文件解析器 |
| **`@dg-kit/tools`** | LLM 工具定义（`start` / `stop` / `adjust_strength` / `change_wave` / `burst` / `design_wave` / `vibrate_start` / `vibrate_stop` / `vibrate_adjust` / `set_indicator_color`），可注入限速策略 |
| **`@dg-kit/transport-webbluetooth`** | 浏览器侧 `DeviceClient` 实现，基于 Web Bluetooth |
| **`@dg-kit/transport-tauri-blec`** | Tauri（Android/桌面/iOS）侧 `DeviceClient` 实现，基于 `@mnlphlp/plugin-blec` |

## 安装

```bash
npm install @dg-kit/core @dg-kit/protocol @dg-kit/waveforms
```

按需取用。下游项目分别使用了不同子集。

## 架构

```
                  @dg-kit/core
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
 @dg-kit/protocol  @dg-kit/waveforms  @dg-kit/tools
        │
        ├──────────────────────┐
        ▼                      ▼
 @dg-kit/transport-webbluetooth  @dg-kit/transport-tauri-blec   (Node 上的 noble 传输由消费者实现，见 DG-MCP)
```

设备协议层（`@dg-kit/protocol`）只依赖一个抽象的 `BluetoothRemoteGATTCharacteristicLike` 接口，所以浏览器、Tauri、Node 都能复用——浏览器走 `@dg-kit/transport-webbluetooth`，Tauri 走 `@dg-kit/transport-tauri-blec`，Node 走 [DG-MCP](https://github.com/0xNullAI/DG-MCP) 内部的 noble 适配。四种设备共享同一套 GATT 骨架，用 `detectDeviceKind()` 从蓝牙名判断具体是哪一种。

## 开发

```bash
npm install
npm run build
npm run typecheck
npm run test
```

26 个单元测试覆盖协议帧打包、波形编译、`.pulse` 解析、限速策略。

## 发布

走 [changesets](https://github.com/changesets/changesets) 自动化：

1. 改完代码 → `npx changeset` 写一份 release note
2. PR 合并到 `main`，机器人自动开"Version Packages" PR
3. 合并那个 PR → CI 自动 `npm publish`

六个包通过 changesets 的 `fixed` 设置同步版本，永远是同一个版本号。

## 相关项目

| 项目 | 用途 |
|---|---|
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | 浏览器版 AI 控制器，自然语言驱动设备 |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | 多人 P2P 房间，可远程控制队友设备 |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP) | Model Context Protocol 服务器，接入 Claude Desktop 等 MCP 客户端 |

## 协议

[MIT](./LICENSE)
