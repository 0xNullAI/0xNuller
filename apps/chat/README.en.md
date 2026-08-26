# 0xNuller Chat

[中文](README.md) | English

Account-based rooms, a public lobby, and direct messages backed by Cloudflare Durable Objects.
Members can also grant a room temporary control of shared devices. Chat requires a signed-in account
with a verified email. Web and Android use a short-lived admission ticket from Auth, which the room,
lobby, and direct-message Worker entry points verify again.

- Unified site: <https://0xnullai.com/chat>
- Legacy address (redirects to the unified site): <https://chat.0xnullai.com>

## Features

- Public/private rooms, room codes, QR invites, and a public lobby.
- Text, image, and voice messages with media stored in R2.
- Account contacts and direct messages; the unified Chat requires sign-in and email verification.
- Explicit device sharing, waveforms, strength changes, and temporary fire controls.
- Host settings, room Agent support, and responsive layouts.

## Use Chat

1. Sign in, then open Chat.
2. Create or join a room, or enter the public lobby from the sidebar.
3. After two accounts follow each other, start a direct message from the user's profile.
4. To share a device, connect it from the top bar and explicitly grant access inside the room.

## Device control and safety

Device actions require the holder's authorization. The holder's device revalidates the exact device,
connection, Chat lease, and safety policy before execution. Revoking access, leaving, switching
modules, or stopping output ends control.

Room AI sees currently authorized physical instances. Identical display names still have distinct,
temporary target IDs; one call selects one exact target and never falls back by name, chooses a
primary device, or broadcasts. A topology change invalidates old targets.

## Develop

```bash
npm install
npm run dev -w 0xnullai-chat
npm run cf:dev -w 0xnullai-chat
npm run test -w 0xnullai-chat
npm run build -w 0xnullai-chat
npm run types:check -w 0xnullai-chat
```

## Layout

```text
src/components/       room/member UI; ChatAppView composes room/lobby presentation only
src/hooks/            room, device, and waveform state
src/lib/              WebSocket, media, and client protocol
worker/index.ts       HTTP and WebSocket routing
worker/room-do.ts     room and direct-message state
worker/lobby-do.ts    public lobby
worker/media.ts       R2 media access
```

`src/App.tsx` owns authentication, the WebSocket lifecycle, device-owner validation, leases, and stop
paths. `src/components/ChatAppView.tsx` only composes the interface; it must not change device commands
or stop semantics.

Room and text Agents share provider configuration from `@0xnullai/llm-providers` and the request
factory from `@dg-agent/agent-browser`. Chat continues to own room prompts, @ triggers, bounded tool
loops, and holder-side authorization; these are not local Agent session semantics.

Media uploads require a capability issued by the current WebSocket session. Direct-message tickets
are minted by the account service and verified by Chat.

## Deploy

Chat uses `RoomDO`, `LobbyDO`, and the shared `dg-chat-media` R2 bucket. The legacy domain remains in
place for redirects and browser-data migration; do not remove it with the new Worker. See the
[deployment guide](../../docs/deploy.md) for order, shared storage, and secret requirements.

## License

[MIT](../../LICENSE)
