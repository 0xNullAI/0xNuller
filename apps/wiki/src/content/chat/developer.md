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
│   │   ├── MarketImportDialog.tsx  从 DG-Market 市场导入波形
│   │   ├── RoomEntry.tsx       房间号 + 二维码
│   │   └── SafetyNotice.tsx    安全声明
│   ├── hooks/
│   │   ├── use-device.ts       封装 DGLabDevice 类
│   │   ├── use-peer-room.ts    房间管理（走 RoomDO WebSocket，对外 hook API 保持不变）
│   │   └── use-waveforms.ts    波形库 hook
│   ├── lib/
│   │   ├── bluetooth.ts        DGLabDevice — @dg-kit/protocol 的薄封装
│   │   ├── protocol.ts         P2P 消息协议（不是 BLE 协议）
│   │   ├── room-transport.ts   到 RoomDO 的 WebSocket 客户端（自动重连）
│   │   ├── lobby-client.ts     公开房间大厅订阅客户端
│   │   ├── media.ts            图片压缩 + 语音录制 + R2 上传
│   │   ├── commands.ts         房间命令分发器
│   │   ├── market.ts           DG-Market 市场客户端（搜索 + 导入波形）
│   │   └── waveforms.ts        内置波形 + .pulse 导入（基于 @dg-kit/waveforms）
│   ├── styles/
│   ├── types/
│   └── main.tsx
├── worker/
│   ├── index.ts                 Worker 入口：路由 /ws/room/:code → RoomDO，/ws/lobby + /api/lobby/rooms → LobbyDO，/api/upload|media/... → R2，其余 → ASSETS（SPA）
│   ├── room-do.ts                RoomDO：单房间 WebSocket Hibernation 中转，按消息 t 字段扇出，注入可信 _from，聊天记录存 SQLite，房间空置 10 分钟后清理
│   ├── lobby-do.ts               LobbyDO：单例，公开房间注册表 + 实时推送
│   └── wire.ts                   线上协议：旧 MQTT topic 收敛成一个 t 字段
└── package.json
```

前端、WebSocket 中转、大厅 API、R2 媒体全部同源，由一个 Worker 通过 Workers Static Assets 提供服务（chat.0xnullai.com）。

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
经 room-transport.ts 的 WebSocket 发给 RoomDO → RoomDO 扇出给房间内其他成员

OR

成员 A 远程控制成员 B
  ↓
A: 在 MemberControl 里调滑块
  ↓
room-transport.ts 把 DeviceCommand 发给 RoomDO
  ↓
RoomDO 扇出给 B（注入可信 _from，B 端不可伪造发送者）
  ↓
B: lib/commands.ts 路由到 B 的 DGLabDevice
  ↓
B 的设备响应
```

早期版本用过公共 MQTT broker（更早还用过 PeerJS/WebRTC），现在已经完全替换成同源的 Cloudflare Durable Object WebSocket 中转——房间内不存在任何 P2P 直连。

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

### 房间消息协议 (lib/protocol.ts)

名字里的"P2P"是历史遗留——消息类型定义本身跟传输方式无关，实际传输见下方「每个设备命令走…」。

```ts
type CmdAction =
  // 郊狼（Coyote）—— 名字保持历史原样，不跟 @dg-kit/tools 的 shock_* 改名，
  // 这是房间内部的设备命令 action，跟 LLM 工具名是两套独立的命名空间
  | 'adjust_strength' | 'change_wave' | 'start' | 'stop' | 'stop_wave' | 'burst'
  | 'vibrate' | 'alert' | 'bg' | 'shake' | 'beep'
  | 'set_queue' | 'set_play_mode' | 'set_interval'
  | 'fire_active' | 'fire_release'
  // 负鼠（Opossum）—— 独立 action，不复用上面的 adjust_strength/burst/stop
  | 'vibrate_adjust' | 'vibrate_stop' | 'vibrate_burst'
  // 爪印 / 灵猫边缘 / 负鼠指示灯，用 kind 字段区分目标设备
  | 'set_led'
```

