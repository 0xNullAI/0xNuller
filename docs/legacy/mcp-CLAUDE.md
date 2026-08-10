# CLAUDE.md

Guidance for Claude Code working in **DG-MCP** — the Model Context Protocol server for DG-Lab BLE devices (Coyote 2.0 / 3.0, plus the paw-prints sensor, civet-edging sensor, and opossum vibration controller).

## Project Overview

DG-MCP is a single-package Node.js CLI published to npm as `dg-mcp`. It speaks MCP over stdio so any MCP-compatible LLM client (Claude Desktop, Continue, etc.) can drive DG-Lab BLE devices — potentially several at once — over Bluetooth Low Energy.

The v0.1.x implementation (Python + bleak + FastMCP) is **archived** on the [`archive/0.x-py`](https://github.com/0xNullAI/DG-MCP/tree/archive/0.x-py) branch. The current v1.x rewrite is TypeScript on top of [`@dg-kit/*`](https://github.com/0xNullAI/DG-Kit) and `@stoprocent/noble`.

## Repo Layout

```
src/
  cli.ts                 entry; --waveforms / --waveforms-dir / --library-dir, env vars, runs stdio server
  server.ts              MCP server: @dg-kit/tools defs → MCP tool schema, plus device-management tools
  device-manager.ts      DeviceManager: Map<address, ConnectedDevice> — holds multiple concurrent BLE
                          connections keyed by address, one adapter per DG-Lab device family (coyote /
                          paw-prints / civet-edging / opossum), classifies via @dg-kit/protocol's
                          detectDeviceKind(), drives noble scan/connect/disconnect
  noble-shim.ts           @stoprocent/noble Characteristic → BluetoothRemoteGATTCharacteristicLike
  waveform-library.ts    fs-backed WaveformLibrary (built-ins + .pulse / .zip + JSON persist)
.github/workflows/
  ci.yml                 typecheck + build on PR
  publish.yml            npm publish on git tag (`v*`)
```

## Branch & PR Convention

- Default branch: `main`
- All changes go directly on `main` (small project, single-user surface)
- Use `archive/0.x-py` for any Python-version maintenance only
- Releases: tag a version on `main` with `git tag v1.0.x && git push --tags` → `publish.yml` pushes to npm using the `NPM_TOKEN` repo secret

## Commands

```bash
npm install
npm run build        # tsc -p tsconfig.json
npm run dev          # tsx src/cli.ts (hot reload during dev)
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run start        # node dist/cli.js (after build)
node dist/cli.js --version
node dist/cli.js --help
```

## Test & Commit Workflow

Before commits:

1. `npm run typecheck` — clean
2. `npm run test` — vitest suite passes (`waveform-library.test.ts`, `device-manager.test.ts`, `server.test.ts`)
3. `npm run build` — `dist/` produced, shebang preserved on `cli.js`
4. Smoke test the CLI: `node dist/cli.js --version` and `--help` (sanity that stdio server boots)

`device-manager.test.ts` fakes `@stoprocent/noble` entirely via `vi.mock` (plain module-level fake instance,
not `vi.hoisted` — that runs its callback eagerly at the hoisted position, before the `node:events` import
binding is live, and throws a TDZ error) and drives the real, unmocked `@dg-kit/protocol` adapters through
it, so it exercises `detectDeviceKind()` classification end-to-end (including the regression case: a
paw-prints-prefixed name must resolve to `'paw-prints'`, not get folded into the coyote/v3 bucket).
`server.test.ts` seeds a real `DeviceManager`'s internal map directly (bypassing noble) with adapters
connected through a minimal fake GATT context, then drives tool calls through a real MCP `Client`/`Server`
pair over `InMemoryTransport` — this is what covers the `ToolExecutionPlan` dispatch branches (`'opossum'`,
`'setIndicatorColor'`) and the device-targeting error messages (zero / multiple connected devices of a kind).

There's no separate lint script; typecheck (`strict: true`) is the enforced static check.

Commit message style — conventional commits. PR description follows the same template as other DG repos.

## Releasing

```bash
# 1. Bump version in package.json (and update src/cli.ts and src/server.ts version strings)
# 2. Commit, push to main
# 3. Tag and push:
git tag v1.0.x
git push origin v1.0.x
# 4. .github/workflows/publish.yml runs npm publish --access public
```

Make sure `NPM_TOKEN` is configured under repo Settings → Secrets → Actions.

## Architecture Notes

- **Protocol code is `@dg-kit/protocol`**; this project only writes the noble shim that satisfies `BluetoothRemoteGATTCharacteristicLike`. The same protocol logic that DG-Agent and DG-Chat use runs unchanged.
- **Multi-device**: `DeviceManager` (`src/device-manager.ts`) holds `Map<address, ConnectedDevice>`, a discriminated union on `.kind` (`'coyote' | 'paw-prints' | 'civet-edging' | 'opossum'`). Each kind keeps its own native `@dg-kit/protocol` adapter shape rather than being forced through one polymorphic interface — Coyote drives `CoyoteProtocolAdapter` (`WebBluetoothProtocolAdapter`, `DeviceCommand`/`DeviceState`), paw-prints/civet-edging drive `WebBluetoothSensorAdapter<TReading>` (event-pushing sensors, no strength state, latest reading cached per device since MCP tool calls poll rather than subscribe), and opossum has its own standalone `OpossumVibrateAdapter`/`OpossumState` (implements neither of the above interfaces upstream).
- **Device targeting**: registry tools (`vibrate_start`, `start`, etc.) don't carry a `deviceId` param yet — `DeviceManager.findSingleByKind()` picks the single connected device of the required kind, or throws a clear Chinese error if zero or more than one is connected (multi-device-of-the-same-kind targeting is intentionally out of scope; `scan`/`connect`/`disconnect`/`get_status`/`list_connected_devices` are how a caller manages that today).
- **Rate-limit policy**: `createSlidingWindowRateLimitPolicy({ windowMs: 5000, caps: { shock_adjust: 2, shock_burst: 1, design_wave: 1, vibrate_adjust: 2, vibrate_burst: 1 } })`. MCP has no notion of "turns" so a time window is the right model. Caps must key on the registry's _current_ primary tool names (`shouldAllow()` is called with the resolved name) — a stale key from a pre-rename tool name silently stops limiting anything instead of erroring, since `caps` is just an open `Record<string, number>`.
- **Tool list** = registry tools (`shock_start` / `shock_stop` / `shock_adjust` / `shock_change_wave` / `shock_burst` / `design_wave` / `vibrate_start` / `vibrate_stop` / `vibrate_adjust` / `vibrate_change_pattern` / `vibrate_burst` / `set_indicator_color`) + MCP-only tools (`scan` / `connect` / `disconnect` / `get_status` / `get_sensor_state` / `list_connected_devices` / `list_waveforms` / `load_waveforms` / `emergency_stop`). The `timer` tool is registered but returns a "not supported in MCP" hint when invoked. `get_sensor_state` is MCP-only by design — per DG-Kit's own docs, sensor state isn't part of the shared cross-app tool registry. Pre-1.9.0 Coyote tool names (`start` / `stop` / `adjust_strength` / `change_wave` / `burst`) still resolve via the registry's alias mechanism; only `listDefinitions()` hides them.
- **Opossum commands dispatch through `OpossumVibrateAdapter.execute()`** (added in `@dg-kit/protocol@1.12.0`), the same pattern as Coyote's `CoyoteProtocolAdapter.execute()` — `server.ts` no longer hand-rolls an `OpossumCommand`→adapter-method switch. That hand-rolled switch (`applyOpossumCommand`, removed in 1.1.0) predated `vibrateBurst`/`vibrateSetPattern` and had no exhaustiveness guard, so it silently no-op'd on both when `@dg-kit/tools@1.10.0` added `vibrate_burst`/`vibrate_change_pattern` — the tools were listed and callable but did nothing. Don't reintroduce a local mapping here; if a new `OpossumCommand` variant is needed, it goes in the kit's `execute()`, not here.
- **noble version**: `@stoprocent/noble` (active fork). If swapping to another noble fork, verify the async API (`writeAsync`, `subscribeAsync`, etc.) is preserved — the shim relies on it.

## Platform Notes

### macOS

First run triggers a Bluetooth permission prompt. Allow it.

### Linux

Noble needs raw BLE permission:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

### Windows

Use a noble-supported BLE adapter. WSL2 doesn't expose Bluetooth — run the CLI in native Windows Node.

## Sister Projects

| Project                                          | Purpose                                              |
| ------------------------------------------------ | ---------------------------------------------------- |
| [DG-Kit](https://github.com/0xNullAI/DG-Kit)     | Shared TypeScript runtime (consumed by this project) |
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | Browser AI controller                                |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat)   | Multi-user P2P room                                  |

## Code Conventions

- TypeScript with `strict: true`, `noUncheckedIndexedAccess: true`
- ESM only (`"type": "module"`)
- `import type` for type-only imports
- No emojis in code or comments unless explicitly requested
