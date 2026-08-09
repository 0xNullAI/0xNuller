<div align="center">

# 0xNullAI

**A unified AI control platform for DG-Lab Coyote devices**

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)
[![@dg-kit](https://img.shields.io/badge/npm-%40dg--kit%2F*-cb3837)](https://www.npmjs.com/org/dg-kit)
[![Demo](https://img.shields.io/badge/demo-online-success)](https://0xnullai.com)

[中文](./README.md) | English

</div>

## What this is

0xNullAI folds what used to be nine separate repositories into one platform:
six modules sharing a single device protocol, a single safety chain, one
design system, one waveform library and one account, running inside the same
shell and packaged as a single Android app.

The device it drives is a DG-Lab Coyote — hardware that puts **electrical
current through a human body**. That fact shapes most of the engineering
decisions below, and it is the reason the safety chain has exactly one
implementation rather than one per module.

## Modules

Listed in the order they are meant to be discovered: the first needs no
account, no room and no model key; the last is where you go once you already
know what you want.

| Module         | What it does                                                                           |
| -------------- | -------------------------------------------------------------------------------------- |
| **Control**    | Drive your own device directly. Connect and go — nothing else required                 |
| **Agent**      | Talk to an AI in plain language; it controls the device through tool calls             |
| **Voice**      | Stay on a call with an AI that decides for itself when to speak and when to act        |
| **Chat**       | Groups and direct messages — hand control of your device to the person you are with    |
| **Playground** | Games wired to the device. A game may only request feedback; your caps decide the rest |
| **Market**     | A community library of waveforms and scenes, one click into the other modules          |

The shared layer, [`@dg-kit/*`](https://www.npmjs.com/org/dg-kit), is published
to npm for the MCP server and for outside projects.

## Getting started

```bash
git clone https://github.com/0xNullAI/0xNuller.git
cd 0xNuller
npm install
npm run build:kit             # the shared layer is dist-first; everything else needs it built
npm run dev -w @0xnullai/web  # the shell — all six modules live inside it
```

The shell is the only entry point; modules no longer run standalone.

Web Bluetooth requires **Chrome or Edge**.

## Safety

Three constraints hold everywhere, and a change that weakens any of them is a
bug regardless of what else it improves:

1. **Stop is always one action away.** No UI change may put anything between
   the user and stopping every attached device.
2. **Caps are enforced on the side that holds the device.** A number arriving
   from a room, an AI, or game logic is never trusted.
3. **Safety logic has no second copy.** Voice once carried a verbatim clone of
   Agent's safety chain. There is now exactly one, in `@dg-kit/safety`; code
   that needs it depends on the package rather than copying it.

## Repository layout

```
packages/
  kit/        @dg-kit/*, published to npm
              safety/ is the single source of truth for the device safety chain
  platform/   @0xnullai/*, shared across modules, not published
  agent/      @dg-agent/*, Agent-only
apps/
  web/        the shell — the only entry point
  control/ agent/ voice/ chat/ playground/ market/
  landing/ wiki/ mcp/
android/app/  one Tauri shell, six modules, one APK
workers/      auth · llm-proxy (the free provider) · speech-proxy
```

`packages/*/*` is two levels deep for two reasons: it lets same-named packages
like `@dg-kit/core` and `@dg-agent/core` coexist, and it makes "published",
"shared" and "module-only" visible from the path alone.

## Commands

```bash
npm run build:kit    # the shared layer only (prerequisite for everything else)
npm run build        # the whole repo
npm run typecheck
npm run test         # vitest, single process, whole repo
npm run lint         # zero-error policy
```

## License

MIT. See [LICENSE](./LICENSE).

This software controls hardware that delivers electrical stimulation. Use it
on yourself at your own risk, obey the law where you live, and do not use it
on anyone who has not agreed to it.
