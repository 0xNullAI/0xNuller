<div align="center">

# DG-Kit

**Shared TypeScript runtime for DG-Lab Coyote 2.0 / 3.0 control surfaces**

[![npm: @dg-kit/core](https://img.shields.io/npm/v/@dg-kit/core?label=%40dg-kit%2Fcore&color=0a84ff)](https://www.npmjs.com/package/@dg-kit/core)
[![npm: @dg-kit/protocol](https://img.shields.io/npm/v/@dg-kit/protocol?label=%40dg-kit%2Fprotocol&color=0a84ff)](https://www.npmjs.com/package/@dg-kit/protocol)
[![npm: @dg-kit/waveforms](https://img.shields.io/npm/v/@dg-kit/waveforms?label=%40dg-kit%2Fwaveforms&color=0a84ff)](https://www.npmjs.com/package/@dg-kit/waveforms)
[![npm: @dg-kit/tools](https://img.shields.io/npm/v/@dg-kit/tools?label=%40dg-kit%2Ftools&color=0a84ff)](https://www.npmjs.com/package/@dg-kit/tools)
[![npm: @dg-kit/transport-webbluetooth](https://img.shields.io/npm/v/@dg-kit/transport-webbluetooth?label=%40dg-kit%2Ftransport-webbluetooth&color=0a84ff)](https://www.npmjs.com/package/@dg-kit/transport-webbluetooth)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![CI](https://github.com/0xNullAI/DG-Kit/actions/workflows/ci.yml/badge.svg)](https://github.com/0xNullAI/DG-Kit/actions/workflows/ci.yml)

[中文](./README.md) | English

</div>

## What it is

DG-Kit is the shared core consumed by [DG-Agent](https://github.com/0xNullAI/DG-Agent), [DG-Chat](https://github.com/0xNullAI/DG-Chat), and [DG-MCP](https://github.com/0xNullAI/DG-MCP). Everything that runs in both the browser and Node.js — BLE protocol, waveform data, LLM tool definitions — lives here on npm; each downstream project only ships what's truly its own (UI shell, MCP server, P2P room).

In short: **one protocol implementation, three products**. Fix once, every project benefits.

## The five packages

| Package | Purpose |
|---|---|
| **`@dg-kit/core`** | Base types and contract interfaces (`DeviceState` / `DeviceCommand` / `WaveformDefinition` / `DeviceClient` / …) |
| **`@dg-kit/protocol`** | Coyote V2 / V3 BLE protocol adapters, transport-agnostic |
| **`@dg-kit/waveforms`** | Built-ins, `ramp / hold / pulse / silence` design compiler, `.pulse` parser |
| **`@dg-kit/tools`** | LLM tool definitions (`start` / `stop` / `adjust_strength` / `change_wave` / `burst` / `design_wave`) with injectable rate-limit policy |
| **`@dg-kit/transport-webbluetooth`** | Browser-side `DeviceClient` over Web Bluetooth |

## Install

```bash
npm install @dg-kit/core @dg-kit/protocol @dg-kit/waveforms
```

Pick the subset you need. The three downstream projects each consume a different slice.

## Architecture

```
                  @dg-kit/core
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
 @dg-kit/protocol  @dg-kit/waveforms  @dg-kit/tools
        │
        ▼
 @dg-kit/transport-webbluetooth        (other transports e.g. noble — see DG-MCP)
```

The protocol layer only depends on an abstract `BluetoothRemoteGATTCharacteristicLike` interface. Browsers plug in `@dg-kit/transport-webbluetooth`; Node uses the noble shim inside [DG-MCP](https://github.com/0xNullAI/DG-MCP). Same V2/V3 code path either way.

## Development

```bash
npm install
npm run build
npm run typecheck
npm run test
```

26 unit tests cover protocol frame packing, waveform compilation, `.pulse` parsing, and rate-limit policy.

## Releasing

Automated via [changesets](https://github.com/changesets/changesets):

1. Make code changes → `npx changeset` to write release notes
2. PR merged to `main` → bot opens a "Version Packages" PR
3. Merging that PR → CI runs `npm publish`

All five packages share a single version (pinned via the `fixed` setting).

## Sister projects

| Project | Purpose |
|---|---|
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | Browser AI controller, drives the device with natural language |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | Multi-user P2P room with remote-control of teammates' devices |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP) | Model Context Protocol server for Claude Desktop and other MCP clients |

## License

[MIT](./LICENSE)
