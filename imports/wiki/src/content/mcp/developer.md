# DG-MCP · 开发者文档

面向想加新 MCP 工具、改 noble shim、自托管或加新平台支持的人。

## 仓库结构

```
DG-MCP/
├── src/
│   ├── cli.ts                  入口；解析参数、起 stdio MCP server
│   ├── server.ts               MCP server：把 @dg-kit/tools 工具定义转 MCP schema
│   ├── coyote-device.ts        DeviceClient 实现：noble scan/connect → @dg-kit/protocol
│   ├── noble-shim.ts           noble Characteristic → @dg-kit/protocol 的 CharacteristicLike
│   └── waveform-library.ts     fs-backed WaveformLibrary（built-ins + .pulse/.zip + JSON 持久化）
├── .github/
│   ├── workflows/
│   │   ├── ci.yml              typecheck + test + build (PR + push to dev/main)
│   │   ├── publish.yml         npm publish on push to main (with --provenance)
│   │   ├── release-guard.yml   PR-to-main 必须 bump version
│   │   └── auto-tag.yml        push to main 后自动打 vX.Y.Z 标签
│   ├── pull_request_template.md
│   ├── ISSUE_TEMPLATE/
│   ├── CODEOWNERS
│   └── dependabot.yml
└── package.json                bin: { dg-mcp: dist/cli.js }
```

## 数据流

```
Claude Desktop 等客户端
  ↓ stdio (MCP)
src/server.ts (MCP Server)
  ↓ tool call resolved
@dg-kit/tools.ToolRegistry
  ↓ ToolExecutionPlan (DeviceCommand)
src/coyote-device.ts (NobleCoyoteDevice)
  ↓ execute(command)
@dg-kit/protocol.CoyoteProtocolAdapter
  ↓ 写 BLE characteristic
src/noble-shim.ts → @stoprocent/noble
  ↓ BLE
设备
```

## 关键模块

### `cli.ts`

负责：

- 解析 `--waveforms` / `--waveforms-dir` / `--library-dir` 参数
- 读环境变量 `DG_MCP_*`
- 实例化 `NodeWaveformLibrary` + `NobleCoyoteDevice`
- 启动 `runStdioServer()`

### `server.ts`

`createDgMcpServer(options)` 创建 MCP server：

1. 创建 `createDefaultToolRegistry({ rateLimitPolicy })`，注入 `createSlidingWindowRateLimitPolicy`
2. 注册 `ListToolsRequestSchema` → 返回 registry 工具 + MCP-only 工具的 JSON Schema
3. 注册 `CallToolRequestSchema` → 路由：
   - MCP-only 工具直接处理（`scan` 调 `device.scan()`，`connect` 调 `device.connect()`，等等）
   - registry 工具走 `registry.resolve(toolCall)` → 拿到 `ToolExecutionPlan`：
     - `device` 类型 → `device.execute(plan.command)`
     - `inline` 类型 → 直接返回字符串
     - `timer` 类型 → 返回 `not supported` 提示

输出统一是 JSON 字符串塞进 MCP 的 `content[].text`。

### `coyote-device.ts`

`NobleCoyoteDevice` 实现 `DeviceClient` 接口：

```ts
class NobleCoyoteDevice implements DeviceClient {
  async scan(timeoutMs?: number): Promise<ScanResult[]>     // MCP-only
  async connect(address: string): Promise<void>             // MCP-only signature
  async disconnect(): Promise<void>
  async getState(): Promise<DeviceState>
  async execute(command: DeviceCommand): Promise<DeviceCommandResult>
  async emergencyStop(): Promise<void>
  onStateChanged(listener): () => void
}
```

内部：

- 启动 noble 扫描 → 找到对应 address 的 peripheral
- 调 `peripheral.connectAsync()` + `discoverAllServicesAndCharacteristicsAsync()`
- 把 services 列表喂给 `NobleGATTServer`
- 构造一个假的 "device" 对象（带 `id` / `name` / `gatt`）满足 `BluetoothDeviceLike`
- 调 `protocol.onConnected({ device, server })` 完成握手

### `noble-shim.ts`

把 `@stoprocent/noble` 的 `Service` / `Characteristic` 包装成 `@dg-kit/protocol` 期待的 `BluetoothRemoteGATTServiceLike` / `BluetoothRemoteGATTCharacteristicLike`：

- `NobleGATTServer.getPrimaryService(uuid)` → 在 services 数组里找
- `NobleGATTService.getCharacteristic(uuid)` → 在 service.characteristics 数组里找
- `NobleGATTCharacteristic` extends EventTarget，包装 `writeAsync` / `readAsync` / `subscribeAsync` / `unsubscribeAsync`
- 把 noble 的 `'data'` 事件转成 `characteristicvaluechanged` Event

### `waveform-library.ts`

`NodeWaveformLibrary` 实现 `WaveformLibrary` 接口：

