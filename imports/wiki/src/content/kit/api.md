# DG-Kit · API 参考

按包分组的导出列表。点 [详细文档](https://github.com/0xNullAI/DG-Kit) 看完整源码。

## `@dg-kit/core`

零依赖的纯类型包。

### 类型

| 名字 | 形状 |
|---|---|
| `Channel` | `'A' \| 'B'` |
| `WaveFrame` | `[freq: number, intensity: number]`，每帧 25 ms |
| `WaveformDefinition` | `{ id, name, description?, frames }` |
| `DeviceState` | `{ connected, deviceName?, address?, battery?, strengthA, strengthB, limitA, limitB, waveActiveA, waveActiveB, currentWaveA?, currentWaveB? }` |
| `DeviceCommand` | union: `start \| stop \| adjustStrength \| changeWave \| burst \| emergencyStop` |
| `TimerCommand` | `{ type: 'timer', seconds, label }` |
| `DeviceCommandResult` | `{ state, notes? }` |
| `ToolCall` | `{ id, name, displayName?, args }` |
| `ToolDefinition` | `{ name, displayName?, description, parameters }` |
| `ToolExecutionPlan` | `{ type: 'device' \| 'timer' \| 'inline', ... }` |

### 接口

| 名字 | 用途 |
|---|---|
| `DeviceClient` | 郊狼设备客户端契约：connect / disconnect / getState / execute / emergencyStop / onStateChanged |
| `SensorDeviceClient<TReading>` | 只读传感器设备契约（爪印/灵猫通用）：connect / disconnect / getState / subscribe / onStateChanged，可选 `setIndicatorColor` |
| `WaveformLibrary` | 波形库契约：getById / list / save? |
| `Logger` | info / warn / error |

### 函数 / 常量

| 名字 | 签名 |
|---|---|
| `createEmptyDeviceState()` | `() => DeviceState` |
| `isDeviceToolName(name)` | `(string) => boolean` |
| `DEVICE_KIND_DISPLAY_NAME` | `Record<DeviceKind, string>`，四设备的中文展示名 |

## `@dg-kit/protocol`

### 类

| 名字 | 用途 |
|---|---|
| `BaseCoyoteProtocolAdapter` | 抽象基类。包含 100ms tick、波形状态机、burst 自动回落、emergencyStop |
| `CoyoteV2ProtocolAdapter` | V2 设备实现 |
| `CoyoteV3ProtocolAdapter` | V3 设备实现 |
| `CoyoteProtocolAdapter` | facade，按设备名前缀自动选 V2/V3 |

公共方法（来自 `WebBluetoothProtocolAdapter` 接口）：

```ts
onConnected(context): Promise<void>
onDisconnected(): Promise<void>
getState(): DeviceState
execute(command: DeviceCommand): Promise<DeviceCommandResult>
emergencyStop(): Promise<void>
setLimits(limitA: number, limitB: number): Promise<void>
subscribe(listener): () => void
```

### 常量

UUID + 设备名前缀：

```ts
V3_DEVICE_NAME_PREFIX = '47L121'
V3_PRIMARY_SERVICE = '0000180c-...'
V3_WRITE_CHAR = '0000150a-...'
V3_NOTIFY_CHAR = '0000150b-...'

V2_DEVICE_NAME_PREFIX = 'D-LAB ESTIM'
V2_PRIMARY_SERVICE = '955a180b-...'
V2_STRENGTH_CHAR = '955a1504-...'
V2_WAVE_A_CHAR = '955a1505-...'
V2_WAVE_B_CHAR = '955a1506-...'

COYOTE_REQUEST_DEVICE_OPTIONS  // 给 navigator.bluetooth.requestDevice 用
```

### 接口（用于编写自定义传输）

```ts
BluetoothRemoteGATTCharacteristicLike   // 每个特征的最小契约
BluetoothRemoteGATTServiceLike          // service.getCharacteristic
BluetoothRemoteGATTServerLike           // server.getPrimaryService
BluetoothDeviceLike                     // 带 id, name, gatt
NavigatorBluetoothLike                  // 带 .bluetooth.requestDevice
RequestDeviceOptionsLike                // filters + optionalServices
```

写新传输（noble、Capacitor、Tauri、…）时实现这套接口即可，协议代码无需改。

### 负鼠 / 传感器接口

```ts
interface OpossumClient {
  connect(): Promise<...>
  disconnect(): void
  getState(): OpossumState
  execute(command: OpossumCommand): Promise<OpossumCommandResult>   // { state: OpossumState }
  onStateChanged(cb): () => void
}
type OpossumCommand =
  | { type: 'vibrateStart', ... } | { type: 'vibrateStop' }
  | { type: 'vibrateAdjust', ... } | { type: 'vibrateSetPattern', ... }
  | { type: 'vibrateBurst', ... }

type PawPrintsClient = SensorDeviceClient<PawPrintsReading>
type CivetEdgingClient = SensorDeviceClient<CivetPressureReading>
```

`detectDeviceKind(name: string): DeviceKind | null` —— 唯一的设备名前缀分类实现，写新消费者时导入它，不要重新实现匹配逻辑。

## `@dg-kit/waveforms`

```ts
createBasicWaveformLibrary(): WaveformLibrary
listBuiltinWaveforms(): WaveformDefinition[]

compileWaveformDesign(segments: DesignSegment[]): {
  frames: WaveFrame[]
  totalDurationMs: number
}
type DesignSegment =
  | { type: 'ramp', from, to, durationMs, frequencyMs? }
  | { type: 'hold', intensity, durationMs, frequencyMs? }
  | { type: 'pulse', intensity, onMs, offMs, count, frequencyMs? }
  | { type: 'silence', durationMs }

parsePulseText(text: string): ParsedPulse
type ParsedPulse = { name: string, frames: WaveFrame[] }

pulseToWaveformDefinition(filename: string, parsed: ParsedPulse, options?): { id, name, frames }
encodeFreq(value: number): number  // 10..1000ms → 10..240 编码
```

## `@dg-kit/tools`

```ts
class ToolRegistry {
  constructor(rateLimitPolicy?: RateLimitPolicy)
  register(handler: ToolHandler): void
  async resolve(toolCall: ToolCall): Promise<ToolExecutionPlan>
  async listDefinitions(): Promise<ToolDefinition[]>
  getDisplayName(name: string): string | undefined
  summarizeCommand(name: string, command: DeviceCommand): string | undefined
  resetTurn(): void
}

createDefaultToolRegistry(deps: {
  waveformLibrary?: WaveformLibrary
  toolDefinitionHints?: ToolDefinitionHints
  rateLimitPolicy?: RateLimitPolicy
}): ToolRegistry

interface RateLimitPolicy {
  shouldAllow(toolName: string): { allow: true } | { allow: false, reason: string }
  recordCall(toolName: string): void
  resetTurn?(): void
}

createNoOpRateLimitPolicy(): RateLimitPolicy
createSlidingWindowRateLimitPolicy({ windowMs, caps, now? }): RateLimitPolicy
createTurnRateLimitPolicy({ caps }): RateLimitPolicy
```

13 个内置工具：

- 郊狼：`shock_start` / `shock_stop` / `shock_adjust` / `shock_change_wave` / `shock_burst` / `design_wave` / `timer`
- 负鼠：`vibrate_start` / `vibrate_stop` / `vibrate_adjust` / `vibrate_change_pattern` / `vibrate_burst`
- 传感器（爪印/灵猫）：`set_indicator_color`

限速策略的 `caps` 必须以这些主名为 key（不是历史名 `adjust_strength`/`burst`）——用错 key 会静默失效，而不是报错。

## `@dg-kit/transport-webbluetooth`

```ts
getWebBluetoothAvailability(navigator?): { supported: boolean, reason?: string }

class WebBluetoothDeviceClient implements DeviceClient {
  constructor(options: {
    protocol: WebBluetoothProtocolAdapter
    navigatorRef?: NavigatorBluetoothLike
    requestDeviceOptions?: RequestDeviceOptionsLike
  })
  // 实现完整 DeviceClient 接口
}

class WebBluetoothOpossumClient implements OpossumClient { /* ... */ }
class WebBluetoothSensorClient<TReading> implements SensorDeviceClient<TReading> { /* ... */ }
class WebBluetoothPawPrintsClient extends WebBluetoothSensorClient<PawPrintsReading> {}
class WebBluetoothCivetEdgingClient extends WebBluetoothSensorClient<CivetPressureReading> {}

connectAuxDevice(kind, navigatorRef?): Promise<ConnectableAdapter>
attachAuxDevice(adapter, kind): OpossumClient | PawPrintsClient | CivetEdgingClient
disconnectAuxDevice(adapter): void

PAW_PRINTS_REQUEST_DEVICE_OPTIONS
CIVET_EDGING_REQUEST_DEVICE_OPTIONS
OPOSSUM_REQUEST_DEVICE_OPTIONS
```

## `@dg-kit/transport-tauri-blec`

Tauri（安卓/桌面/iOS）侧的镜像实现，基于 `@mnlphlp/plugin-blec`，接口与 web-bluetooth 版本对齐：

```ts
class TauriBlecDeviceClient implements DeviceClient { /* ... */ }
class TauriBlecOpossumClient implements OpossumClient { /* ... */ }
class TauriBlecPawPrintsClient implements PawPrintsClient { /* ... */ }
class TauriBlecCivetEdgingClient implements CivetEdgingClient { /* ... */ }
```

## 版本

当前 `1.13.0`。Major 版本号变化才有破坏性 API 改动。Minor 加新功能、保持向后兼容。Patch 修 bug。六个包通过 changesets 的 `fixed` 锁步同步版本号。

完整 CHANGELOG 见各包：

- [@dg-kit/core CHANGELOG](https://github.com/0xNullAI/DG-Kit/blob/main/packages/core/CHANGELOG.md)
- [@dg-kit/protocol CHANGELOG](https://github.com/0xNullAI/DG-Kit/blob/main/packages/protocol/CHANGELOG.md)
- [@dg-kit/waveforms CHANGELOG](https://github.com/0xNullAI/DG-Kit/blob/main/packages/waveforms/CHANGELOG.md)
- [@dg-kit/tools CHANGELOG](https://github.com/0xNullAI/DG-Kit/blob/main/packages/tools/CHANGELOG.md)
- [@dg-kit/transport-webbluetooth CHANGELOG](https://github.com/0xNullAI/DG-Kit/blob/main/packages/transport-webbluetooth/CHANGELOG.md)
- [@dg-kit/transport-tauri-blec CHANGELOG](https://github.com/0xNullAI/DG-Kit/blob/main/packages/transport-tauri-blec/CHANGELOG.md)
