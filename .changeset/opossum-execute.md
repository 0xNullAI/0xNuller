---
"@dg-kit/protocol": minor
---

`OpossumVibrateAdapter` gains `execute(command: OpossumCommand): Promise<OpossumState>` — the vibrate-side counterpart of `CoyoteProtocolAdapter.execute()`. Every consumer previously hand-rolled its own `OpossumCommand`→adapter-method switch; DG-MCP's copy silently no-op'd on `vibrateBurst`/`vibrateSetPattern` (added in 1.10.0) because nothing forced it to stay exhaustive. `execute()` is now the single source of truth for that mapping, with a `never` check so a future `OpossumCommand` variant fails to compile here instead of silently doing nothing downstream.
