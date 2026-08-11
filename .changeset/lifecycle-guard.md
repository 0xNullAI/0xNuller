---
'@dg-kit/safety': minor
---

Add `DeviceLifecycleGuard`: stop device output when the page is left or
backgrounded.

It replaces three near-identical copies (DG-Agent's `BrowserSafetyGuard`,
DG-Voice's `CallSafetyGuard`, and an inline handler in DG-Chat) and keeps the
strictest behavior of the three — backgrounding always stops output, with no
setting to disable it.
