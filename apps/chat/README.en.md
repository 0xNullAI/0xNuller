# 0xNuller Chat

[中文](README.md) | English

Account-based rooms, a public lobby, and direct messages backed by Cloudflare Durable Objects.
Chat requires a signed-in account with a verified email. Web and Android obtain a short-lived
admission ticket from Auth, which the room, lobby, and direct-message Worker entry points verify.

- Unified site: <https://0xnullai.com/chat>
- Legacy standalone site: <https://chat.0xnullai.com>

## Features

- Public/private rooms, room codes, QR invites, and a public lobby.
- Text, image, and voice messages with media stored in R2.
- Account contacts and direct messages; the unified Chat requires sign-in and email verification.
- Explicit device sharing, waveforms, strength changes, and temporary fire controls.
- Host settings, room Agent support, and responsive layouts.

Device actions require the holder's authorization and still pass through safety policy on the
holder's device. Revoking access, leaving, switching modules, or stopping output ends control.

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

`src/App.tsx` is Chat's runtime orchestrator for authentication, WebSocket lifecycle, device-owner
validation, permissions, leases, and stop paths. `src/components/ChatAppView.tsx` only composes the
room directory, header status, and chat/control panels; it must not relax or reorder device commands
or stop semantics.

Media uploads require a capability issued by the current WebSocket session. Direct-message tickets
are minted by the account service and verified by Chat.

## Deploy

The new `0xnullai-chat` Worker serves only unified-site routes and runs alongside the legacy
`dg-chat` Worker. See the [deployment guide](../../docs/deploy.md).

## License

[MIT](../../LICENSE)