每个设备命令走房间的 Cloudflare Durable Object WebSocket relay（`RoomDO`，见 `worker/room-do.ts`），不是 PeerJS/WebRTC——早期版本用过 PeerJS，现在已经完全替换成同源的 DO WebSocket 中转，`_from` 由 DO 注入、不可伪造。目标成员的 `commands.ts` 收到后路由到本机 `DGLabDevice`。

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

协议是无版本号的——加字段时旧客户端会忽略未知字段，向后兼容；删字段会破坏旧客户端。

### 改房间信令 / 中转逻辑

房间中转跑在 `worker/room-do.ts` 的 `RoomDO`（每个房间号一个 Durable Object 实例），不是外部 signaling 服务，改动直接在这个 Worker 里：

1. `worker/wire.ts` — 线上协议的消息 `t` 字段类型定义
2. `worker/room-do.ts` — 扇出逻辑、presence（`sys joined/left`）、聊天记录持久化（SQLite）、房间清理（最后一个连接断开后 `setAlarm(+10min)`，无人重连则清空历史 + R2 媒体 + 大厅条目）
3. `src/lib/room-transport.ts` — 前端 WebSocket 客户端，自动重连

本地联调：`npm run dev`（Vite）+ `npm run cf:dev`（wrangler，:8787 本地跑 Worker + DO + R2），Vite 会代理 `/ws` 和 `/api` 到 Worker。Vite 的 ws 代理对长连接不太稳定（偶发 EPIPE → 重连 → 短暂掉回 RoomEntry 界面）；如果在调 WebSocket 相关的东西，`npm run build` 后直接打 `http://localhost:8787`（同源、无代理）更稳。生产环境本身就是同源，这只是开发环境的问题。

### 从 DG-Market 市场导入波形

DG-Chat 已支持从 [DG-Market](https://market.0xnullai.com) 市场导入波形：`lib/market.ts` 是市场客户端（搜索 + 拉取波形），`components/MarketImportDialog.tsx` 是导入 UI（搜索市场 → 一键导入到本地波形库）。导入后的波形跟本地 `.pulse` 导入走同一条落地路径（`use-waveforms.ts` → `localStorage`），只对当前客户端可见。

## 测试

```bash
npm install
npm run lint
npm run test         # vitest, 11 个测试
npm run build
npm run dev          # 在两个浏览器（或一个浏览器两个窗口）打开同一房间号联调
```

vitest 套件覆盖：

- `BUILTIN_WAVEFORMS` 形状 + 强度钳制
- `parsePulseFile` 各种合法 / 非法输入
- localStorage 自定义波形持久化往返

协议层（V2 / V3 字节）测试在上游 [DG-Kit](#/kit/developer) 里跑，DG-Chat 不重复。

## 分支约定 + 发布

跟 DG 家族一致：

| 分支 | 用途 |
|---|---|
| `main` | 默认查看 / 已发布版（Cloudflare 上线版本，chat.0xnullai.com） |
| `dev` | 日常开发，所有 PR base 到这里 |

发布动作：

1. dev 上 `npm version patch` 改 root `package.json`
2. PR base=main → `release-guard.yml` 校验版本已 bump
3. 合并到 main → Cloudflare 自动构建并部署到 chat.0xnullai.com + `auto-tag.yml` 打 `vX.Y.Z` tag

`vite.config.ts` 的 `base` 现在是 `/`（迁 Cloudflare 子域 chat.0xnullai.com 后从 `/DG-Chat/` 改为根路径）。只有 fork 后想部署到某个子路径时才需要改这个字段。

## 二次开发

完整 fork 改造的话：

1. `package.json` 改 `name` / `version`
2. `vite.config.ts` 改 `base` 为你的仓库名
3. `src/lib/waveforms.ts` `STORAGE_KEY` 改成 `<your-app>-custom-waveforms`，避免跟 DG-Chat 同 origin 冲突（如果你也部到同一域名下的子路径，例如同一个 Cloudflare Pages 项目）
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
