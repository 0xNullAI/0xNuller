# 0xNuller repository guide

This is the root instruction set for maintainers and coding agents. A nested `AGENTS.md` may add
stricter rules for its subtree, but must not weaken these safety, architecture, or verification rules.
`docs/legacy` is historical context, never the current source of truth.

## Start here

Before changing code:

1. Run `git status --short --branch`. Preserve existing work; do not reset, clean, overwrite, switch
   branches, or rewrite history without explicit permission.
2. Read the nearest `AGENTS.md`, the target package README and `package.json`, adjacent tests, and
   the direct callers. Search before assuming an API or path exists.
3. Classify the task as Repository, Product, DG-Kit, or DG-MCP. Identify whether it changes device
   output, safety, a public API, persistence, permissions, or release behavior.
4. Find the true source of the behavior and its consumers. Fix the narrowest shared layer rather than
   patching several surfaces independently.
5. In a fresh checkout use `npm ci`. DG-Kit is dist-first, so build it before downstream builds or
   type checks when the command does not already do so.

Runtime requirements are declared in the root `package.json`. Use the repository's npm version and
lockfile; do not substitute another package manager.

## Repository and release shape

One monorepo contains three independently versioned deliverables:

- **0xNuller Product**: Web, Workers, and signed Android APK. Its version comes from the root product
  metadata and is delivered through Cloudflare plus one `vX.Y.Z` GitHub Release.
- **DG-Kit**: seven public `@dg-kit/*` npm packages in one fixed Changesets version group.
- **DG-MCP**: the independent public `dg-mcp` npm package under `apps/mcp`.

The dependency direction is:

```text
DG-Kit -> Product
DG-Kit -> DG-MCP
```

Product does not depend on DG-MCP. A Kit change affects all three CI domains for compatibility, but
does not automatically require all three versions to change.

Repository layout:

- `apps/*`: user-facing feature modules and deployable applications; `apps/mcp` is the MCP package.
- `android/app`: Tauri Android shell. It composes product modules and does not own device semantics.
- `packages/kit/*`: runtime-neutral types, protocol, safety, tools, waveforms, and transports.
- `packages/agent/*`: model/runtime/provider/storage composition for Agent features.
- `packages/platform/*`: product-wide browser services and shared UI/data clients.
- `workers/*`, `apps/*/worker`, and `apps/*/src/worker`: independently deployed Cloudflare backends.
- `scripts/*`: repository, release, and verification tooling.
- `docs/*`: maintained design and operations documentation.

The intended product dependency direction is:

```text
shells -> feature apps -> platform/agent packages -> kit packages
```

Do not import another app to reuse business logic. The compositor shells (`apps/web` and
`android/app`) are the only exceptions. Move reusable behavior into the narrowest appropriate
package.

## Task workflow

Use this loop for implementation work:

1. **Understand**: reproduce the issue or state the observable contract. Trace the source, adapters,
   and consumers before designing a fix.
2. **Plan**: choose the smallest complete slice. Note safety failure modes, compatibility impact,
   tests, documentation, and changeset requirements.
3. **Implement**: keep the diff focused and readable. Do not combine unrelated cleanup with the task.
4. **Test**: bug fixes and observable behavior changes need a regression test that fails on the old
   behavior. Run narrow tests first, then the affected responsibility domains.
5. **Review**: inspect `git diff --check`, the full diff, generated-file noise, public exports,
   dependency ranges, and `git status`.
6. **Handoff**: report what changed, commands actually run, checks not run, safety/device validation,
   changeset status, and remaining risks.

Make reasonable local decisions autonomously. Ask before changing a public contract, safety policy,
production migration, release architecture, or dependency with material operational trade-offs.
Never hide a failure, fabricate device validation, or weaken a check to make work appear complete.

## Where code belongs

- Runtime-neutral contracts and safety-free state primitives: `packages/kit/core`.
- BLE bytes, bit packing, and device-specific protocol behavior: `packages/kit/protocol`.
- Strength policies, command serialization, emergency-stop preemption, leases, and lifecycle guards:
  `packages/kit/safety`.
- Browser/Tauri transport differences: the matching `packages/kit/transport-*` package.
- Shared waveform and tool semantics: `packages/kit/waveforms` and `packages/kit/tools`.
- Product permissions and browser-wide services: `packages/platform/*`.
- Shared DG-Lab product sessions, React device hooks, and channel rotation:
  `packages/platform/device-runtime`; feature apps may consume or compatibility-re-export them, but
  must not import another app's implementation.
- Shared waveform import/library hooks belong in `packages/platform/waveforms`; reusable device
  controls such as press-and-hold repeat belong in `packages/platform/ui`.
- LLM execution and Agent state: `packages/agent/runtime`; browser wiring belongs in
  `packages/agent/agent-browser`.
- Rendering and interaction state used by only one surface: that app's `src` directory.
- Node BLE and MCP-specific orchestration: `apps/mcp`.

Keep public package entrypoints as barrels, not implementations. A cohesive behavior gets a named
source file and is re-exported from `index.ts`. Avoid generic `utils.ts`, `helpers.ts`, and
`common.ts` modules.

## Device and safety invariants

