# CLAUDE.md

Guidance for Claude Code working in **DG-Chat** — the multi-user P2P room with built-in DG-Lab Coyote remote-control.

## Project Overview

DG-Chat is a Vite + React 19 SPA plus a Cloudflare Worker. Rooms are relayed in real time over a **Cloudflare Durable Object WebSocket** (one `RoomDO` instance per room code), which replaced the earlier public-MQTT-broker transport — there is no WebRTC/PeerJS despite older docs. Each user can grant remote control of their Coyote to other room members; commands ride the same WebSocket. Front-end, WebSocket relay, lobby API and R2 media are all same-origin, served by one Worker via **Workers Static Assets** (chat.0xnullai.com).

All BLE protocol + waveform code is reused from [`@dg-kit/*`](https://github.com/0xNullAI/DG-Kit) — DG-Chat owns the React UI, the Cloudflare Worker realtime layer (`worker/`), and the in-room command routing.

## Realtime architecture (worker/)

- **`worker/index.ts`** — Worker entry. Routes `/ws/room/:code` → RoomDO, `/ws/lobby` + `/api/lobby/rooms` → LobbyDO, `/api/upload|media/...` → R2, everything else → `env.ASSETS` (SPA).
- **`RoomDO`** (`worker/room-do.ts`) — per-room. WebSocket Hibernation relay; fan-out by message `t` field; injects trusted `_from`; `sys joined/left` presence; chat history in SQLite, replayed to newcomers as `history`; public rooms report to LobbyDO; after the last socket closes, `setAlarm(+10min)` then clears history + R2 media + lobby entry unless someone reconnects.
- **`LobbyDO`** (`worker/lobby-do.ts`) — singleton `idFromName("v1")`. Public-room registry, `/ws/lobby` live push + `/api/lobby/rooms` snapshot, stale eviction.
- **Wire protocol** (`worker/wire.ts`) — the old MQTT topics collapsed into a `t` field. Envelope `t` = type; chat timestamp is `ts` (NOT `t`). Front-end transport is `src/lib/room-transport.ts`; the public hook API of `use-peer-room.ts` is unchanged so `App.tsx` did not change shape.
- **Media** — images compressed client-side, voice via MediaRecorder; uploaded to R2 (`room/{code}/{id}`) through `/api/upload`, referenced in chat messages, deleted with the room.
- **Dev**: `npm run dev` (Vite) + `npm run cf:dev` (wrangler :8787); Vite proxies `/ws` and `/api` to the Worker. Vite's ws proxy is flaky for long-lived sockets (EPIPE → transport reconnect → app briefly drops back to RoomEntry); for WebSocket-heavy testing, build (`npm run build`) and hit the worker origin directly at `http://localhost:8787` (same-origin, no proxy). Production is same-origin so this is dev-only.

## Repo Layout

```
src/
  components/         UI components (ChatPanel, ControlPanel, MemberCard, …)
  hooks/              business hooks
    use-device.ts     wraps lib/bluetooth.ts, exposes React state
    use-peer-room.ts  room management over RoomDO WebSocket + member sync (public API stable)
    use-waveforms.ts  waveform library + import flow
  lib/
    room-transport.ts WebSocket client to RoomDO (auto-reconnect)
    lobby-client.ts   lobby subscription client
    media.ts          image compression + voice recording + R2 upload
    bluetooth.ts      DGLabDevice — wraps @dg-kit/protocol + transport-webbluetooth
    protocol.ts       P2P message protocol (chat, device commands, waveform transfer)
    commands.ts       in-room command routing
    waveforms.ts      built-ins re-exported from @dg-kit/waveforms + .pulse import + localStorage
    market.ts         DG-Market client — fetch community waveforms (paired with MarketImportDialog) for "import from market"
  styles/             tailwind tokens
  types/              ambient types (web-bluetooth.d.ts)
public/               static assets
```

## Branch & PR Convention

- `dev` — day-to-day development. **All PRs target `dev`**, never `main` directly.
- `main` — releases only; promoted from `dev` via release flow.
- Dependabot is configured against `dev`.

## Commands

```bash
npm install
npm run dev          # Vite dev server, http://localhost:5174/
npm run cf:dev       # wrangler dev (Worker + DO/R2 local, :8787); pair with `npm run dev`
npm run build        # tsc -b + Vite build
npm run preview      # preview the production build
npm run lint         # eslint
npm run deploy       # build + wrangler deploy
```

## Test & Commit Workflow

Before commits:

1. `npm run lint` — zero new warnings (existing baseline has unrelated lint warnings; do not introduce more)
2. `npm run build` — tsc + Vite must succeed

> No vitest suite yet. For protocol logic, the regression coverage lives upstream in DG-Kit's tests.

Commit message style — conventional commits:

```
type(scope): short imperative subject

Optional body explaining the WHY.
```

`type` ∈ `feat | fix | refactor | docs | chore | test | perf | style`. `scope` is usually a directory (`bluetooth`, `room`, `waveforms`, `ui`).

PR description template:

```
## Summary
1-2 sentences.

## Test plan
- [x] npm run build
- [x] npm run lint
- [ ] Smoke test: create room, connect device, exercise feature
```

## Architecture Notes

- **`lib/protocol.ts` is the P2P chat protocol** — types like `ChatMessage`, `MemberState`, `WaveformTransfer`. Don't confuse with `@dg-kit/protocol` which is BLE.
- **`lib/bluetooth.ts` is a thin wrapper** over `@dg-kit/protocol` + `@dg-kit/transport-webbluetooth`. Public API (`DGLabDevice`, `DeviceVersion`, `DeviceInfo`, `WaveFrame`) preserved so `use-device.ts` and `commands.ts` can compile unchanged. If you need a new BLE feature, add it to DG-Kit first, then expose here.
- **Default per-channel safety cap is 50** (out of 0-200). Set on connect via `protocol.setLimits(50, 50)`. Users adjust via the UI; remote operators cannot exceed the local cap.
- **localStorage namespacing**: `dg-chat-custom-waveforms`, `dg-bg-behavior`, etc. Don't collide with DG-Agent's keys (different host so it doesn't matter in practice, but be explicit about origin).

## UI Maintenance Notes

- Background-behaviour setting (stop / keep) must persist across reloads (localStorage)
- Member list and chat panel responsive split: desktop = side-by-side, mobile = tabs
- Remote control panel must read same state regardless of viewer (no role-based hiding of strength/limit)

## Sister Projects

| Project | Purpose |
|---|---|
| [DG-Kit](https://github.com/0xNullAI/DG-Kit) | Shared TypeScript runtime (consumed by this project) |
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | Browser AI controller |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP) | MCP server for Claude Desktop |

## Code Conventions

- TypeScript, ESM, React 19
- Tailwind CSS via `@tailwindcss/vite`
- UI strings in **Chinese (Simplified)**
- `import type` for type-only imports
- No emojis in code or comments unless explicitly requested
