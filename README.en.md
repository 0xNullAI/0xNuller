<div align="center">

# 0xNullAI

**A unified control platform for DG-Lab devices**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/npm-%40dg--kit%2F*-cb3837)](https://www.npmjs.com/org/dg-kit)
[![Demo](https://img.shields.io/badge/demo-online-success)](https://0xnullai.com)

[中文](./README.md) | English

</div>

## Overview

0xNullAI brings device control, AI chat, realtime voice, multiplayer interaction, games, and community content into one web and Android application.

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

- `apps/web` — unified web app
- `android/app` — Android app
- `packages` — shared packages
- `workers` — backend services

Maintainer documentation is available under [`docs`](./docs).

## Acknowledgements

- [DG-LAB-OPENSOURCE](https://github.com/DG-LAB-OPENSOURCE/DG-LAB-OPENSOURCE)
- [openclaw-plugin-dg-lab](https://github.com/FengYing1314/openclaw-plugin-dg-lab)
- [sse-dg-lab](https://github.com/admilkjs/sse-dg-lab)

## License

[MIT](./LICENSE)
