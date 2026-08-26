# 0xNuller repository guide

This file contains only rules that apply to nearly every change. Read the nearest package README and
the routed document below when a task enters that domain. `docs/legacy` is historical context, never
the current source of truth. A nested `AGENTS.md` may tighten, but not weaken, these rules.

## Before editing

1. Run `git status --short --branch`; preserve all existing work and unrelated changes.
2. Read the target package README, `package.json`, adjacent tests, direct callers, and the relevant
   document from the routing table below.
3. Identify whether the change affects device output, safety, permissions, persistence, public APIs,
   production data, or release behavior.
4. Fix the narrowest shared source of the behavior instead of patching several surfaces separately.
5. Use the repository npm version and lockfile. In a fresh checkout use `npm ci`.

Do not reset, clean, overwrite, switch branches, rewrite history, connect hardware, operate production
accounts, or claim real-device validation unless the user explicitly authorizes it.

## Repository shape

The monorepo ships three independently versioned deliverables:

- Product: Web, Workers, and signed Android APK; versioned from root product metadata.
- DG-Kit: the fixed Changesets group under `packages/kit/*`.
- DG-MCP: the independent `apps/mcp` npm package.

Dependency direction:

```text
shells -> feature apps -> platform/agent packages -> kit packages
DG-Kit -> Product
DG-Kit -> DG-MCP
```

Only `apps/web` and `android/app` may compose feature apps. Other apps must not import one another to
reuse business logic; move shared behavior into the narrowest suitable package.

| Need                              | Read                         |
| --------------------------------- | ---------------------------- |
| Code ownership or dependency move | `docs/architecture.md`       |
| Agent runtime, history, or tools  | `docs/agent-architecture.md` |
| Test placement or command choice  | `docs/testing.md`            |
| Worker/D1/R2/DO deployment        | `docs/deploy.md`             |
| Product release                   | `docs/platform-release.md`   |
| Android release                   | `docs/android-release.md`    |
| Other maintained documentation    | `docs/README.md`             |

Package entrypoints are export barrels, not implementation files. Prefer behavior-named modules over
generic `utils.ts`, `helpers.ts`, or `common.ts` files.

## Shared ownership

- `packages/kit/core`: runtime-neutral contracts and state primitives.
- `packages/kit/protocol`: device bytes and protocol behavior.
- `packages/kit/safety`: limits, permissions, queues, leases, and stop ordering.
- `packages/kit/transport-*`: Web Bluetooth and Tauri transport differences.
- `packages/platform/*`: product-wide settings, services, shared device sessions, and reusable UI.
- `packages/agent/*`: Agent runtime, providers, storage, bridge, and browser composition.
- `apps/*`: feature-specific rendering and orchestration; reusable semantics do not stay here.

State used by one component stays local; state shared across features belongs in a platform or domain
package. React components render, hooks coordinate, and pure domain decisions remain testable without
React. Persistence uses the existing settings/sync/storage boundary, not new direct `localStorage` or
IndexedDB access in feature components.

## Device and AI invariants

Device output, strength, duration, permission, queues, leases, and lifecycle stops are safety-critical.

- Coyote is `electrostimulation`; Opossum and generic vibration devices are `vibration`.
- Device queues and playback state are isolated per physical identity; only waveform definitions are
  shared by modality.
- Treat AI, rooms, games, Workers, remote peers, synchronized data, and device reconnects as untrusted.
  Revalidate identity, permission, lease, policy, and limits at the final owner-side execution boundary.
- Start, increase, resume, and extend fail closed. Stop and emergency stop stay reachable and preempt
  ordinary work, including after permission denial, stale work, disconnect, backgrounding, or errors.
- Never weaken limits, stop paths, or permission prompts to make a demo or test pass.

Generic-device opt-in has one local-only switch under **Settings -> About**. Control, Agent, Voice,
and Video subscribe to the same provider state; feature apps do not add private switches. Disabling it
removes generic UI, model context/tools, and backend startup/scan paths without disabling Video,
Coyote, or Opossum.

Model-visible device data is a positive snapshot of current availability. Instructions, status,
tools, and target IDs include only connected, enabled, healthy capabilities; omit unavailable devices
instead of describing them as disconnected. Agent recomputes this every turn, Voice updates
instructions and tools atomically on topology changes, and Video revalidates its ephemeral target
allowlist before every write.

Multi-target selection never implies fan-out. A model action addresses one exact physical identity and
channel/capability. Stop the previous target before switching; an identity/topology change revokes the
old grant. Human selection alone is not authorization, and execution checks remain mandatory even when
the model schema is narrowed.

## Working and testing

Use this loop: understand -> plan -> implement -> narrow tests -> affected/full tests -> review diff ->
handoff. Bug fixes and observable changes need a regression test that fails on the old behavior.

- Put tests beside source as `name.test.ts(x)`; reserve local `__tests__` for app-level composition.
- Test observable contracts, safety failures, and stop behavior; fake time, storage, BLE, network, and
  randomness at their boundaries.
- Split mixed test files by responsibility without deleting distinct assertions. Test support files
  must not register tests.
- Never silence, exclude, or wrap a failure in `|| true`.

Common commands:

```bash
npm test                              # fast changed-file loop
npm run test:module -- <name>         # completed module slice
npm run test:affected -- --base=<ref> # focused PR boundary
npm run test:full                     # substantial handoff or release
```

Before handing off a substantial change run:

```bash
npm run check:structure
npm run lint
npm run typecheck
npm run test:full
npm run build
```

Also report any visual, Android, lifecycle, BLE, production, or real-device check that was not run.

## Files, releases, and handoff

Do not hand-edit or commit generated `dist`, `target`, `src-tauri/gen`, `.astro`, `.wrangler`, build
info, or caches. Do not update `docs/legacy`. Keep maintained documents reachable from
`docs/README.md` or an owning package README.

Feature branches start from and merge into `dev`; `main` is the production source. Kit and MCP public
behavior changes need their own Changesets. Product versioning is separate. Unless explicitly asked,
do not version, deploy, publish, push, merge, tag, create a Release, or trigger a release workflow.

The final report states: behavior and layer changed, safety/stop implications, commands actually run,
checks not run, API/dependency/docs/changeset impact, remaining risks, and preservation of pre-existing
work. Never hide a failure or fabricate validation.
