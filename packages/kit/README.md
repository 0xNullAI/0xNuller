# DG-Kit

DG-Kit 是 0xNuller 中可独立安装的 TypeScript 设备开发包。它不依赖统一网页 UI，适合在浏览器、
Node.js 或 Tauri 项目中复用设备协议、安全限制、连接适配、工具定义和波形处理能力。

## 选择包

| npm 包                                                                 | 用途                             |
| ---------------------------------------------------------------------- | -------------------------------- |
| [`@dg-kit/core`](./core/README.md)                                     | 公共类型、设备状态和基础接口     |
| [`@dg-kit/protocol`](./protocol/README.md)                             | Coyote、Opossum 和传感器协议     |
| [`@dg-kit/safety`](./safety/README.md)                                 | 强度限制、权限与安全执行         |
| [`@dg-kit/tools`](./tools/README.md)                                   | 可供 Agent 或 MCP 调用的设备工具 |
| [`@dg-kit/waveforms`](./waveforms/README.md)                           | 波形解析、校验与播放数据         |
| [`@dg-kit/transport-webbluetooth`](./transport-webbluetooth/README.md) | 浏览器 Web Bluetooth 连接        |
| [`@dg-kit/transport-tauri-blec`](./transport-tauri-blec/README.md)     | Tauri/Android 原生 BLE 连接      |

## 安装示例

浏览器项目通常从以下组合开始：

```bash
npm install @dg-kit/core @dg-kit/protocol @dg-kit/safety @dg-kit/transport-webbluetooth
```

```ts
import type { DeviceClient } from '@dg-kit/core';
import { CoyoteProtocolAdapter } from '@dg-kit/protocol';
import { WebBluetoothDeviceClient } from '@dg-kit/transport-webbluetooth';

const client: DeviceClient = new WebBluetoothDeviceClient({
  protocol: new CoyoteProtocolAdapter(),
});
await client.connect();
```

实际写入设备前应始终通过 `@dg-kit/safety` 执行调用方的强度上限与权限策略。每个包的公开入口、
运行环境和更完整示例见上表对应 README。

## 版本与发布

所有 `@dg-kit/*` 包使用固定版本组，并与 `dg-mcp` 遵循同一套 Changesets 发布规则。
`dev` 只自动创建或更新 Version PR，不发布；版本化代码随产品快照进入 `main` 并通过 CI 后，
GitHub Actions 才在 `npm-production` 环境构建、打包验证并发布到 npm 的 `latest` dist-tag。

包主页：[npm `@dg-kit/core`](https://www.npmjs.com/package/@dg-kit/core) ·
[源代码](https://github.com/0xNullAI/0xNuller/tree/main/packages/kit)

---

DG-Kit is the independently installable TypeScript device SDK inside 0xNuller. The packages can be
used without the unified web UI in browser, Node.js, and Tauri applications. Choose packages from the
table above; each linked README documents its public entry points and runtime requirements. All
`@dg-kit/*` packages share a fixed version and follow the same Changesets release policy as
`dg-mcp`; dev only prepares versions, and packages are published from the `npm-production`
environment after the versioned main snapshot passes CI.
