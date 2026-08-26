# 0xNuller 仓库架构

本文描述 DG-Kit 与 DG-Agent 迁入后的当前 monorepo，用来判断代码归属；各公共包的具体
API 仍以包内 README 为准。

## 运行时组合

```text
网页浏览器                          Android
apps/web                           android/app
   |                                  |
   +------------ 功能模块 ------------+
       Control / Agent / Voice / Chat / Market / Playground
                              |
                  平台服务 + Agent 组合层
                              |
          Kit core / safety / tools / protocol / waveforms
                              |
                 Web Bluetooth 或 Tauri BLE 传输
```

`apps/web` 与 `android/app` 是组合外壳。功能 app 负责界面特有交互，需要跨界面保持一致的
行为必须进入共享包。

## 分层职责

| 层级  | 目录                                                                                      | 负责                                                          | 不负责                 |
| ----- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ---------------------- |
| 外壳  | `apps/web`、`android/app`                                                                 | 导航、模块装配、平台生命周期                                  | 协议规则、重复功能状态 |
| 功能  | `apps/control`、`apps/agent`、`apps/voice`、`apps/chat`、`apps/market`、`apps/playground` | 页面、功能 hook、功能 Worker 入口                             | 可复用设备语义         |
| 平台  | `packages/platform/*`                                                                     | 账号、权限、设置、同步、场景、共享设备会话/波形、Market 与 UI | BLE 数据包编码         |
| Agent | `packages/agent/*`                                                                        | runtime、provider、存储、桥接、浏览器组合                     | React 页面、GATT 细节  |
| Kit   | `packages/kit/*`                                                                          | 设备契约、安全、协议、工具、波形、传输                        | 产品导航、账号界面     |
| 后端  | `workers/*`、`apps/*/worker`                                                              | 独立部署的 API 与 Durable Object                              | 浏览器本地状态         |

目标依赖方向为 `外壳 -> 功能 -> platform/agent -> kit`。组合外壳可以装配功能 app，其他
app 之间不应为复用业务逻辑而互相导入，应下沉到合适的共享包。

## 共享设备模型

`@dg-kit/core` 定义公共语言，`@dg-kit/protocol` 实现设备行为，两套 transport 只适配 Web
Bluetooth 与 Tauri BLE 的差异，不应改变上层语义。安全和权限在协议执行之前统一包裹。

波形定义按输出类型共享：

- 郊狼：`electrostimulation`
- 负鼠：`vibration`
- 未标类型的旧数据：视为 `electrostimulation`

连接设备之间不共享播放状态。队列、模式、间隔、通道游标与运行状态都按设备 ID 隔离；
只有波形定义列表按类型共享。

## 状态放置

- 单个组件的视觉状态留在组件或专用 hook。
- 一个功能内部共享的状态进入该功能的 hook/store。
- 跨功能状态进入 `packages/platform` 或已有领域包。
- runtime 决策应保持为可脱离 React 测试的纯逻辑。
- 浏览器持久化通过共享 settings/sync/storage 包完成，不在功能组件里新增直接的
  `localStorage` 或 IndexedDB 实现。

## AI 与通用设备边界

| 能力                                       | 共享来源                               | 消费端                                      | 保留差异                                                                   |
| ------------------------------------------ | -------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| 文本 provider 目录、默认值、能力检查       | `@0xnullai/llm-providers`              | Agent、Chat、Video、Web 设置                | Video 只接受明确支持图片的 provider/model                                  |
| 文本配置存储                               | `@0xnullai/llm-providers` scoped store | Agent/Chat 共用 profile；Video 独立 profile | Video 的 key、版本与凭据不向文本 profile 迁移                              |
| 浏览器 LLM client、dialect、代理与模型发现 | `@dg-agent/agent-browser`              | Agent、Chat、Video、Web 设置                | prompt、历史、迭代和视觉帧仍由功能模块组合                                 |
| Realtime provider                          | `apps/voice/src/lib/realtime`          | Voice、Web Voice 设置                       | WebSocket 事件、音频、换票/JWT 与 voice catalog 不并入文本 HTTP client     |
| AI 通用设备 schema、调用与 permission 分类 | `@0xnullai/device-runtime`             | Agent、Voice、Video                         | Agent/Voice 各自适配运行时；Video 额外持有目标 grant、lease 和失效停止升级 |
| Chat 房间设备工具                          | Chat owner-side command policy         | 房间 Agent                                  | 远端目标由设备持有者授权和钳制，不能改成本地通用设备调用                   |

共享边界只统一相同语义：API key 的存储范围、provider 请求协议、工具授权、租约和停止顺序
不能因为 UI 或适配器复用而发生迁移。功能 app 不自行拼接 provider endpoint、代理 URL 或复制
通用设备 capability schema。

通用设备只使用「软件设置 → 关于」中的一个本机开关。Control、Agent、Voice、Video 订阅同一
provider 状态，不在各模块增加私有开关。关闭时不渲染通用设备入口、不加载或扫描 backend，
也不向模型提供通用设备说明、状态、工具或目标；Video 本身以及郊狼、负鼠路径不受影响。

AI 设备上下文采用当前可用能力的正向快照。只有当前已连接、功能已启用且 capability 健康的设备
可以进入 instructions、状态块、工具定义和 target allowlist；未连接、已禁用、已失效或只存在于
配置中的设备必须完全省略，而不是写成“未连接”。Agent 每轮重新计算；Voice 在拓扑变化时原子
更新 instructions 与 tools；Video 在开始授权及每次写入前继续核验一次性目标白名单。

## 文件组织

公共包的 `index.ts` 是稳定导出入口，不承载具体实现。实现文件按行为命名，测试与源码相邻；
只有跨多个文件的 app 组合测试可放在小型 `__tests__` 目录中。

`npm run check:structure` 会检查架构约束和测试发现配置。文件长度是评审信号而不是硬门禁；当
一个文件承担无关职责、边界不清或难以测试时应拆分，不要为了满足任意行数制造碎片模块。
架构 baseline 必须保持为空；已解决的跨层导入不能重新加入豁免来绕过门禁。

## 跨设备改动检查表

1. 共享 core 类型和规则；
2. 协议与两套 transport；
3. 安全与权限行为；
4. Control、Chat、Voice、Agent 消费端；
5. Web 与 Android 生命周期/错误路径；
6. 共享领域回归测试与受影响界面的专项测试。

分支和发布规则单独维护在 `docs/platform-release.md`。
