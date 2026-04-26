# DG-Chat · 开发者文档

面向想加新房间命令、改 P2P 协议、做新成员视图的人。

## 仓库结构

```
DG-Chat/
├── src/
│   ├── App.tsx                 入口
│   ├── components/             UI 组件
│   │   ├── ChatPanel.tsx       聊天面板（左侧）
│   │   ├── MemberCard.tsx      成员卡片（右侧列表项）
│   │   ├── MemberControl.tsx   成员设备控制面板（点击卡片进入）
│   │   ├── ControlPanel.tsx    自己的设备控制
│   │   ├── WaveformPanel.tsx   波形库 UI
│   │   ├── RoomEntry.tsx       房间号 + 二维码
│   │   └── SafetyNotice.tsx    安全声明
│   ├── hooks/
│   │   ├── use-device.ts       封装 DGLabDevice 类
│   │   ├── use-peer-room.ts    PeerJS 房间管理
│   │   └── use-waveforms.ts    波形库 hook
│   ├── lib/
│   │   ├── bluetooth.ts        DGLabDevice — @dg-kit/protocol 的薄封装
│   │   ├── protocol.ts         P2P 消息协议（不是 BLE 协议）
│   │   ├── commands.ts         房间命令分发器
│   │   └── waveforms.ts        内置波形 + .pulse 导入（基于 @dg-kit/waveforms）
│   ├── styles/
│   ├── types/
│   └── main.tsx
└── package.json
```

## 数据流

```
用户操作
  ↓
React component → use-device / use-peer-room
  ↓
DGLabDevice (lib/bluetooth.ts)        ← 自己的设备
  ↓
@dg-kit/protocol → BLE → 设备
  ↓
状态变更 → DGLabDevice.onStateChange
  ↓
emit 到 P2P data channel → 其他成员看到你的状态

OR

成员 A 远程控制成员 B
  ↓
A: 在 MemberControl 里调滑块
  ↓
P2P data channel 发 DeviceCommand 给 B
  ↓
B: lib/commands.ts 路由到 B 的 DGLabDevice
  ↓
B 的设备响应
```

## 核心抽象

### `DGLabDevice` (lib/bluetooth.ts)

包装 `@dg-kit/protocol` 的 `CoyoteProtocolAdapter` + `@dg-kit/transport-webbluetooth` 的 `WebBluetoothDeviceClient`，对外暴露 DG-Chat 习惯的 API：

```ts
class DGLabDevice {
  async connect(): Promise<DeviceInfo>      // 弹蓝牙选择器
  disconnect(): void
  setStrength(channel: 'A'|'B', value: number): void
  setWave(channel, frames, waveformId, loop?): void
  stopWave(channel): void
  stopAll(): void                            // emergencyStop
  setLimit(channel, value): void             // 调用 protocol.setLimits()
  getState(): DeviceState
  setOnStateChange(cb): void
}
```

为什么不直接用 `WebBluetoothDeviceClient`？因为 DG-Chat 的 hook (`use-device.ts`) 用的是这套 imperative API。换成 command-style（`execute({ type: 'start', ... })`）需要改一堆 hook，得不偿失。

### P2P 消息协议 (lib/protocol.ts)

```ts
type P2PMessage =
  | { kind: 'chat',     msg: ChatMessage }
  | { kind: 'state',    member: MemberState }
  | { kind: 'command',  target: string, action: CmdAction, data?: string }
  | { kind: 'waveform', waveform: WaveformTransfer }

type CmdAction =
  | 'start' | 'stop' | 'stop_wave'
  | 'adjust_strength' | 'change_wave'
  | 'fire' | 'fire_stop' | 'burst'
  | 'vibrate' | 'alert' | 'bg' | 'shake' | 'beep'
```

每个 P2P 消息走 PeerJS data channel，目标成员的 commands.ts 收到后路由到本机 DGLabDevice。

### `MemberState`

```ts
interface MemberState {
  peerId: string
  displayName: string
  deviceConnected: boolean
  strengthA: number
  strengthB: number
  waveA: string | null
  waveB: string | null
  battery: number | null
  waveformCatalog?: WaveformCatalogEntry[]
}
```

每个成员定期把自己的 `MemberState` 广播给房间，让其他人看到他的设备状态。频率 ≈ 每 200ms（强度变化时）+ 状态机变化时。

## 加新功能

### 加一个新房间命令（比如 `vibrate`）

1. `lib/protocol.ts` — `CmdAction` 加 `'vibrate'`
2. `lib/commands.ts` — `dispatchCommand` 里加 `case 'vibrate'`，路由到 `DGLabDevice.xxx()`
3. `lib/bluetooth.ts` — 如果协议层不直接支持，加自己的实现（可能调用 `setStrength` + `setWave` 模拟）
4. UI: `MemberControl.tsx` 加按钮

如果是协议层缺的能力（比如 vibrate 需要 BLE 新方法），先到 [DG-Kit 加协议](#/kit/developer)，再来这边消费。

### 加一个新成员状态字段

1. `lib/protocol.ts` — `MemberState` 加字段
2. `hooks/use-peer-room.ts` — 广播时塞这个字段
3. `components/MemberCard.tsx` / `MemberControl.tsx` — 显示这个字段

P2P 协议是无版本号的——加字段时旧客户端会忽略未知字段，向后兼容；删字段会破坏旧客户端。

### 改 P2P 信令

PeerJS 默认走 `0.peerjs.com` 公共 signaling server。如果想自托管：

1. `npm i peerjs-server` + 自己跑一份
2. `hooks/use-peer-room.ts` 里 `new Peer()` 加 `host` / `port` 配置

注意自托管 signaling 后，跟用公共 server 的客户端无法互通——所有人都得连同一个 signaling。

## 测试

DG-Chat 没有 vitest 套件——回归测试依赖上游 DG-Kit 的协议测试。

本地测试流程：

```bash
npm install
npm run build
npm run lint
npm run dev          # 在两个浏览器（或一个浏览器两个窗口）打开同一房间号联调
```

## 部署

GitHub Pages，自动 deploy。`vite.config.ts` 的 `base` 是 `/DG-Chat/`，要 fork 改 base 字段。

## 二次开发

完整 fork 改造的话：

1. `package.json` 改 `name` / `version`
2. `vite.config.ts` 改 `base` 为你的仓库名
3. `src/lib/waveforms.ts` `STORAGE_KEY` 改成 `<your-app>-custom-waveforms`，避免跟 DG-Chat 同 origin 冲突（如果你也部到 github.io 同子域）
4. UI 文案 / 主题色按需改

## 代码规范

完整规则在 `DG-Chat/CLAUDE.md`。要点：

- TypeScript strict、ESM only
- React 19
- Tailwind v4（`@tailwindcss/vite`）
- UI 文案 简体中文
- 不引入新依赖前看现有的能不能复用

## 跟 DG-Agent 共享代码？

理论上完全可以——两个项目都 import `@dg-kit/*`，只是组织 UI 状态的方式不同。如果未来出现 DG-Chat 想复用 DG-Agent 的某段 React 代码，建议：

1. 把这段代码抽到 `@dg-agent/something-shared` 包发到 npm
2. DG-Chat 装上消费
3. DG-Agent 自己也消费，不要 fork

本来 DG-Kit 就是这个抽离思路的产物——把可复用的非 UI 代码先抽到中台。
