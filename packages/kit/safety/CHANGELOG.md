# @dg-kit/safety

## 1.17.0

### Minor Changes

- 2616514: `DeviceLifecycleGuard` accepts an optional `keepInBackground` policy and `onBackgroundKept` callback. Without them it still stops output whenever the page hides; leaving the page always stops.

### Patch Changes

- Updated dependencies [2616514]
  - @dg-kit/protocol@1.17.0
  - @dg-kit/core@1.17.0

## 1.16.6

### Patch Changes

- 9f82b9f: - `@dg-kit/protocol`: a Coyote's 100 ms output tick now notifies state listeners only when the state actually changed. Explicit changes (strength, waveform, limits, connection, stop) still notify immediately. Apps that re-rendered on every tick while a device sat idle no longer do.
  - `@dg-kit/safety`: the safety notice says 网络链路 instead of 桥接链路; the QQ/Telegram message bridge it referred to no longer exists.
- Updated dependencies [9f82b9f]
  - @dg-kit/protocol@1.16.6
  - @dg-kit/core@1.16.6

## 1.16.5

### Patch Changes

- 1d64c9d: Mark queued or in-flight device commands interrupted by emergency stop, so callers cannot present their post-stop state as proof that the original command completed.
- Updated dependencies [82404f4]
  - @dg-kit/protocol@1.16.5
  - @dg-kit/core@1.16.5

## 1.16.4

### Patch Changes

- Updated dependencies
  - @dg-kit/protocol@1.16.4
  - @dg-kit/core@1.16.4

## 1.16.3

### Patch Changes

- d282987: Expose an atomic module lease holder and monotonic epoch snapshot for ABA-safe native-write fencing.
- b13fc20: Add generation-based emergency-stop preemption to the Opossum command queue and expose explicit queue emergency-stop methods for safe runtime teardown.
  - @dg-kit/core@1.16.3
  - @dg-kit/protocol@1.16.3

## 1.16.2

### Patch Changes

- Updated dependencies [71e06ae]
  - @dg-kit/protocol@1.16.2
  - @dg-kit/core@1.16.2

## 1.16.1

### Patch Changes

- Updated dependencies [8341b9a]
  - @dg-kit/protocol@1.16.1
  - @dg-kit/core@1.16.1

## 1.16.0

### Patch Changes

- @dg-kit/core@1.16.0
- @dg-kit/protocol@1.16.0

## 1.15.0

### Patch Changes

- Updated dependencies [d29dd12]
  - @dg-kit/core@1.15.0
  - @dg-kit/protocol@1.15.0

## 1.14.0

- First public release of the shared safety policy, command queue, lifecycle guard, global stop bus, device registry, and control leases.
