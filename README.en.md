<div align="center">

# 0xNuller

**A unified control platform for DG-Lab devices**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit/core](https://img.shields.io/npm/v/%40dg-kit%2Fcore?label=%40dg-kit%2Fcore&color=cb3837)](https://www.npmjs.com/package/@dg-kit/core)
[![dg-mcp](https://img.shields.io/npm/v/dg-mcp?label=dg-mcp&color=cb3837)](https://www.npmjs.com/package/dg-mcp)
[![Demo](https://img.shields.io/badge/demo-online-success)](https://0xnullai.com)

[中文](./README.md) | English

</div>

## Overview

0xNuller brings device control, AI chat, realtime voice, multiplayer interaction, games, and community content into one web and Android application.

| Module         | Purpose                               |
| -------------- | ------------------------------------- |
| **Control**    | Manual device control                 |
| **Chat**       | Rooms, direct messages, and sharing   |
| **Agent**      | Text interaction with AI              |
| **Voice**      | Realtime voice interaction            |
| **Video**      | Camera-based visual control           |
| **Market**     | Browse and share scenes and waveforms |
| **Playground** | Game interactions                     |

New users should begin with Control and review the device safety limits before use.

## Packages and MCP

- **DG-Kit** is a TypeScript package family for building device connections, protocol handling,
  safety limits, tools, and waveforms. See the [DG-Kit guide](./packages/kit/README.md) and
  [packages on npm](https://www.npmjs.com/package/@dg-kit/core).
- **DG-MCP** exposes DG-Lab device tools to MCP-compatible desktop clients. See the
  [installation and configuration guide](./apps/mcp/README.en.md), or run `npx dg-mcp`.

Both follow the same Changesets release policy: changes include a changeset, `dev` prepares the
version PR, and packages are built, verified, and published together from the `npm-production`
environment after that PR reaches `main`.

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
npm test          # tests affected by the current branch
npm run test:full # complete suite for CI/handoff
npm run lint
npm run check:structure
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
- [`apps/mcp`](./apps/mcp/README.en.md) — MCP server published as [`dg-mcp`](https://www.npmjs.com/package/dg-mcp)
- [`packages/kit`](./packages/kit/README.md) — public DG-Kit packages and standalone usage guide
- [`workers`](./workers/README.md) — backend services

Maintainer documentation is available under [`docs`](./docs).
Repository boundaries and test conventions are maintained in [`AGENTS.md`](./AGENTS.md),
[`docs/architecture.md`](./docs/architecture.md), and [`docs/testing.md`](./docs/testing.md).

The current product runs on `0xnullai.com`; retired standalone subdomains are no longer served.
DG-Kit and DG-MCP now live in this repository and are published to npm as
[`@dg-kit/*`](https://www.npmjs.com/package/@dg-kit/core) and
[`dg-mcp`](https://www.npmjs.com/package/dg-mcp).

## Acknowledgements

- [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE)
- [openclaw-plugin-dg-lab](https://github.com/FengYing1314/openclaw-plugin-dg-lab)
- [sse-dg-lab](https://github.com/admilkjs/sse-dg-lab)

## License

[MIT](./LICENSE)
