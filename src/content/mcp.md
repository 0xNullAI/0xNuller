# DG-MCP 使用手册

让 Claude Desktop 等 MCP 客户端直接控制 DG-Lab 郊狼 2.0 / 3.0。

> [GitHub](https://github.com/0xNullAI/DG-MCP) · [npm](https://www.npmjs.com/package/dg-mcp)

## 这是什么

DG-MCP 把郊狼设备暴露成一组 [Model Context Protocol](https://modelcontextprotocol.io) 工具。任何 MCP 兼容的 LLM 客户端（Claude Desktop / Continue / Cline / Cursor 等）配置一行就能驱动你的设备——`scan` / `connect` / `start` / `stop` / `adjust_strength` / `change_wave` / `burst` / `design_wave` 全套都是普通的工具调用。

跑在 Node.js 里，通过 stdio 跟客户端通信。基于 [`@dg-kit/*`](#/kit) 中台。

## 状态

- `1.0.0` 正式版，已发布到 [npm](https://www.npmjs.com/package/dg-mcp)
- v0.1.x 的 Python 实现归档在 [`archive/0.x-py`](https://github.com/0xNullAI/DG-MCP/tree/archive/0.x-py) 分支，PyPI 上仍可下载但不再更新

## 系统要求

- **Node.js ≥ 20**（[官方下载](https://nodejs.org)）
- BLE 蓝牙适配器
- DG-Lab 郊狼 2.0 / 3.0
- 一个 MCP 兼容客户端（推荐 Claude Desktop）

## Claude Desktop 配置

### macOS

打开配置文件：

```bash
open -e ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

如果文件不存在就新建。粘贴：

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

保存。Claude Desktop → 退出 → 重启。

**首次启动会弹蓝牙权限请求**，允许它。如果没弹，进 系统设置 → 隐私与安全性 → 蓝牙，确认 Claude（或 Node）有权限。

### Windows

配置文件路径：

```
%APPDATA%\Claude\claude_desktop_config.json
```

通常在 `C:\Users\<你>\AppData\Roaming\Claude\`。粘贴同样的 JSON，重启 Claude Desktop。

> Windows 需要一个 noble 兼容的 BLE 适配器。**WSL 不支持** BLE，必须是原生 Windows 的 Node。

### Linux

```bash
mkdir -p ~/.config/Claude
nano ~/.config/Claude/claude_desktop_config.json
```

粘贴 JSON。然后给 Node 加 BLE raw-capture 权限：

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

不加这一步会得到 `Operation not permitted`。

> 系统升级 Node 后需要重新执行 setcap。

## 验证安装

终端跑：

```bash
npx -y dg-mcp --version    # 应输出 dg-mcp 1.0.0
npx -y dg-mcp --help        # 显示帮助
```

如果看到 help 文本，说明 npm + Node 都没问题。接下来回 Claude Desktop。

## 第一次跟 Claude 对话

打开 Claude Desktop。聊天框右下角应该出现 **🛠️ 工具图标**——点开能看到 dg-lab 的工具列表（scan / connect / start / ...）。

试试这些指令：

```
扫描一下 Coyote 设备
```

Claude 应该会调 `scan` 工具，几秒后列出找到的设备。

```
连上第一个设备
```

它会用上一步返回的 address 调 `connect`。成功后显示连接状态。

```
启动 A 通道，强度 5，呼吸波形
```

设备开始输出。

```
停一下
```

设备归零。

## 预加载波形包

启动时加一个波形目录：

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

目录下所有 `.pulse` 和 `.zip` 文件都会在启动时加载，进入波形库供 Claude 选用。

也可以单文件：

```json
"args": ["-y", "dg-mcp",
  "--waveforms", "/path/to/wave1.pulse",
  "--waveforms", "/path/to/wave-pack.zip"]
```

或者环境变量等价（多路径用冒号分隔）：

```json
"env": {
  "DG_MCP_WAVEFORMS_DIR": "/Users/you/wave-pack"
}
```

## 持久化用户波形

如果让 AI 用 `design_wave` 工具设计了新波形，希望下次启动还能用：

```json
"args": ["-y", "dg-mcp", "--library-dir", "/Users/you/.dg-mcp-library"]
```

设计的波形会写入 `~/.dg-mcp-library/waveforms.json`，下次启动自动加载。

## 工具详解

### 设备控制（来自 `@dg-kit/tools`）

| 工具 | 用途 | 限制 |
|---|---|---|
| `start` | 冷启动通道，一次设强度 + 波形 | 初始强度 ≤10 |
| `stop` | 停止通道；省略 `channel` 停全部 | 无 |
| `adjust_strength` | 相对调整强度 | ±10/步，5s 内最多 2 次 |
| `change_wave` | 不动强度，仅换波形 | 无 |
| `burst` | 短时拉到目标强度后自动回落 | 5s 内最多 1 次 |
| `design_wave` | 用 ramp/hold/pulse/silence 段落组合新波形 | 5s 内最多 1 次 |

### MCP 专属

| 工具 | 用途 |
|---|---|
| `scan` | 扫描附近设备，返回 `[{address, name, rssi, version}]` |
| `connect` | 用 `address` 连接 |
| `disconnect` | 断开 |
| `get_status` | 当前状态：连接、强度、波形、电池、上限 |
| `list_waveforms` | 列出所有波形（内置 + 已导入 + AI 设计） |
| `load_waveforms` | 运行时再加载一个 `.pulse` / `.zip` 文件 |
| `emergency_stop` | 立即归零所有通道 |

> **`timer` 工具在 MCP 模式下不可用**。MCP 没有「主动唤起 LLM」的能力，定时跟进需要客户端支持，目前没有。

## 安全约束

- 强度量程 **0-200**。冷启动工具自动钳制初始强度 ≤10
- **回合 ≠ 单次工具调用**：MCP 用 5 秒滑动窗口，每个工具有自己的窗口上限
- 软上限默认 200。如果要更严格，让 LLM 客户端在 system prompt 里加约束（例如「调强度不要超过 50」）
- 设备物理拨轮可以独立加强度——MCP 只是输入源
- 任何时候说「紧急停止」/「停一下」AI 都会调 `emergency_stop` 立即响应

## 多个客户端怎么办

DG-MCP 启动时会独占设备连接。如果你想：

| 场景 | 方案 |
|---|---|
| 同时用 Claude Desktop + DG-Agent | 不行，断开一个再连另一个 |
| Claude Desktop 与 DG-Chat 互动 | 同上 |
| 多个 Claude Desktop 实例同时控制 | 不行，shell stdin/out 是独占的 |

## 常见问题

**Q：Claude Desktop 看不到工具图标**

- 配置文件 JSON 格式错了？用 [JSONLint](https://jsonlint.com) 校验
- Claude Desktop 没完全重启？退出（不是关窗口）再开
- 看 Claude Desktop 的开发者工具：菜单栏 → Claude → 切到 Developer Mode → Inspect

**Q：scan 找不到设备**

- 设备没开机
- 已被别的程序连着（DG-Agent / DG-Chat / 官方 App）
- BLE 权限：mac 看系统设置；linux 看 `setcap`；windows 看驱动

**Q：connect 失败：`Operation not permitted` (Linux)**

- 没跑 setcap：`sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))`
- node 升级后失效，重新执行

**Q：connect 失败：Bluetooth 未授权 (macOS)**

- 系统设置 → 隐私与安全性 → 蓝牙
- 找到 Claude（或 Node 进程），勾选

**Q：connect 之后立刻断开**

- 设备电量低，重连前充电
- 距离太远 / 干扰

**Q：调强度不动 / 波形听不到**

- 通道是否已 `start`？
- 撞到软上限了？`get_status` 看 limitA / limitB
- 设备物理拨轮位置

**Q：`design_wave` 设计的波形保存到哪了？**

- 默认放内存，进程退出就丢
- 想保留：启动加 `--library-dir <path>`

**Q：升级 dg-mcp 怎么搞**

- `npx -y dg-mcp@latest`，npx 自动拉最新版
- 或者全局装 `npm i -g dg-mcp@latest`

## 在其他 MCP 客户端里用

跟 Claude Desktop 一样，只是配置文件位置不同：

| 客户端 | 配置位置 |
|---|---|
| **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` (mac) |
| **Continue (VS Code)** | `~/.continue/config.json` 或扩展设置 |
| **Cline** | VS Code settings → MCP servers |
| **Cursor** | `~/.cursor/mcp.json` |
| **任何 MCP 兼容客户端** | 查它自己的文档，配 stdio 命令 `npx -y dg-mcp` |

## 安全须知

> **本项目仅供学习交流使用，不得用于任何违法或不当用途。**
>
> 强度从低开始（≤10），熟悉响应曲线再放开上限。任何时候不舒服，对 AI 说「停一下」立即归零，或直接关 Claude Desktop / 关蓝牙。
>
> 使用者自行承担一切风险，项目作者不对因使用本项目而导致的任何损害承担责任。
