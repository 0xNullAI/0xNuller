<div align="center">

# DG-MCP

**Drive a DG-Lab Coyote 2.0 / 3.0 from Claude Desktop and other MCP clients**

[![npm](https://img.shields.io/npm/v/dg-mcp?color=0a84ff)](https://www.npmjs.com/package/dg-mcp)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/built%20on-%40dg--kit%2F*-0a84ff)](https://github.com/0xNullAI/DG-Kit)
[![Site](https://img.shields.io/badge/site-0xnullai.com-58c8f2)](https://0xnullai.com)

[中文](./README.md) | English

</div>

## What it is

DG-MCP exposes a Coyote device as a set of [Model Context Protocol](https://modelcontextprotocol.io) tools so any MCP-compatible LLM client (Claude Desktop, Continue, etc.) can drive it over Bluetooth — `scan`, `connect`, `start`, `stop`, `adjust_strength`, `change_wave`, `burst`, `design_wave`, `emergency_stop`, and more, all surfaced as ordinary tool calls.

Runs in Node.js, talks to the client over stdio. Built on [`@dg-kit/*`](https://github.com/0xNullAI/DG-Kit), so it shares its protocol implementation with DG-Agent and DG-Chat.

## Status

- `1.0.0` stable, on npm
- The v0.1.x **Python** implementation is archived on the [`archive/0.x-py`](https://github.com/0xNullAI/DG-MCP/tree/archive/0.x-py) branch and remains installable from PyPI but no longer receives updates

## Quick start

### Install

`npx` works without a global install:

```bash
npx dg-mcp --version
```

Or globally:

```bash
npm install -g dg-mcp
```

### Claude Desktop config

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "dg-lab": {
      "command": "npx",
      "args": ["-y", "dg-mcp"]
    }
  }
}
```

To preload waveform packs:

```json
{
  "mcpServers": {
    "dg-lab": {
      "command": "npx",
      "args": ["-y", "dg-mcp", "--waveforms-dir", "/Users/you/wave-pack"]
    }
  }
}
```

Restart Claude Desktop and ask Claude to "scan for Coyote devices".

## CLI options

```bash
dg-mcp [options]

  --waveforms <path>      Add a .pulse or .zip file at startup (repeatable)
  --waveforms-dir <dir>   Add every .pulse / .zip file in a directory
  --library-dir <dir>     Persist user-imported / AI-designed waveforms here
  --help, -h
  --version, -v

  Environment-variable equivalents:
  DG_MCP_WAVEFORMS        colon-separated list of waveform paths
  DG_MCP_WAVEFORMS_DIR    same as --waveforms-dir
  DG_MCP_LIBRARY_DIR      same as --library-dir
```

## Tools

### Device control (from `@dg-kit/tools`)

| Tool | Purpose |
|---|---|
| `start` | Cold-start a channel: set strength + waveform in one go |
| `stop` | Stop one channel, or both if `channel` omitted |
| `adjust_strength` | Relative change, ±10/step (rate-limited 2× / 5 s) |
| `change_wave` | Swap waveform without touching strength |
| `burst` | Briefly spike to a target strength, auto-restore (1× / 5 s) |
| `design_wave` | Compose a new waveform from `ramp / hold / pulse / silence` segments |

### MCP-only

| Tool | Purpose |
|---|---|
| `scan` | Discover nearby Coyote devices |
| `connect` / `disconnect` | Manage the BLE link |
| `get_status` | Current connection / strength / wave / battery |
| `list_waveforms` | All available waveforms (built-in + imported) |
| `load_waveforms` | Import `.pulse` / `.zip` at runtime |
| `emergency_stop` | Strength → 0, all waves stopped, immediate |

## Safety

- Strength scale is **0-200**. Cold-start tools clamp initial strength to ≤10. Always start low.
- Soft-limits default to 200; tighten via your LLM client's policy layer if needed.
- The device's physical wheel can override strength upward — treat MCP as an _input_, not a hard ceiling.
- "Emergency stop" works any time and triggers immediate cutoff.

## Requirements

- Node.js ≥ 20
- BLE-capable host (macOS, Linux/BlueZ, or Windows with a noble-supported adapter)
- DG-Lab Coyote 2.0 (D-LAB ESTIM…) or 3.0 (47L121…)

### macOS

First run will trigger a Bluetooth permission prompt. Allow it.

### Linux

Noble needs BLE raw-capture permission:

```bash
sudo setcap cap_net_raw+eip $(eval readlink -f $(which node))
```

## Architecture

```
        ┌─────────────────────┐
        │ MCP client          │  Claude Desktop / Continue / ...
        └──────────┬──────────┘
                   │ stdio
        ┌──────────▼──────────┐
        │      dg-mcp         │  this repo
        ├─────────────────────┤
        │  src/server.ts      │  → @dg-kit/tools defs → MCP tool schema
        │  src/coyote-device  │  → DeviceClient, drives @dg-kit/protocol
        │  src/waveform-lib   │  → built-ins + .pulse/.zip + JSON persist
        │  src/noble-shim     │  → noble Characteristic → CharacteristicLike
        └──────────┬──────────┘
                   │ shared
        ┌──────────▼──────────┐
        │     @dg-kit/*       │  core / protocol / tools / waveforms
        └─────────────────────┘
                   │ BLE
        ┌──────────▼──────────┐
        │  Coyote 2.0 / 3.0   │
        └─────────────────────┘
```

## Development

```bash
git clone https://github.com/0xNullAI/DG-MCP.git
cd DG-MCP
npm install
npm run build
npm run dev          # tsx hot reload
```

## Sister projects

| Project | Purpose |
|---|---|
| [DG-Kit](https://github.com/0xNullAI/DG-Kit) | Shared TypeScript runtime (consumed by this project) |
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | Browser AI controller |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | Multi-user P2P room |

## License

[MIT](./LICENSE)
