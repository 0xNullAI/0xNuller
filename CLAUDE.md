# CLAUDE.md

Guidance for Claude Code working in **DG-Voice** — the realtime voice AI controller for DG-Lab devices.

## Project Overview

DG-Voice lets a user open a page and talk to an LLM like a phone call — no push-to-talk, no
typing. The model runs on a realtime speech-to-speech provider (xAI Grok, OpenAI Realtime, Azure
OpenAI Realtime, 智谱 GLM-Realtime) and decides on its own when to speak and when to call device
tools; DG-Voice's job is connecting the audio, enforcing the safety chain around every tool call,
and getting out of the way otherwise.

**Device scope: Coyote + Opossum only, by design.** Unlike DG-Agent (which also wires up the
paw-prints/civet-edging sensor kinds), DG-Voice deliberately does not support them — see
`device-session.ts`'s doc comment. A read-only sensor whose events aren't even wired into the
realtime session isn't worth the complexity here. Don't add them back without a concrete plan for
getting sensor events into the conversation (that's real, unbuilt work, not a small addition).

This is a **single-package Vite + React 19 SPA**, not a monorepo — unlike DG-Agent, which can't be
consumed by an external repo (its `packages/*` are all `private: true`). DG-Voice consumes the
published `@dg-kit/*` packages directly, the same way DG-Chat does.

## Status (v0.6.0)

**Working today**: device layer (Coyote + Opossum, one connect button, transport-injectable via
`DeviceSessionTransport` — see Architecture Notes), the full safety chain (policy engine,
permission service, serial command queue), the realtime voice connection layer (`RealtimeSession`
for xAI/OpenAI/Azure, `GlmRealtimeSession` for Zhipu, `VoiceToolBridge`), the persona system
(`src/lib/prompts/` — 7 built-in presets + custom + Market import, assembled by
`build-voice-instructions.ts` with live device-status injection), a settings sheet, a call panel
that transforms into a centered in-call view (timer, live captions) once connected, and a
persistent device status bar with live strength meters (`DeviceStatusBar.tsx`, ported from
DG-Agent's `ChatPanel.tsx` status chip pattern). Design system parity with DG-Agent. 70 unit tests.

**Not live-verified, but partially corrected by a real test**: a live connection attempt against
xAI came back `"Invalid event received"` for the original `session.update` shape (a newer/GA-shaped
schema with `audio.input`/`audio.output` nesting) — that was wrong. Both dialects now use the
classic/stable flat `session.update` shape (`voice`/`input_audio_format`/`turn_detection` at the
top level of `session`, event names like `response.audio.delta` not `response.output_audio.delta`)
which is far more likely correct given xAI's own "OpenAI Realtime compatible" claim predates any
newer schema. This has NOT yet been re-verified end-to-end (including an actual tool call) against
a real account — do that before trusting it fully. The `openai-insecure-api-key.` WebSocket-
subprotocol auth scheme and the ephemeral-token endpoint paths in `ephemeral-token.ts` remain
unverified. Search for `NOT LIVE-VERIFIED` comments before trusting any remaining detail, and don't
remove them until the corresponding code path is actually confirmed working. `handleMessage()`'s
`'error'` case now `console.error`s the full raw payload (not just `.message`) specifically so the
next live test surfaces enough detail (`code`/`param`/`event_id`) to pinpoint the next fix quickly.
One partial confirmation so far: a browser-side `fetch` to `https://api.x.ai/v1/tts/voices` with a
fake key returned a real HTTP 400 (not a CORS failure), confirming the endpoint is browser-reachable
— the auth format itself is still unverified.

## Permission model — read before touching

`use-realtime-call.ts` passes `settings.permissionMode` to
`BrowserPermissionService` **verbatim**. It previously rewrote `'confirm'`
(the strictest option *and* the default) to `'timed'` and pre-seeded the timed
grant as already-valid, which meant no confirmation prompt could appear in any
mode — the setting was decorative while its own label read "最严格". A code
comment described this as "one-time pre-call authorization", but no such
authorization step existed anywhere; consent was simply skipped. On a device
that delivers electrical stimulation this is a safety defect, not a UX
shortcut. If a smoother in-call flow is wanted later, it must be an actual
consent gate the user passes through — never a grant assumed on their behalf.

The prompt UI is `PermissionModal.tsx`, ported verbatim from DG-Agent so both
apps behave identically: four scopes, with the two wide grants (5 分钟 /
本会话) folded behind "高级选项" because mobile users kept mis-tapping them
(DG-Agent issue #69). `tool-executor.ts` passes the **post-policy** command to
the modal (`describeDeviceCommand`/`describeOpossumCommand`), so what the user
confirms is what actually runs after clamping — not the model's raw request.
`hangUp()` resolves any still-open request as denied; otherwise the executor
would await a promise that never settles.

## Persona / instructions model

`promptPresetId` + `savedPromptPresets` in `VoiceSettings` (not a free-text `instructions` field —
that was tried and replaced) mirror DG-Agent's preset model: built-in presets
(`src/lib/prompts/presets/*.ts`, rewritten for spoken brevity vs. DG-Agent's chat-oriented originals)
are selectable and hideable but never editable; only `custom-*`/`market-*` ids in
`savedPromptPresets` are user-editable. `build-voice-instructions.ts` is the only place that turns a
preset into the actual `instructions` string sent to the provider — it always appends code-owned
device-capability, story-mapping, and safety-rule blocks the user can't remove, then a live
device-status block. `use-realtime-call.ts` rebuilds and re-pushes that status block via
`RealtimeSession.updateInstructions()` (debounced 1.5s) whenever `DeviceSession.onChanged()` fires
mid-call, so the model's picture of current strength/connection state doesn't go stale over a long
call. If you add a new settings field that affects instructions (e.g. a new safety cap), thread it
through `VoiceInstructionSettings` in `build-voice-instructions.ts`, not by hand-editing a stored
prompt string.

**Not built yet**: custom voice upload, a connection-test button, a running cost timer.

**Android**: `apps/tauri-android` is a Tauri shell reusing `../../src` unchanged. The ONLY
Android-specific device code is `tauri-transport.ts` (the `DeviceSessionTransport` injected into
`<App transport={...}>`); everything else — UI, safety chain, realtime layer — is shared. Three
things must be re-applied by hand after every `tauri android init` (it regenerates `gen/android`
from scratch): the manifest permissions from `AndroidManifest.template.xml` (RECORD_AUDIO **and**
MODIFY_AUDIO_SETTINGS together — wry's all-or-nothing getUserMedia grant), `minSdk = 26` (plugin-blec
requirement), and the `signingConfigs`/`buildTypes` release block from `signing.gradle.kts.template`
(reads `DG_VOICE_*` env). `lifecycle-safety.ts` emergency-stops both output devices on any suspend
signal regardless of call state — screen-off-stops is the only safe mobile default for a stim device.

## Repo Layout

```
src/
  lib/            Pure TS — device layer, safety chain, realtime client (no React)
    device-session.ts       Unified 4-kind device connect (@dg-kit/transport-webbluetooth)
    policy-engine.ts         PolicyEngine / OpossumPolicyEngine
    default-policies.ts      Cold-start clamp, strength caps, burst caps, permission gate
    device-command-queue.ts  Serial per-device command queue + emergencyStop priority interrupt
    permissions.ts           BrowserPermissionService (confirm / timed / allow-all)
    tool-registry.ts         @dg-kit/tools wiring + sliding-window rate limits
    tool-executor.ts         Resolves a ToolCall through the full safety chain
    waveform-library.ts      IndexedDB-backed WaveformLibrary for design_wave
    types.ts                 ActionContext / PolicyDecision / PermissionService (agent-only,
                              not shipped by @dg-kit — mirrors the equivalent DG-Agent slice)
  hooks/          React bindings over lib/ (use-device-session.ts, ...)
  components/     UI (ui/ = shadcn primitives copied from DG-Agent, verbatim)
  services/       Stateful singletons (theme.ts)
  styles/         Design tokens — copied from DG-Agent, do not hand-edit values here without
                  also checking DG-Agent/DG-Chat still look the same (shared brand)
worker/           Cloudflare Worker — pure static-asset host, no server-side proxy (see below)
```

## Why there's no server-side proxy

Every supported provider's ephemeral-token endpoint was verified (via a real `curl -i -X
OPTIONS` preflight, not assumption) to return `Access-Control-Allow-Origin: *`, so the browser
mints its own realtime session token directly with the user's BYO key. 智谱 GLM goes further —
its key is signable client-side (HS256 JWT, `{id}.{secret}`) with no network round-trip at all.
**Do not add a relay Worker "just in case."** If a future provider genuinely requires
server-side token minting, that's the trigger to add one — not before.

## Branch & PR Convention

- `dev` — day-to-day development. All PRs target `dev`, never `main` directly.
- `main` — releases only, synced from `dev`.
- `auto-tag.yml` tags + creates a GitHub Release automatically on every push to `main`.
- `release-guard.yml` blocks a PR into `main` that doesn't bump `package.json`'s version.

## Commands

```bash
npm install
npm run dev           # Vite dev server
npm run build         # tsc -b + vite build
npm run typecheck     # tsc -b
npm run test
npm run test:watch
npm run lint
npm run cf:dev         # wrangler dev, local Worker preview
npm run deploy         # build + wrangler deploy
```

## Test & Commit Workflow

Before every commit:

1. `npm run lint` — zero warnings policy (no `|| true` baseline — keep it that way)
2. `npx tsc -b` — clean
3. `npm run test`
4. `npm run build`

Commit message style — conventional commits (`type(scope): subject`). `type ∈ feat | fix | docs |
refactor | perf | test | chore | ci | style`.

## Architecture Notes

- **Device layer comes from `@dg-kit/*` 1.13.0, not hand-rolled.** `WebBluetoothOpossumClient` /
  `WebBluetoothPawPrintsClient` / `WebBluetoothCivetEdgingClient` and the aux-connect helpers were
  extracted into `@dg-kit/transport-webbluetooth` specifically so this repo (and any future
  consumer) doesn't need a fourth independent implementation — DG-Agent, DG-Kit's own Tauri
  transport, and DG-Chat each had their own before that. If you find yourself writing a new
  per-kind BLE client here, that's very likely the wrong layer — it belongs in `@dg-kit/*`.
- **No agent loop.** Unlike DG-Agent's `AgentRuntime.runToolLoop()`, DG-Voice never decides when
  to call the model — the realtime provider does that server-side. The only local loop is
  `ToolExecutor`, which runs *after* the provider has already decided to call a tool.
- **Rate limiting is sliding-window, not per-turn.** `tool-registry.ts` injects
  `createSlidingWindowRateLimitPolicy` (same choice as DG-MCP) because a realtime session has no
  "turn" boundary. Caps must key on the registry's current primary tool names
  (`shock_adjust`/`shock_burst`/`vibrate_adjust`/`vibrate_burst`) — a stale alias key silently
  stops limiting instead of erroring. This exact bug shipped once in DG-MCP; don't repeat it.
- **`resolvePolicy`/`resolveOpossumPolicy` re-evaluate after every clamp** (bounded at 4
  iterations) — a clamp must not short-circuit a later `permission-gate` rule. This is the
  single easiest thing to get wrong when touching `tool-executor.ts`.
- **All 13 tools are declared at connect time, unfiltered by connection state** — unlike
  DG-Agent's `filterToolDefinitionsByConnectedDevices()`. Most realtime providers can't update
  the tool list mid-session, so an unconnected-device tool call is denied at execution time
  instead, with a reason the model can act on.

## Design System

Tokens, the 12 shadcn `ui/` primitives, `cn()`, and `theme.ts` are copied verbatim from
`DG-Agent/apps/web/src/{styles,components/ui,lib/utils.ts,services/theme.ts}` — DG-Agent and
DG-Chat already share one design language (identical token values in both light and dark
themes), so this repo inherits it rather than inventing a third look. If DG-Agent's design
system changes, check whether DG-Voice should follow.

## Safety-chain provenance

`policy-engine.ts`, `default-policies.ts`, and `device-command-queue.ts` are ported from
`DG-Agent/packages/runtime/src/{policy-engine,default-policies,device-command-queue}.ts` with
import paths adjusted for a standalone repo — the safety *semantics* (cold-start clamp, strength
caps, burst caps, permission gate ordering) must stay identical to DG-Agent's. If DG-Agent's
safety rules change, this file drifts unless someone updates it by hand — there is currently no
shared package for this (DG-Kit's own CLAUDE.md says policy is deliberately runtime-injected, not
baked into `@dg-kit/*`). If this experiment sticks, promoting these three files into `@dg-kit/*`
(pure addition, non-breaking) would close that gap — not done yet.

## Sister Projects

| Project | Purpose |
|---|---|
| [DG-Kit](https://github.com/0xNullAI/DG-Kit) | Shared TypeScript runtime (consumed by this project) |
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | Browser AI controller (text chat) |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | Multi-user P2P room with remote-control |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP) | MCP server for Claude Desktop and other MCP clients |

## Code Conventions

- TypeScript with `strict: true`, `noUncheckedIndexedAccess: true`
- ESM only (`"type": "module"`)
- `import type` for type-only imports
- Unused vars must be prefixed `_`
- No emojis in code or comments unless explicitly requested
- Comments explain WHY, not WHAT
- UI strings in **Chinese (Simplified)**, matching DG-Agent/DG-Chat
