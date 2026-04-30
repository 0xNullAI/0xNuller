# @dg-kit/core

## 1.1.0

### Minor Changes

- 22de7a5: Add `@dg-kit/transport-tauri-blec` — Tauri 2 BLE `DeviceClient` backed by `@mnlphlp/plugin-blec`. Mirrors `transport-webbluetooth` for non-browser runtimes (Tauri Android primary target). Synthesizes `BluetoothRemoteGATT*Like` shapes from plugin-blec's flat API so the Coyote protocol layer is unchanged.

## 1.0.1

### Patch Changes

- b189d86: CI / infrastructure release — no API or behaviour changes.
  - Unified PR / issue templates + dependabot config
  - release-guard workflow gates main entry on version bump
  - npm provenance enabled on publish

## 1.0.0

### Major Changes

- 340e495: First stable release. Three downstream consumers — DG-Agent (browser AI controller), DG-Chat (P2P multi-user room), and DG-MCP (Model Context Protocol server) — have all migrated onto the published `@dg-kit/*` packages and verified end-to-end against real Coyote 2.0 / 3.0 hardware. The public API (DeviceCommand shape, BaseCoyoteProtocolAdapter / WebBluetoothProtocolAdapter interfaces, ToolRegistry, RateLimitPolicy, WaveformLibrary, design-segment primitives, .pulse parser) is now considered stable; breaking changes will only ship as 2.x.

## 0.2.0

### Patch Changes

- 55017d6: Add `setLimits(limitA, limitB)` to `BaseCoyoteProtocolAdapter` (and the V2 / V3 / facade implementations). On V3 it re-sends the BF init packet so the device enforces the new soft-limit; on V2 it updates state for the next tick to clamp against. Reducing a limit also clamps the current strength downward immediately. This unblocks DG-Chat's per-channel safety cap UI in Phase 4b.

## 0.1.1

### Patch Changes

- 39d6853: Fix published `package.json` so `main` / `types` / `exports` point to `dist/`. The previous 0.1.0 tarballs had `main: src/index.ts` from the unsupported `publishConfig.main` override pattern, which broke `import` resolution for downstream consumers. Local dev now requires `npm run build` before `typecheck` / `test` (wired automatically via `pretypecheck` / `pretest`).

## 0.1.0

### Minor Changes

- 85c5805: Initial public release. Carved out from DG-Agent's internal packages and made runtime-agnostic so DG-Agent, DG-MCP, and DG-Chat can share a single source of truth for the device protocol, waveforms, and tool definitions.
