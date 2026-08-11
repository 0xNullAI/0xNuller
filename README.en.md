<div align="center">

# 0xNuller

**A unified control platform for DG-Lab devices**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/npm-%40dg--kit%2F*-cb3837)](https://www.npmjs.com/org/dg-kit)
[![Demo](https://img.shields.io/badge/demo-online-success)](https://0xnullai.com)

[中文](./README.md) | English

</div>

## Overview

0xNuller brings device control, AI chat, realtime voice, multiplayer interaction, games, and community content into one web and Android application.

| Module         | Purpose                               |
| -------------- | ------------------------------------- |
| **Control**    | Manual device control                 |
| **Agent**      | Text interaction with AI              |
| **Voice**      | Realtime voice interaction            |
| **Chat**       | Rooms, direct messages, and sharing   |
| **Playground** | Game interactions                     |
| **Market**     | Browse and share scenes and waveforms |

New users should begin with Control and review the device safety limits before use.

## Getting started

```bash
git clone https://github.com/0xNullAI/0xNuller.git
cd 0xNuller
npm install
npm run build:kit
npm run dev -w @0xnullai/web
```

Web Bluetooth requires Chrome or Edge.

## Common commands

```bash
npm run build:kit
npm run build
npm run typecheck
npm run test
npm run lint
npm run format
```

## Development entry points

- [`apps/web`](./apps/web/README.en.md) — unified web app and documentation
- [`apps/control`](./apps/control/README.en.md) — direct device control
- [`apps/agent`](./apps/agent/README.en.md) — text Agent
- [`apps/chat`](./apps/chat/README.en.md) — rooms and direct messages
- [`apps/voice`](./apps/voice/README.en.md) — realtime voice
- [`apps/playground`](./apps/playground/README.en.md) — games
- [`apps/market`](./apps/market/README.en.md) — community scenes and waveforms
- [`android/app`](./android/app/README.md) — Android app
- [`apps/mcp`](./apps/mcp/README.en.md) — MCP server (migration/release pending approval)
- `packages` — shared packages
- [`workers`](./workers/README.md) — backend services

Maintainer documentation is available under [`docs`](./docs). The complete pre-merge project README
snapshots are indexed in [`docs/legacy`](./docs/legacy/README.md).

The compatibility release replaces only the `0xnullai.com` root site. Legacy subdomains remain
online. DG-Kit and DG-MCP migration/public release require separate approval.

## Acknowledgements

- [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE)
- [openclaw-plugin-dg-lab](https://github.com/FengYing1314/openclaw-plugin-dg-lab)
- [sse-dg-lab](https://github.com/admilkjs/sse-dg-lab)

## License

[MIT](./LICENSE)