- `getById(id)` / `list()` 走内置 + 内存 custom map
- `save(waveform)` 写入 custom map，flush 到 JSON（如果配了 `persistDir`）
- `importPath(filePath)`：读 `.pulse` 或 `.zip`，调 `@dg-kit/waveforms` 的 `parsePulseText`，入库
- `init()` 启动时从 `persistDir` 读回上次的 custom 波形

## 加新功能

### 加一个新 MCP 工具（不是 LLM 工具）

在 `server.ts` 的 `setRequestHandler(ListToolsRequestSchema, ...)` 里 append：

```ts
{
  name: 'my_new_tool',
  description: '...',
  inputSchema: { type: 'object', properties: { ... } },
}
```

然后在 `setRequestHandler(CallToolRequestSchema, ...)` 的 switch 里加 `case 'my_new_tool'`：

```ts
case 'my_new_tool': {
  const arg = String(safeArgs.someArg ?? '');
  // 逻辑
  return jsonResult({ ok: true });
}
```

### 加一个新 LLM 工具（设备控制类）

不要直接在 DG-MCP 加——去 [DG-Kit 的 `@dg-kit/tools`](#/kit/developer) 加，所有三个项目自动得到。然后 bump DG-MCP 的 `@dg-kit/*` 依赖到新版本。

### 换 noble 实现

如果 `@stoprocent/noble` 在你的平台有问题，可以试：

- `@abandonware/noble`（老一些，文档多但维护慢）
- `noble-mac`（仅 macOS，原生 CoreBluetooth）
- 自写一个

切换需要改 `coyote-device.ts` + `noble-shim.ts` 里的 import，并且要适配新的 API（`writeAsync` vs callback 之类）。

### 加新平台支持

理论上 noble 已经覆盖 macOS / Linux / Windows。如果要支持嵌入式（树莓派等），重点：

- 确保 BlueZ 5.43+
- 用户运行 Node 进程要有 BLE 抓包权限（setcap）
- ARM 架构下 native module 编译可能要装 `build-essential` / `python3` 等

## 测试

```bash
npm install
npm run typecheck
npm run test         # vitest, 9 个测试
npm run build
npm run dev          # tsx 热重载（直接跑 src/cli.ts）
```

vitest 套件覆盖 `src/waveform-library.ts`：内置波形列表、`getById()` 退路、`save()` 往返、`importPath()` 处理 `.pulse` / `.zip` / 损坏文件、`persistDir` 跨实例持久化。

协议层（V2 / V3 字节）测试在上游 [DG-Kit](#/kit/developer)。CLI / Claude Desktop 集成靠真机 smoke test。

## 分支约定

跟 DG 家族一致：

| 分支 | 用途 |
|---|---|
| `main` | 默认查看 / 发布版（已发布到 npm 的版本对应这里） |
| `dev` | 日常开发，PR 全部 base 到这里 |

**注意**：发布机制变了——以前是手动 `git tag v*`，现在改成 **push 到 main 自动 publish**（幂等：如果 npm 已有该版本会跳过）。

## 发布流程

```bash
# 1. 在 dev 上：bump 版本号
git checkout dev
npm version patch    # 同时改 package.json 和 src/cli.ts / src/server.ts 的版本字符串
                     # （实际现在版本字符串还是手动同步，未来可写脚本自动同步）

# 2. 提交、push 到 dev
git push

# 3. PR 从 dev → main
gh pr create --base main --head dev --title "chore: release v1.x.x"

# 4. release-guard.yml 校验 package.json version 已 bump → ✓
# 5. 合并到 main
# 6. 自动跑：
#    - publish.yml: npm publish --access public --provenance
#    - auto-tag.yml: 创建 vX.Y.Z 标签
#    - ci.yml: 跑回归测试
```

需要 `NPM_TOKEN` secret 在 repo Settings 配好。npm provenance 让发布的包带 GitHub Actions 签名，npmjs.com 上每个版本页面会显示「Built and signed via GitHub Actions」徽章。

## 自托管

如果想跑自己的 dg-mcp 实例（比如装到内网服务器，让多个 Claude Desktop 连）：

1. 部署：`git clone` → `npm i` → `npm run build`
2. 启动：`node dist/cli.js`
3. 让 Claude Desktop 连上：

```json
{
  "mcpServers": {
    "dg-lab": {
      "command": "node",
      "args": ["/abs/path/to/DG-MCP/dist/cli.js"]
    }
  }
}
```

注意：MCP 走 stdio，**不是远程的**——必须跑在 Claude Desktop 同一台机器上。如果要跨机器，需要 stdio 桥接（比如 SSH ProxyCommand）。

## 二次开发

完整 fork 改造 dg-mcp（比如换 BLE 协议）：

1. `package.json` 改 `name` / `bin` 名字
2. `src/coyote-device.ts` + `src/noble-shim.ts` 替换协议层
3. `src/server.ts` 调整工具列表
4. 改 `npm publish` 流程

## 代码规范

完整规则在 `DG-MCP/CLAUDE.md`。要点：

- TypeScript strict、ESM only
- Node ≥ 20
- 不引入新 native module 依赖前要确保 macOS / Linux / Windows 都能编译
- 错误信息友好（用户看的是 Claude 反馈出来的字符串）
