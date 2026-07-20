---
"@dg-kit/protocol": minor
---

`OpossumState` gains optional `patternA`/`patternB` — the named rhythm preset each channel's B0 stream currently follows ('constant' on connect), so UIs and the LLM status block can show which rhythm is running the same way Coyote's state already reports `currentWaveA/B`. `setVibrationPattern` now accepts a preset name (`'pulse'` etc.) in addition to a raw envelope array; named calls stamp the state field, raw-array calls blank it (custom envelope, no name to report), and the change now emits a state update.
