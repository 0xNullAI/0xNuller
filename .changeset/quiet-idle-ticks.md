---
'@dg-kit/protocol': patch
'@dg-kit/safety': patch
---

- `@dg-kit/protocol`: a Coyote's 100 ms output tick now notifies state listeners only when the state actually changed. Explicit changes (strength, waveform, limits, connection, stop) still notify immediately. Apps that re-rendered on every tick while a device sat idle no longer do.
- `@dg-kit/safety`: the safety notice says 网络链路 instead of 桥接链路; the QQ/Telegram message bridge it referred to no longer exists.
