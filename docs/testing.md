# 测试

测试只保护重要的外部行为，不追求把每个实现分支都重复覆盖。新增测试前，先确认现有更低层测试
没有证明同一件事。

## 保留什么

- 设备身份、连接拓扑、权限、租约、安全上限、停止与紧急停止。
- 协议的代表性编码/解码边界和 transport 的关键成功、失败路径。
- Auth、Chat、Market 与 Worker 的认证、授权和数据完整性。
- Agent、Voice、Video 的工具 schema、精确目标路由和关键会话行为。
- 每个主要界面的一条用户流程，以及版本、迁移和发布门禁。

不单独测试纯 getter、常量、文案、样式类名、第三方库行为或同一逻辑的所有输入排列。共享层已覆盖
的行为，应用层只验证装配成功，不再复制整套用例。

## 放在哪里

测试默认与源码相邻：

```text
waveform-playback.ts
waveform-playback.test.ts
```

只有跨文件的应用组合契约使用 `__tests__`。所有 test/spec 文件都必须被 Vitest project 收集；
`npm run check:structure` 会检查遗漏。

## 分层

文件后缀标明测试所在的层。没有后缀的文件是契约测试，也是最常见的一层。

| 层          | 文件名                        | 测什么                                                              |
| ----------- | ----------------------------- | ------------------------------------------------------------------- |
| unit        | `name.unit.test.ts`           | 纯函数与纯状态：没有 mock、网络、存储、DOM 或数据库                 |
| contract    | `name.test.ts`                | 一个模块的对外行为，边界处使用假实现：Worker 路由、DO、存储、客户端 |
| ui          | `name.ui.test.tsx`            | 用 `@testing-library` 渲染的组件或 hook                             |
| integration | `name.integration.test.ts(x)` | 多个模块组合：运行时 + 执行器 + 安全链、外壳 + 模块、备份流程       |

`npm run check:structure` 会检查后缀：unit 文件不能使用 mock、I/O、存储或 DOM；用
`@testing-library` 渲染的文件必须是 ui 或 integration。

```bash
npm run test:unit         # 最快，几秒内完成
npm run test:contract
npm run test:ui
npm run test:integration
node scripts/run-vitest.mjs run --layer=unit --domain=product   # 可与责任域组合
```

## 两个日常命令

```bash
npm test          # 当前分支及未提交改动影响到的项目
npm run test:full # 全部项目；交付前使用
```

`npm test` 根据 workspace 反向依赖选择项目。无法可靠判断范围、测试配置变化或根依赖变化时会自动
回退到完整集合。CI 在 PR 上使用相同的受影响选择，在 `dev` 和 `main` 上运行各责任域完整集合。

定位问题时可直接运行责任域：

```bash
npm run test:repository
npm run test:product
npm run test:kit
npm run test:mcp
```

## 交付门禁

```bash
npm run check:structure
npm run lint
npm run typecheck
npm run test:full
npm run build
```

真实 BLE、锁屏停止、浏览器权限、Realtime provider 和多台实体设备仍需手工验收；模拟测试不能
替代真机结果。
