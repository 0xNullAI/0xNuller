# 0xNuller Control

中文 | [English](README.en.md)

直接控制已连接的 DG-Lab 设备，不经过房间、语音或 AI。Control 是首次连接设备和检查双通道
输出的基础模块。

## 功能

- 一个顶部设备横栏连接郊狼、爪印、灵猫或负鼠。
- 多台郊狼独立选择、强度调节、波形播放与归零。
- 负鼠强度、短反馈和辅助设备指示灯控制。
- 自定义波形、播放队列和 Market 波形导入。
- 折叠的一键开火区，默认不占用主要控制界面。

所有输出都经过共享设备会话、命令队列和全局设备安全设置。切换到其他模块时 Control 会立即
交还设备控制权并停止输出，但不会擅自断开蓝牙。

## 本地开发

Control 由统一 Web 外壳加载：

```bash
npm install
npm run dev -w @0xnullai/web
npm run test
npm run typecheck
npm run build -w @0xnullai/web
```

## 代码结构

```text
src/App.tsx                 设备会话、控制权和页面组合
src/components/            郊狼、波形、负鼠和传感器界面
src/hooks/                 波形播放与按住开火逻辑
@0xnullai/device-runtime    顶部设备横栏的共享状态契约与设备摘要
```

蓝牙与协议实现复用 `@0xnullai/device-runtime` 的 `DeviceSession`，避免功能应用互相导入或维护
多份设备状态和安全逻辑。

## 协议

[MIT](../../LICENSE)
