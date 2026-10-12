# @dg-kit/safety

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
