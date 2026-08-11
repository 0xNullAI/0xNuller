# @dg-kit/safety

## 1.14.0

### Minor Changes

- 436c17a: Add `DeviceLifecycleGuard`: stop device output when the page is left or
  backgrounded.

  It replaces three near-identical copies (DG-Agent's `BrowserSafetyGuard`,
  DG-Voice's `CallSafetyGuard`, and an inline handler in DG-Chat) and keeps the
  strictest behavior of the three — backgrounding always stops output, with no
  setting to disable it.

- a8037cc: 首次发布：设备安全链的单一真身。

  策略引擎、默认策略（强度上限 / 冷启动钳制 / 调节步长 / 速率限制）、串行命令队列
  与急停插队、全局停止总线、设备清单、控制权租约。此前它只存在于 monorepo 内部；
  发到 npm 后外部消费者（自建部署、二次开发）也能用同一份安全链，而不是复制一份
  让它独立演化。

### Patch Changes

- Updated dependencies [c28b049]
- Updated dependencies [fff5af8]
  - @dg-kit/core@1.14.0
  - @dg-kit/protocol@1.14.0
