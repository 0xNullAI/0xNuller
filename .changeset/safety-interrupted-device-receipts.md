---
'@dg-kit/safety': patch
---

Mark queued or in-flight device commands interrupted by emergency stop, so callers cannot present their post-stop state as proof that the original command completed.
