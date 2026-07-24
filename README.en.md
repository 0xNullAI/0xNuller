<div align="center">

# DG-Voice

**A realtime, phone-call-style voice AI that controls DG-Lab devices**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/built%20on-%40dg--kit%2F*-0a84ff)](https://github.com/0xNullAI/DG-Kit)

[中文](./README.md) | English

</div>

## What it is

DG-Voice keeps a live connection to an LLM the moment you open the page — like a phone call, no
push-to-talk, no typing. The model runs on a realtime speech-to-speech provider (xAI Grok, OpenAI
Realtime, Azure OpenAI Realtime, Zhipu GLM-Realtime) and decides on its own when to speak and
when to call device tools; DG-Voice wires the audio and guards every tool call with the safety
chain, staying out of the way otherwise.

Sister project to [DG-Agent](https://github.com/0xNullAI/DG-Agent) (text chat) — same
[`@dg-kit/*`](https://github.com/0xNullAI/DG-Kit) protocol layer, same design language, but a
completely different agent loop: there is no "turn" concept here, the provider drives scheduling
itself.

## ⚠️ Current status: v0.4.0, core features implemented but not verified against a real account

**Working today, with test coverage**:

- Unified connect for both supported DG-Lab device kinds — Coyote and Opossum — one button. **The
  two sensor kinds (paw-prints, civet-edging) are explicitly out of scope**, not a TODO: a read-only
  sensor feeding into a realtime voice session isn't worth its own complexity. The device layer now
  takes an injectable transport (paving the way for the Android/Tauri BLE shell)
- Full safety chain: policy engine (strength caps, cold-start clamp, burst caps), permission
  confirmation, serial command queue, emergency stop
- The realtime voice connection layer: `RealtimeSession` (openai-realtime dialect, covering
  xAI/OpenAI/Azure) + `GlmRealtimeSession` (Zhipu's variant) + `VoiceToolBridge` (tool-call bridging,
  including parallel-call waiting and audio-drain sequencing). `session.update` now uses the
  classic/stable event shape — a live test against xAI rejected the newer-shaped version outright
  ("Invalid event received"), which has since been fixed
- **Persona system**: 7 built-in scenarios + custom scenarios + import from DG-Market — all locked,
  persisted presets, not a free-text box. The actual `instructions` sent to the model is assembled
  in code (persona + device capabilities + story-to-device mapping + safety rules + live device
  status); users can't edit the safety-rule portion, and the live-status block auto-refreshes and
  gets re-pushed mid-call as devices connect/disconnect or strength changes
- xAI's voice list is fetched live via `GET /v1/tts/voices` when a key is present, falling back to
  a static list on failure
- A settings panel (provider selection, key/model/voice/speed, scenario, permissions, safety caps),
  a call panel (transforms into a centered in-call view with a timer and live captions once
  connected), and a persistent device status bar (shows once connected, live strength meters,
  matching DG-Agent's look)
- Visual parity with DG-Agent (palette, radii, light/dark theme)
- 70 unit tests

**Not done yet**:

- **No complete real-account call has been run end to end yet** — the old `session.update` shape
  was confirmed broken by a real test and has been fixed to the classic format, but the fixed
  version hasn't yet been verified end to end (including an actual tool call) against a real
  account. Anywhere in the code marked `NOT LIVE-VERIFIED` is the next most likely place to need
  adjustment.
- No Android shell yet (the device layer's transport injection is ready; the Android build will
  also be Coyote + Opossum only, no sensors)
- Custom voice upload, a "test connection" button, and a running cost timer are still missing

If you have an API key for one of the supported providers, testing it and reporting back what
breaks is the most useful thing you can do for this project right now.

## Features

- **Multi-provider** — one client works unmodified across xAI/OpenAI/Azure; Zhipu GLM needs no
  server relay at all, signing its JWT locally in the browser
- **Full tool set** — the same 13 device tools as DG-Agent, all called at the model's own
  discretion
- **Safety** — strength caps, cold-start clamp, burst caps, one-time pre-call authorization,
  emergency stop always available
- **Fully local** — no server relay, no database; settings in localStorage, bring your own API key
- **No reinvented wheels** — the device layer comes from `@dg-kit/*` 1.13.0, the same
  implementation shared by all four downstream consumers

## Local development

```bash
git clone https://github.com/0xNullAI/DG-Voice.git
cd DG-Voice
npm install
npm run dev
```

Open http://localhost:5173/. Web Bluetooth requires **Chrome or Edge**.

## Architecture

```
src/
  lib/            Plain TS — device layer, safety chain, realtime client (no React)
  hooks/          React bindings
  components/     UI (ui/ = shadcn primitives copied verbatim from DG-Agent)
  styles/         Design tokens, shared with DG-Agent/DG-Chat
worker/           Cloudflare Worker, pure static-asset hosting
```

See [CLAUDE.md](./CLAUDE.md) for the device-layer and safety-chain breakdown.

## Safety

- Strength range 0-200; cold-start automatically clamps to a low ceiling
- One-time authorization before a call starts — no per-call popups interrupting the "phone call"
  feel, but the hard caps and policy engine stay in effect and the model can't bypass them
- A persistent "hang up and stop" button zeroes everything immediately

## Sister Projects

| Project | Purpose |
|---|---|
| [DG-Kit](https://github.com/0xNullAI/DG-Kit) | Shared TypeScript runtime (consumed by this project) |
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | Browser AI controller (text chat) |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | Multi-user P2P room with remote-control |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP) | MCP server for Claude Desktop and other MCP clients |

## License

[MIT](./LICENSE)
