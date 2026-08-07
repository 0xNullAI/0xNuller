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

### Realtime provider verification status (as of the doc-verification pass)

**xAI Grok** — confirmed working end-to-end by the user. It uses the CLASSIC/flat `session.update`
shape (`voice`/`input_audio_format`/`turn_detection` flat under `session`, `modalities`) and classic
event names (`response.audio.delta`). It REJECTS the nested shape ("Invalid event received").

**OpenAI GA and xAI have DIVERGED — this is the key gotcha.** Despite xAI advertising "OpenAI
Realtime compatible", OpenAI GA moved to a NESTED shape (`session.audio.input`/`session.audio.output`,
audio `format` as an object `{type:'audio/pcm', rate}`, `output_modalities`) and NEW event names
(`response.output_audio.delta`). So `OpenAiRealtimeSession.sendSessionUpdate()` branches on
`providerId`: `xai` → flat, `openai`/`azure` → nested GA. The RECEIVE side normalises both event-name
families via `EVENT_ALIASES`, so only the send path branches. Verified against
developers.openai.com/api/docs. OpenAI/Azure nested path is NOT live-verified.

**Azure** tracks OpenAI GA. Its mint endpoint was migrated from the DEPRECATED preview
`/openai/realtimeapi/sessions?api-version=...` (which returned `client_secret.value`) to GA
`/openai/v1/realtime/client_secrets` (flat `value`), and the WS URL from
`/openai/realtime?api-version=...&deployment=...` to `/openai/v1/realtime`. `session.model` carries
the DEPLOYMENT name. Least-verified provider; GA docs are WebRTC-first so even WS support is assumed.

**Zhipu GLM** — verified against docs.bigmodel.cn. Endpoint `wss://open.bigmodel.cn/api/paas/v4/realtime`;
model `glm-realtime-flash`/`glm-realtime`/`glm-realtime-air` (no activation needed, just account
tier V0–V3 for concurrency). Fixes from the doc pass: (1) JWT header now `{alg,typ,sign_type}`,
byte-identical to Zhipu's PyJWT reference (was missing `typ`); (2) `output_audio_format` is `pcm`
not `wav` — the old code stripped a nonexistent 44-byte wav header off every output chunk, dropping
real samples; (3) `chat_mode`/`tts_source` moved into `beta_fields` (were flat, so ignored — the
e2e voice path never engaged); (4) function-call event carries `name`/`arguments`/`response_id` with
NO `call_id`, so requiring call_id silently dropped every GLM tool call — now falls back to
response_id; (5) `function_call_output` sends only `{type,output}` (no call_id); (6) voice list
corrected (had Azure-style names that don't exist on Zhipu). Auth is `?Authorization=<jwt>` query
param — the browser can't set the header GLM's docs describe, but a live probe confirmed the server
reads the query param. (7) **`tool_choice` must be OMITTED** — a live-key probe (v0.7.3) found GLM
400s the ENTIRE `session.update` ("API 调用参数有误") whenever `tool_choice` is present; every variant
with it errored, every one without it returned `session.updated`. The tool *shape* (flat
`{type:'function',name,description,parameters}`) is accepted. (8) **Do NOT send a client heartbeat** —
GLM's `heartbeat` is server→client only; sending `{type:'heartbeat'}` 400s and used to kill the
session ~30s in (the old `onConnected` interval did exactly this). (9) **GLM server_vad never ends a
turn** — it emits `input_audio_buffer.speech_started` but never `speech_stopped`, so a server_vad-only
session gets audio but never replies ("说话没反应"), regardless of format/pacing/threshold params.
Fixed with client-side turn detection (`usesClientTurnDetection()` → RMS silence detector in
base-realtime-session that sends `input_audio_buffer.commit` + `response.create`); xAI/OpenAI keep
server_vad. (10) **Every tool needs a NON-EMPTY `required`** — argless/optional-only tools
(shock_stop/vibrate_stop, whose only param `channel` is optional) omit `required`; GLM's generation
backend coerces the falsy value to null (`[] or None`) and 422s ("Input should be a valid list",
`tools[1]`/`tools[8]`) once it engages tools. `[]` does NOT help (also falsy). `GlmRealtimeSession`
overrides `mappedTools()` to mark every property of an otherwise-empty-required object as required
(GLM-only; xAI/OpenAI keep `channel` optional). Trade-off: on GLM the model must name a `channel` to
stop; the 紧急停止 button (emergencyStop) still zeroes everything. (11) **GLM reuses ONE `item_id`
for the whole turn** — the user's input transcription and the assistant's reply share it, AND the
reply streams BEFORE the late input-transcription arrives. So transcript ids are role-namespaced
(`user:`/`assistant:`) to stop the reply overwriting the user's line, and the user's line is reserved
on `conversation.item.created` (which fires first) to keep it above the reply. (12) GLM wraps a tool
call in `response.function_call.inner_tool` / `.inner_tool.result` around the real
`response.function_call_arguments.done` — tolerated in `handleDialectEvent`.

**GLM is now confirmed working end-to-end against a real key (v0.7.3)**: session, audio round-trip,
transcripts (correct order), and a real tool call all verified. Tool calls need a device connected
(the instructions tell GLM there's none otherwise) and GLM is more conservative than xAI, so it wants
the device-context + "call, don't ask" nudge the connected-device instructions provide. Real-mic
client-VAD thresholds (CLIENT_VAD_* in base-realtime-session) may still want tuning.

`scripts/glm-connftest.mjs` signs a JWT with the app's exact algorithm and does a plain HTTPS GET
(not a WS upgrade) so the server's real error body is visible — a browser WS handshake 401 hides
its body from JS, making a rejected token indistinguishable from any other failure in-app. Both
sessions' `handleMessage()` also log every unrecognised event's full payload (temporary, remove once
a real call is confirmed working). Search `NOT LIVE-VERIFIED` before trusting any unverified detail.

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
