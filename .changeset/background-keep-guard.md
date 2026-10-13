---
'@dg-kit/safety': minor
---

`DeviceLifecycleGuard` accepts an optional `keepInBackground` policy and `onBackgroundKept` callback. Without them it still stops output whenever the page hides; leaving the page always stops.
