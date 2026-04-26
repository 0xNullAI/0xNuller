# DG-Kit · 开发者文档

这份文档面向想要给 DG-Kit 添加功能、修 bug、做发布、或基于 `@dg-kit/*` 写新项目的人。

## 仓库结构

```
DG-Kit/
├── packages/
│   ├── core/                       @dg-kit/core
│   ├── protocol/                   @dg-kit/protocol         (deps: core)
│   ├── waveforms/                  @dg-kit/waveforms        (deps: core)
│   ├── tools/                      @dg-kit/tools            (deps: core, waveforms)
│   └── transport-webbluetooth/     @dg-kit/transport-webbluetooth (deps: core, protocol)
├── .changeset/                     changesets release notes
└── .github/workflows/
    ├── ci.yml                      lint + typecheck + test + build
    └── release.yml                 changesets publish
```

每个包独立 `package.json`、独立 `tsconfig`、各自暴露 `dist/`。CI 跑 typecheck + 26 个单元测试 + 构建。

## 各包责任

### `@dg-kit/core`

只放**纯类型**：`Channel`、`WaveFrame`、`DeviceState`、`DeviceCommand`、`WaveformDefinition`、`DeviceClient`、`WaveformLibrary`、`Logger`、`createEmptyDeviceState()`、`isDeviceToolName()`。

零依赖、零运行时代码。任何环境（浏览器 / Node / Deno / Bun）都能 import。

### `@dg-kit/protocol`

蓝牙字节级协议——这是中台最复杂也最重要的部分。

- `BaseCoyoteProtocolAdapter`：抽象基类，跑 100ms tick 循环、波形播放状态机、burst 自动回落、紧急停止
- `CoyoteV2ProtocolAdapter`：V2 实现（D-LAB ESTIM 设备）
- `CoyoteV3ProtocolAdapter`：V3 实现（47L121 设备）
- `CoyoteProtocolAdapter`（facade）：根据连接设备名前缀自动路由 V2 / V3
- 25ms 帧栅格：每个 `WaveFrame` = 25ms。V3 一个 BLE 包打 4 帧；V2 一个 tick 取一帧（精度损失但代码统一）

蓝牙 I/O 抽象在 `BluetoothRemoteGATTCharacteristicLike` 接口里——只描述「能写值、能监听通知、能读值」这种语义，不绑定 Web Bluetooth 或 noble 任何一方。

### `@dg-kit/waveforms`

- `createBasicWaveformLibrary()` — 6 个内置波形（呼吸/潮汐/低中高脉冲/敲击）
- `compileWaveformDesign(segments)` — 段落编译器，输入 `ramp / hold / pulse / silence` 段落，输出 `WaveFrame[]`，单回合上限 30000ms
- `parsePulseText(content)` — Dungeonlab `.pulse` 格式解析器
- `pulseToWaveformDefinition(filename, parsed)` — 给解析结果起 id

零依赖、纯函数。用在浏览器 / Node 都行。

### `@dg-kit/tools`

LLM 工具定义。导出 `createDefaultToolRegistry({ waveformLibrary, rateLimitPolicy })`，注册 `start / stop / adjust_strength / change_wave / burst / design_wave / timer` 七个工具。

每个工具：

- 名字 + 中文 description（LLM 看到的）
- JSON Schema 参数（用 zod 校验）
- `toExecutionPlan(args)` — 转换成 `DeviceCommand` 或 `inline` 输出

限速策略是**注入式**的：

- `createNoOpRateLimitPolicy()` — 不限速（测试用）
- `createTurnRateLimitPolicy({ caps })` — 回合制（DG-Agent 用，每回合 burst≤1 / adjust≤2）
- `createSlidingWindowRateLimitPolicy({ windowMs, caps })` — 滑动窗口（DG-MCP 用，5 秒内 burst≤1）

### `@dg-kit/transport-webbluetooth`

浏览器侧的 `DeviceClient` 实现：弹蓝牙选择器、连 GATT、把 characteristic 喂给 protocol adapter。

只在浏览器有用。Node 端走自己的 noble 适配（在 DG-MCP 里）。

## 怎么用 `@dg-kit/*`

### 在浏览器项目里

```ts
import { CoyoteProtocolAdapter } from '@dg-kit/protocol';
import { WebBluetoothDeviceClient } from '@dg-kit/transport-webbluetooth';

const protocol = new CoyoteProtocolAdapter();   // 自动 V2/V3 路由
const client = new WebBluetoothDeviceClient({ protocol });
await client.connect();                         // 弹选择器

await client.execute({
  type: 'start',
  channel: 'A',
  strength: 5,
  waveform,                                     // WaveformDefinition
  loop: true,
});

await client.execute({ type: 'stop' });
```

需要 LLM 工具注册：

