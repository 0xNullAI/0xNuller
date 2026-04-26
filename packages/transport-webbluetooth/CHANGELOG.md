# @dg-kit/transport-webbluetooth

## 0.2.0

### Patch Changes

- 55017d6: Add `setLimits(limitA, limitB)` to `BaseCoyoteProtocolAdapter` (and the V2 / V3 / facade implementations). On V3 it re-sends the BF init packet so the device enforces the new soft-limit; on V2 it updates state for the next tick to clamp against. Reducing a limit also clamps the current strength downward immediately. This unblocks DG-Chat's per-channel safety cap UI in Phase 4b.
- Updated dependencies [55017d6]
  - @dg-kit/protocol@0.2.0
  - @dg-kit/core@0.2.0

## 0.1.1

### Patch Changes

- 39d6853: Fix published `package.json` so `main` / `types` / `exports` point to `dist/`. The previous 0.1.0 tarballs had `main: src/index.ts` from the unsupported `publishConfig.main` override pattern, which broke `import` resolution for downstream consumers. Local dev now requires `npm run build` before `typecheck` / `test` (wired automatically via `pretypecheck` / `pretest`).
- Updated dependencies [39d6853]
  - @dg-kit/core@0.1.1
  - @dg-kit/protocol@0.1.1

## 0.1.0

### Minor Changes

- 85c5805: Initial public release. Carved out from DG-Agent's internal packages and made runtime-agnostic so DG-Agent, DG-MCP, and DG-Chat can share a single source of truth for the device protocol, waveforms, and tool definitions.

### Patch Changes

- Updated dependencies [85c5805]
  - @dg-kit/core@0.1.0
  - @dg-kit/protocol@0.1.0
