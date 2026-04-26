# DG-Kit

DG-Lab 郊狼 2.0 / 3.0 的共享 TypeScript 中台。npm 上发布为 `@dg-kit/*`，被 DG-Agent / DG-Chat / DG-MCP 共同消费。

> [GitHub](https://github.com/0xNullAI/DG-Kit) · [npm @dg-kit/core](https://www.npmjs.com/package/@dg-kit/core)

## 五个包

| 包 | 用途 |
|---|---|
| `@dg-kit/core` | 类型与抽象接口：`DeviceState`、`DeviceCommand`、`WaveformDefinition`、`DeviceClient` 等 |
| `@dg-kit/protocol` | 郊狼 V2 / V3 蓝牙协议适配器（与传输层解耦） |
| `@dg-kit/waveforms` | 内置波形、`ramp/hold/pulse/silence` 段落编译器、`.pulse` 文件解析器 |
| `@dg-kit/tools` | LLM 工具定义（`start` / `stop` / `adjust_strength` / `change_wave` / `burst` / `design_wave`），可注入限速策略 |
| `@dg-kit/transport-webbluetooth` | 浏览器端 `DeviceClient` 实现，基于 Web Bluetooth |

五个包通过 changesets 的 `fixed` 设置同步版本号，永远是同一个版本。

## 安装

```bash
npm install @dg-kit/core @dg-kit/protocol @dg-kit/waveforms
```

按需取用。三个下游分别用了不同的子集。

## 架构

```
                  @dg-kit/core
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
 @dg-kit/protocol  @dg-kit/waveforms  @dg-kit/tools
        │
        ▼
 @dg-kit/transport-webbluetooth   ⟵⟶   @dg-mcp/device-noble
        │                                       │
   浏览器 Web Bluetooth                     Node.js noble
```

设备协议层（`@dg-kit/protocol`）只依赖一个抽象的 `BluetoothRemoteGATTCharacteristicLike` 接口，所以浏览器和 Node 都能复用。Node 端在 [DG-MCP](#/mcp) 内部用 `@stoprocent/noble` 实现 shim。

## 关键设计点

### 帧栅格 25 ms

每个 `WaveFrame = 25 ms`。V3 协议每 100 ms 写一包，每包打 4 帧；V2 协议每 100 ms 消费一帧（精度损失但代码统一）。这层抽象在协议基类里，下游透明。

### Tool registry 注入限速

```ts
import { createDefaultToolRegistry, createTurnRateLimitPolicy } from '@dg-kit/tools';

const registry = createDefaultToolRegistry({
  waveformLibrary,
  rateLimitPolicy: createTurnRateLimitPolicy({ caps: { burst: 1, adjust_strength: 2 } }),
});
```

DG-Agent 用回合限速，DG-MCP 用时间窗口（`createSlidingWindowRateLimitPolicy`）。中台不耦合"回合"概念。

### 传输层抽象

```ts
import { CoyoteProtocolAdapter } from '@dg-kit/protocol';
import { WebBluetoothDeviceClient } from '@dg-kit/transport-webbluetooth';

const protocol = new CoyoteProtocolAdapter();   // 自动 V2/V3 路由
const client = new WebBluetoothDeviceClient({ protocol });
await client.connect();
await client.execute({ type: 'start', channel: 'A', strength: 5, waveform, loop: true });
```

## 开发

```bash
git clone https://github.com/0xNullAI/DG-Kit.git
cd DG-Kit
npm install
npm run build       # tsc per package, 拓扑顺序
npm run typecheck   # 自动先 build
npm run test        # vitest，自动先 build
npm run lint
```

26 个单元测试覆盖协议帧打包、波形编译、`.pulse` 解析、限速策略。

## 发布流程

走 [changesets](https://github.com/changesets/changesets) 自动化：

1. 改完代码 → `npx changeset` 写 release note
2. PR 合并到 `main` → 机器人自动开 "Version Packages" PR
3. 合并那个 PR → CI 自动跑 `npm publish`

详见 [DG-Kit/CLAUDE.md](https://github.com/0xNullAI/DG-Kit/blob/main/CLAUDE.md)。