Output strength, duration, permission grants, remote-command clamping, queues, leases, and lifecycle
stops are safety-critical. If the task does not clearly authorize such a change, stop and ask.

- Coyote consumes `electrostimulation`; Opossum consumes `vibration`. Legacy untyped waveforms are
  electrostimulation. Use shared modality helpers rather than duplicating this rule.
- Playback queue, mode, interval, active channel, and cursor are isolated per connected device. Only
  waveform definitions are shared by modality.
- AI, rooms, games, Workers, remote peers, and synchronized data are untrusted inputs. Revalidate and
  clamp commands on the device owner's side.
- Start, increase, resume, and extend operations fail closed. Stop and emergency stop must remain
  reachable and must not be blocked by normal permissions, queues, or failed state.
- Emergency stop preempts ordinary work and invalidates stale queued work. Disconnect, background,
  lease loss, module changes, and error paths must preserve stop behavior.
- Never weaken limits or permission prompts merely to make a test or demo pass.
- A device feature is incomplete until Control, Chat, Voice/Agent tooling, Web Bluetooth, and Tauri
  Android have adopted it or explicitly documented why it does not apply.
- Do not connect hardware, send BLE/MCP device commands, access production rooms/accounts, or claim
  real-device validation without explicit permission and human supervision.

## Tests and commands

Put unit/component tests beside source as `name.test.ts(x)`. Use a local `__tests__` directory only for
cross-file composition tests. Test observable contracts, not private implementation trivia.

- Protocol and transport changes require byte-level or adapter tests.
- Cross-surface device changes need shared-domain tests plus focused consumer tests.
- Tests must be deterministic; fake time, storage, BLE, network, and randomness at the boundary.
- Never silence, exclude, or add `|| true` around a failing test.

Use the narrowest useful command while iterating:

| Tier              | Commands                                | Required use                     |
| ----------------- | --------------------------------------- | -------------------------------- |
| Local fast        | `npm test` or `npm run test:fast`       | Editing loop only                |
| One module        | `npm run test:module -- <name>`         | Completed feature slice          |
| PR affected       | `npm run test:affected -- --base=<ref>` | Before submitting a focused PR   |
| Main/handoff full | `npm run test:full`                     | Substantial changes and releases |

Affected selection must follow workspace reverse dependencies. A shared Kit/platform change expands
to its consumers; unknown runtime files and global test configuration fail safe to the full applicable
suite. Never exclude safety, authorization, lease, lifecycle-stop, or emergency-stop coverage to make
a test tier faster. CI may prepare DG-Kit once and use a `:prepared` command, but must not skip the
corresponding tests. See `docs/testing.md` for responsibility-domain and CI commands.

A Kit behavior change requires Kit, Product, and MCP compatibility coverage. Before handoff of a
substantial change, run:

```bash
npm run check:structure
npm run lint
npm run typecheck
npm run test:full
npm run build
```

For visual, Android-native, lifecycle, BLE, or device changes, also report the relevant manual check.
If it could not be run, say so explicitly.

## Growth and generated files

- File size is a review signal, not a hard limit. Split when a module owns unrelated behavior or is
  difficult to understand and test, not at an arbitrary line count.
- React components render; hooks coordinate UI state; pure transitions and domain decisions belong
  in plain TypeScript modules.
- Prefer narrow APIs and delete completed compatibility paths. Do not add a parallel abstraction
  without a migration and deletion plan.
- Do not hand-edit or commit `dist`, `target`, `src-tauri/gen`, `.astro`, `.wrangler`, build-info,
  caches, or other generated output.
- Do not edit `docs/legacy` as part of current product work.

## Changesets and releases

Feature branches start from `dev` and merge back to `dev`. `main` is the sole production source and
accepts only maintainer-controlled `dev -> main` release PRs.

- Public behavior/API/dependency changes under `packages/kit/*` need a changeset for the directly
  affected Kit package. The fixed group will version all seven Kit packages together.
- Public behavior/API/dependency changes under `apps/mcp` need a `dg-mcp` changeset.
- If one change introduces a Kit API/fix and makes MCP consume it, add changesets for both release
  lines. If MCP adopts an already-versioned Kit change, only MCP needs a new changeset. In either
  case, update MCP's minimum Kit ranges; Kit must be available on npm before MCP publication.
- Product versions are prepared separately and must keep root, Android, Tauri, Cargo, lockfile,
  versionCode, and release notes synchronized.
- Contributors add `.changeset/*.md`; they do not hand-edit generated npm versions or changelogs.

Unless the user explicitly requests a release operation, do not run `npm run version`, merge a PR,
trigger a workflow, deploy, publish npm, create a tag/Release, push remote changes, or alter production.
Never squash or rebase a `dev -> main` product release PR. See `CONTRIBUTING.md` and
`docs/platform-release.md` for the exact maintainer sequence.

## Handoff checklist

A final report must state:

- the behavior changed and why it belongs in that layer;
- safety failure modes and stop paths, when applicable;
- tests/builds/format/lint commands actually run and their results;
- hardware, Android, visual, or production checks not run;
- public API, dependency, documentation, and changeset impact;
- remaining risks or follow-up work;
- whether pre-existing user changes were preserved.