```ts
import { createDefaultToolRegistry, createTurnRateLimitPolicy } from '@dg-kit/tools';

const registry = createDefaultToolRegistry({
  waveformLibrary,
  rateLimitPolicy: createTurnRateLimitPolicy({
    caps: { burst: 1, adjust_strength: 2 },
  }),
});

const definitions = await registry.listDefinitions();   // → 喂给 OpenAI tools
const plan = await registry.resolve(toolCall);           // → 设备命令
```

### 在 Node 项目里

参考 DG-MCP 的实现：

1. 装 `@dg-kit/core` `@dg-kit/protocol` `@dg-kit/tools` `@dg-kit/waveforms`
2. 装一个 noble 包（推荐 `@stoprocent/noble`）
3. 写一个 `noble-shim.ts` 把 noble 的 Characteristic 包成 `BluetoothRemoteGATTCharacteristicLike`
4. 把 shim 后的"server"对象喂给 `CoyoteProtocolAdapter.onConnected({ device, server })`

shim 大概长这样（伪代码）：

```ts
class NobleGATTCharacteristic extends EventTarget {
  value: DataView | null = null;
  constructor(private char: NobleCharacteristic) {
    super();
    char.on('data', (data: Buffer) => {
      this.value = new DataView(data.buffer.slice(...));
      this.dispatchEvent(new Event('characteristicvaluechanged'));
    });
  }
  async writeValueWithoutResponse(buf) { await this.char.writeAsync(toBuffer(buf), true); }
  async readValue() { return new DataView((await this.char.readAsync()).buffer); }
  async startNotifications() { await this.char.subscribeAsync(); return this; }
  async stopNotifications() { await this.char.unsubscribeAsync(); return this; }
}
```

完整代码看 DG-MCP 的 `src/noble-shim.ts`。

## 加新功能的工作流

### 加一个新的 BLE 命令

1. `packages/protocol/src/base.ts` — 在 `WebBluetoothProtocolAdapter` 接口加方法签名
2. `base.ts` — 实现公共逻辑（更新 state、emit），调用一个 `protected abstract writeXxx()`
3. `v2.ts` / `v3.ts` — 实现 `writeXxx()`（V2 可能 no-op，V3 写包）
4. `facade.ts` — 转发到 `activeProtocol.xxx()`
5. 加单元测试到 `protocol.test.ts`
6. 写 changeset：`@dg-kit/protocol: minor`

参考最近做的 `setLimits()`（PR #3）。

### 加一个新的 LLM 工具

1. `packages/tools/src/registry.ts` — `createDefaultToolRegistry()` 里 `registry.register({...})`
2. 写描述（中文「触发/不用/约束」三段式）+ 参数 JSON Schema + zod 校验
3. `toExecutionPlan(args)` 返回 `{ type: 'device', command: ... }`
4. `@dg-kit/tools: minor` changeset

注意：跟既有工具同名会覆盖。

### 加新内置波形

1. `packages/waveforms/src/basic.ts` — 在 `BUILTIN_WAVEFORMS` 数组加一项
2. 帧数据用 `[freq, intensity]` 元组数组（25ms / 帧）
3. 起中文名 + 一句体感描述
4. `@dg-kit/waveforms: minor` changeset

## 测试

```bash
npm install
npm run build        # tsc per package, 拓扑顺序
npm run typecheck    # 自动先 build
npm run test         # vitest, 自动先 build
npm run lint
```

26 个单元测试覆盖：

- 协议帧打包（B0 / BF / B1）
- emergencyStop 等待 in-flight tick
- B1 stale notification 抑制
- V3 wave packing（4 帧/包 + 静音填充）
- V2 connect rollback
- waveform 段落编译
- `.pulse` 解析器
- 限速策略

## 发布流程（changesets）

1. 改完代码 → `npx changeset` 写 release note
2. 选 packages、选 patch / minor / major、写一句话
3. 提 PR 合并到 `main`
4. 机器人自动开 "Version Packages" PR，里面 bump 版本 + 生成 CHANGELOG
5. 合并那个 PR → `release.yml` workflow 自动 `npm publish`

五个包通过 changesets `fixed` 同步版本——bump 一个全部 bump。

## 代码规范

- TypeScript `strict: true`、`noUncheckedIndexedAccess: true`、`verbatimModuleSyntax: true`
- ESM only（`"type": "module"`）
- `import type` 显式标注类型导入
- 未使用变量加 `_` 前缀
- 注释解释 WHY，不解释 WHAT

完整规则见 `DG-Kit/CLAUDE.md`。

## 二次开发

如果你想 fork DG-Kit 做自己的 scope（比如 `@you/dg-kit-fork`）：

1. 改所有 `package.json` 的 `name` 字段
2. 改 `.changeset/config.json` 的 `fixed` 数组
3. 改 GitHub Actions 的 `NPM_TOKEN` secret 为你自己的
4. 改下游项目的依赖名

更建议的方案：直接给上游 PR，避免 fork 漂移。
