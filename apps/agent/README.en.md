# 0xNuller Agent

[中文](README.md) | English

Text-based AI interaction with device tools. Agent runs inside `0xNuller` and also keeps a
standalone build.

- Unified site: <https://0xnullai.com/agent>
- Legacy standalone site: <https://agent.0xnullai.com>

## Features

- OpenAI, Anthropic, and OpenAI-compatible model services.
- Strength, waveform, timer, waveform-design, and stop tools.
- Shared scenes with Voice and shared device/safety state with the other modules.
- Browser storage for conversations, scenes, and waveforms, with supported account sync.
- Web Bluetooth in browsers and native BLE in the Android shell.

The model submits tool requests; the execution layer applies permissions, safety policy, and the
command queue. Stopping output never depends on a model response.

## Develop

From the repository root:

```bash
npm install
npm run dev -w @dg-agent/web
npm run dev -w @0xnullai/web
npm run typecheck -w @dg-agent/web
npm run build -w @dg-agent/web
npm test
```

## Layout

```text
apps/agent/                         standalone frontend
apps/agent/src/components/SessionNavigation.tsx
                                    mobile, desktop, and unified-shell session navigation views
packages/agent/runtime/             agent loop and tool scheduling
packages/agent/client/              conversation client
packages/agent/providers-*/         model adapters
packages/agent/storage-browser/     browser persistence
packages/agent/waveforms/           waveform capabilities
apps/web/src/modules/agent.tsx      unified-shell entry
```

`App.tsx` retains session lifecycle, permission, and stop ordering. `SessionNavigation` only
projects the session actions supplied by the entry into a mobile drawer, standalone desktop
sidebar, or unified-shell list; it does not execute runtime tools or device operations.

## License

[MIT](../../LICENSE)
