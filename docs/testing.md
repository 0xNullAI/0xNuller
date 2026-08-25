# 测试规范

## 目标

测试保护共享设备语义、用户可见回归和发布边界。全绿还必须意味着所有测试文件确实被执行；
测试静默漏跑本身就是失败。

## 测试层级

| 层级          | 位置                                     | 典型范围                     |
| ------------- | ---------------------------------------- | ---------------------------- |
| 领域单元测试  | `packages/*/*/src` 源码旁                | 纯状态、安全、协议帧、解析器 |
| 适配器测试    | transport/provider 包                    | 模拟 BLE、HTTP、存储、时钟   |
| 功能/组件测试 | `apps/*/src` 源码旁                      | hook、UI 契约、回归场景      |
| Worker 测试   | `workers/*/src` 或 `apps/*/worker`       | 请求校验、持久化、房间行为   |
| 外壳集成测试  | 外壳 `src/*.test.tsx` 或 `src/__tests__` | 模块装配、生命周期、路由     |
| 冒烟/真机测试 | 脚本及手工 Web/Android 检查              | 生产端点、权限、真实 BLE     |

## 放置与命名

优先使用源码/测试相邻结构：

```text
waveform-playback.ts
waveform-playback.test.ts
```

仅当测试负责跨文件的组合契约时使用 `__tests__`。`apps`、`packages`、`android`、`workers`
或 `scripts` 下的所有 test/spec 文件都必须出现在 `npm run check:structure` 中；若漏跑，应修正
对应 Vitest project 的 include。

当一个测试文件跨越多个可独立理解的职责时，按外部行为域拆成相邻 suite，例如会话/上下文、
设备安全策略、定时与系统触发、多设备和传感器。共享 fake、builder 与内存存储放进明确命名的
`*.test-support.ts`，支持文件只提供 fixture，不注册 `describe`/`it`。拆分是结构变更，不是
覆盖率压缩：不同语义的断言、安全拒绝、clamp、急停和生命周期用例必须原样保留，并在拆分前后
核对测试数。这样每个 suite 可单独运行，也能由 Vitest 跨文件并行调度。

## 回归测试要求

- 用最小且稳定的 fixture 重现原始失败。
- 断言外部行为与安全结果，不绑定无关实现细节。
- 设备功能按需覆盖双通道和多设备隔离。
- 类型功能覆盖电击、震动和未标类型旧数据。
- Android/Web 差异：共享行为测试一次，各平台适配边界分别测试。
- 播放、脉冲、重试、重连和超时必须使用假时钟，不等待真实时间。

## 四个 CI 责任域

| CI                | 范围                                     | 主要门禁                                 |
| ----------------- | ---------------------------------------- | ---------------------------------------- |
| `CI · Repository` | 全仓维护配置                             | 格式、Lint、结构、测试发现、tooling 测试 |
| `CI · Product`    | Web、Android、产品 apps/packages/workers | 类型、产品测试、Web 构建、版本/品牌/路由 |
| `CI · DG-Kit`     | `packages/kit`                           | Kit 测试、构建、npm tarball              |
| `CI · DG-MCP`     | `apps/mcp`                               | MCP 测试、构建、npm tarball              |

Kit 是 Product 和 MCP 的底层依赖，因此 Kit 改动同时触发三个专项 CI；这只验证消费者兼容，
不会在 Product/MCP 版本未变化时发布它们。

## 四层执行方式

### 一级：本地快速反馈

```bash
npm test
# 语义相同、用途更明确的别名
npm run test:fast
```

只读取工作区中已跟踪和未跟踪的改动，并记住上一次一级测试成功时的文件摘要。再次执行时只测
后来又发生变化的文件；同时限定在文件所属 Vitest project 内，不会因为共享 core 被所有 app
引用就扩散为全仓测试，也不重复构建 DG-Kit。缓存位于已忽略的 `.tmp`，测试失败时不会更新。

需要重测当前全部未提交改动，或检查相对某个分支的全部提交时：

```bash
npm run test:changed -- --all
npm run test:changed -- --base=origin/dev
```

也可以明确指定源文件，或持续监听当前改动涉及的测试：

```bash
npm run test:related -- packages/kit/core/src/waveform-playback.ts
npm run test:watch
```

这一层只服务编辑循环，不是提交门禁。它按文件归属缩小范围并缓存成功结果；共享层改动在交付前
必须继续执行三级 `affected` 或四级 `full`，不能用一级结果替代消费者兼容验证。

### 二级：模块测试

```bash
npm run test:module -- control
npm run test:module -- chat
npm run test:module -- kit platform
```

运行所选模块的所有测试，适合一个功能切片完成后执行。支持的短名称包括 `agent`、`android`、
`auth`、`chat`、`control`、`kit`、`market`、`mcp`、`platform`、`playground`、`tooling`、
`voice`、`web`。

### 三级：PR 受影响测试

```bash
npm run test:affected -- --base=origin/dev
```

这一层读取 workspace manifest 构建反向依赖图：例如 `packages/kit/core` 的变更不仅运行 Kit，
还会运行依赖它的平台包、产品 app 和 MCP 测试。全局 Vitest/setup、根依赖/TypeScript 配置或无法
映射的运行时代码会保守回退到全量；文档改动可以明确得到空测试集合。若在 CI job 中已经准备过
DG-Kit，可附加 `--prepared`，确保每个 job 只构建一次：

```bash
npm run test:affected -- --base="$BASE_SHA" --domain=product --prepared
```

`repository`、`product`、`kit`、`mcp` 四个 `--domain` 对应四条 CI。PR 使用反向依赖闭包；
`dev`/`main` 推送和手工触发仍运行完整责任域。

根 `npm run build` 同样只准备一次 DG-Kit，再按 Product 与 MCP 责任域构建；内部
`build:prepared` 只供已经完成 Kit 准备的编排调用，不应单独作为干净 checkout 的交付验证。

责任域全量命令仍可用于交付前定位：

```bash
npm run test:repository
npm run test:product
npm run test:kit
npm run test:mcp
```

### 四级：主干与交付全量测试

```bash
npm run test:full
# 等价的明确别名
npm run test:all
```

先重建 DG-Kit，再运行所有 Vitest project。`dev`/`main` 的四个责任域 CI 合起来覆盖同一完整
集合；交付前验证、全局测试配置改动和无法可靠分析影响范围的改动必须显式使用这一层。

交付前完整命令为：

```bash
npm run check:structure
npm run lint
npm run typecheck
npm run test:full
npm run build
```

若改动测试配置或全局测试 setup，一级测试会明确提示交付前必须运行全量层，但仍保持快速反馈。
`check:structure` 会把磁盘中的所有测试与 `vitest list --filesOnly` 对比，防止放错目录后被静默
跳过。

视觉改动还需提供对应手机/桌面宽度截图；BLE 或生命周期改动在发布前还需本地 Android 构建
和真机冒烟测试。
