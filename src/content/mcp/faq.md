# DG-MCP · FAQ / 故障排查

## 常见问题

### Claude Desktop 看不到工具图标

- 配置文件 JSON 格式错了？用 [JSONLint](https://jsonlint.com) 校验
- Claude Desktop 没完全重启？退出（不是关窗口）再开
- 看 Claude Desktop 的开发者工具：菜单栏 → Claude → 切到 Developer Mode → Inspect

### `scan` 找不到设备

- 设备没开机
- 已被别的程序连着（DG-Agent / DG-Chat / 官方 App）
- BLE 权限：mac 看系统设置；linux 看 `setcap`；windows 看驱动

### `connect` 失败：`Operation not permitted`（Linux）

- 没跑 setcap：

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

- node 升级后失效，重新执行

### `connect` 失败：Bluetooth 未授权（macOS）

- 系统设置 → 隐私与安全性 → 蓝牙
- 找到 Claude（或 Node 进程），勾选

### `connect` 之后立刻断开

- 设备电量低，重连前充电
- 距离太远 / 干扰

### 调强度不动 / 波形听不到

- 通道是否已 `start`？
- 撞到软上限了？`get_status` 看 limitA / limitB
- 设备物理拨轮位置

### `design_wave` 设计的波形保存到哪了？

- 默认放内存，进程退出就丢
- 想保留：启动加 `--library-dir <path>`

### 升级 dg-mcp 怎么搞

- `npx -y dg-mcp@latest`，npx 自动拉最新版
- 或者全局装 `npm i -g dg-mcp@latest`

### 我有自己的波形库怎么集成？

启动时用 `--waveforms-dir <path>` 指向波形目录，DG-MCP 启动时全部加载。

也可以走 MCP 工具 `load_waveforms` 让 Claude 在运行时加载——不过这样下次重启又丢，除非你也配了 `--library-dir`。

### 跨平台兼容性

| 平台 | 状态 | 备注 |
|---|---|---|
| **macOS** (Apple Silicon / Intel) | ✅ | 首次跑要授予蓝牙权限 |
| **Linux** (Ubuntu / Debian / Arch) | ✅ | 需要 setcap |
| **Windows 10/11** | ✅ | 需要 noble 兼容的 BLE 适配器 |
| **WSL** | ❌ | WSL 不支持 BLE |
| **Raspberry Pi** | ⚠️ 未测 | 理论上可以，需要 BlueZ 5.43+ |
| **Termux (Android)** | ❌ | 受限的 Node 环境 |

## 故障排查

```
症状                              → 排查方向
─────────────────────────────────────────────────
Claude Desktop 工具图标不出现       → 配置文件 JSON 错 / 没重启
工具列表空                        → server.ts 抛异常没起来；看 stderr 日志
scan 返回空                       → 设备没开机 / 权限问题
connect 卡住                      → noble 一直 scanning；某些 BLE 适配器需要重启
connect 后立刻 disconnect          → 电量低 / 距离 / 干扰；换适配器试
ENOENT 找不到 node               → npx 没装 dg-mcp；换 npm i -g dg-mcp
write 操作 timeout                → 设备没在监听；重启设备
```

## 调试

启动时 stderr 有日志：

```bash
node dist/cli.js --waveforms-dir /tmp/test 2>&1 | tee dg-mcp.log
```

或者从 Claude Desktop 看：菜单栏 → Claude → Developer → "MCP Logs" 之类的入口。

## 哪些是有意为之的限制

下面这些不是 bug：

- **每 5 秒最多 1 次 burst**：滑动窗口限速
- **每 5 秒最多 2 次 adjust_strength**：同上
- **冷启动强度 ≤ 10**：协议层强制
- **`timer` 工具不可用**：MCP 没有"主动唤起 LLM"机制
- **不能跨机器**：MCP 走 stdio

如果你确认要放开（比如做自动化测试），可以 fork 改 `src/server.ts` 的 `createSlidingWindowRateLimitPolicy({ caps })` 配置。

## 隐私

- DG-MCP 跑在你本机 Node 进程里，**不上传任何数据**
- 跟 Claude Desktop 之间走 stdio（管道），离不开本机
- 蓝牙数据完全本地
- 唯一的网络访问：`npx -y dg-mcp` 第一次会从 npm 拉包；启动后就不再访问网络

## 跟其他 DG 项目并存

| 我同时想用 | 是否可行 |
|---|---|
| DG-MCP + DG-Agent 同电脑 | ❌ 蓝牙连接排他 |
| DG-MCP + DG-Chat 同电脑 | ❌ 同上 |
| DG-MCP + 官方 App | ❌ 同上 |
| DG-MCP 在 A 电脑，DG-Agent 在 B 电脑（同一设备配对过） | ⚠️ 同时只能连一处，但可以快速切换 |

## 反馈渠道

- **GitHub issue**：https://github.com/0xNullAI/DG-MCP/issues

提 issue 请附：

- 操作系统 + Node 版本
- 设备版本（V2 / V3）
- 用的 MCP 客户端（Claude Desktop / Continue / etc.）
- 复现步骤
- stderr 日志

## Python 版本（旧）

之前是 Python + bleak 实现，已归档：

- 分支：[`archive/0.x-py`](https://github.com/0xNullAI/DG-MCP/tree/archive/0.x-py)
- PyPI：仍可 `pip install dg-mcp`，但不再更新
- 推荐迁移到 npm 版本，功能更全（V2 + V3 双协议、波形持久化、设计工具）

## 免责声明

> **本项目仅供学习交流使用，不得用于任何违法或不当用途。使用者应自行承担使用本项目所产生的一切风险和责任，项目作者不对因使用本项目而导致的任何直接或间接损害承担责任。**
