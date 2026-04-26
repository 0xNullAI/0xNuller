# CLAUDE.md

Guidance for Claude Code working in **DG-Kit** — the shared TypeScript runtime consumed by DG-Agent, DG-Chat, and DG-MCP.

## Project Overview

DG-Kit is a public npm-published monorepo (`@dg-kit/*`). Five packages, all pinned to a single version via changesets. The downstream consumers (`DG-Agent`, `DG-Chat`, `DG-MCP`) reuse this code rather than duplicating it.

When making changes here, the principle is: **breaking the public API is a major bump and forces three downstream PRs**. Prefer additive changes; reserve breaking changes for genuine architectural fixes.

## Repo Layout

```
packages/
  core/                      @dg-kit/core
  protocol/                  @dg-kit/protocol         (deps: core)
  waveforms/                 @dg-kit/waveforms        (deps: core)
  tools/                     @dg-kit/tools            (deps: core, waveforms)
  transport-webbluetooth/    @dg-kit/transport-webbluetooth (deps: core, protocol)
.changeset/                  changesets release notes
.github/workflows/           ci.yml + release.yml
```

Build is **dist-first**: each package's `package.json` `main`/`types`/`exports` point to `dist/`. `pretypecheck` and `pretest` automatically build. Don't switch back to `src` paths — that pattern broke 0.1.0 publishing.

## Branch & PR Convention

- Default branch: `main`
- Develop on feature branches → PR to `main`
- Add a `.changeset/<name>.md` for any user-visible change
- After merge, the changesets bot opens a "Version Packages" PR that bumps versions and writes per-package CHANGELOGs. Merging that PR triggers `npm publish` via `.github/workflows/release.yml`

## Commands

```bash
npm install
npm run build       # tsc per package, in topological order
npm run typecheck   # auto-runs build first
npm run test        # vitest, auto-runs build first
npm run lint
npm run lint:fix
npm run format      # prettier
npm run format:check
npm run clean       # remove all dist + tsbuildinfo
npm run changeset   # interactive: write a release note
npm run release     # build + changeset publish (CI calls this)
```

## Test & Commit Workflow

Before every commit:

1. `npm run lint` — zero warnings policy
2. `npm run typecheck` — clean
3. `npm run test` — all tests pass (currently 26)
4. `npm run build` — `dist/` artifacts produced

Commit message style — conventional commits:

```
type(scope): short imperative subject

Optional body explaining the WHY. Wraps at 72 chars.
```

`type` ∈ `feat | fix | refactor | docs | chore | test | perf | style`. `scope` is usually a package name (`core`, `protocol`, `waveforms`, `tools`, `transport-webbluetooth`) or a cross-cutting concern (`build`, `release`).

PR description template:

```
## Summary
1-2 sentences: what changed and why.

## Test plan
- [x] npm run typecheck
- [x] npm run test
- [x] npm run build
- [x] npm run lint
```

Squash-merge into `main`. The squashed commit subject becomes the changelog line.

## Architecture Notes

- **Protocol layer is transport-agnostic**: `@dg-kit/protocol` operates on the abstract `BluetoothRemoteGATTCharacteristicLike` interface. Browsers use `@dg-kit/transport-webbluetooth`; Node uses the `noble-shim.ts` inside DG-MCP. Adding a new transport means writing the shim, not touching protocol code.
- **Frame grid is 25 ms**: every `WaveFrame` represents 25 ms. V3 packs four frames per 100 ms write; V2 consumes one frame per 100 ms tick (with precision loss). Don't change the grid without coordinating with both consumers.
- **Tool definitions are runtime-injectable**: `createDefaultToolRegistry({ rateLimitPolicy })` accepts a `RateLimitPolicy`. DG-Agent injects `createTurnRateLimitPolicy()`; DG-MCP injects `createSlidingWindowRateLimitPolicy()`. Don't bake either policy into the registry itself.

## Sister Projects

| Project | Purpose |
|---|---|
| [DG-Agent](https://github.com/0xNullAI/DG-Agent) | Browser AI controller |
| [DG-Chat](https://github.com/0xNullAI/DG-Chat) | Multi-user P2P room with remote-control |
| [DG-MCP](https://github.com/0xNullAI/DG-MCP) | MCP server for Claude Desktop and other MCP clients |

The four repos share a common testing / commit / PR convention; see each project's CLAUDE.md for project-specific notes.

## Code Conventions

- TypeScript with `strict: true`, `noUncheckedIndexedAccess: true`, `verbatimModuleSyntax: true`
- ESM only (`"type": "module"`)
- `import type` for type-only imports
- Unused vars must be prefixed `_`
- No emojis in code or comments unless explicitly requested
- Comments explain WHY, not WHAT (well-named identifiers cover the WHAT)
