# 0xNuller repository guide

This file is the root instruction set for maintainers and coding agents. A nested `AGENTS.md`
may add stricter rules for its subtree, but must not weaken these safety and verification rules.

## Product and repository shape

0xNuller is one product monorepo. Keep one implementation of device semantics and adapt it at
the edges instead of growing independent Chat, Voice, Agent, Control, Web, and Android versions.

- `apps/*`: user-facing feature modules and deployable applications.
- `android/app`: Tauri Android shell. It composes web modules; it does not own device semantics.
- `packages/kit/*`: runtime-neutral DG-Lab types, protocol, safety, tools, waveforms, and transports.
- `packages/agent/*`: model/runtime/provider/storage composition for Agent features.
- `packages/platform/*`: product-wide browser services and shared UI/data clients.
- `workers/*` and `apps/*/worker`: independently deployed Cloudflare backends.
- `scripts/*`: repository, release, and verification tooling.
- `docs/*`: maintained design and operations documentation; `docs/legacy/*` is read-only history.

The intended dependency direction is:

`shells -> feature apps -> platform/agent packages -> kit packages`

Do not import from another app to reuse business logic. The only exceptions are compositor shells
(`apps/web` and `android/app`); move reusable behavior into the narrowest appropriate package.

## Where new code belongs

- Device contracts, modality rules, queue primitives, and safety-neutral types: `packages/kit/core`.
- BLE bytes and device-specific behavior: `packages/kit/protocol`.
- Browser/Tauri transport differences: the matching `packages/kit/transport-*` package.
- Permission and safety decisions: `packages/kit/safety` or `packages/platform/permissions`.
- Shared product persistence, Market, scenes, settings, and reusable UI: `packages/platform/*`.
- LLM tool execution and runtime state: `packages/agent/runtime`; browser wiring belongs in
  `packages/agent/agent-browser`.
- Rendering and interaction state that exists only in one surface: that app's `src` directory.

Keep public package entrypoints as barrels, not implementations. A new cohesive behavior gets a
named source file and is re-exported from `index.ts`.

## Device feature invariants

- Coyote consumes `electrostimulation`; Opossum consumes `vibration`. Legacy untyped waveforms are
  electrostimulation. Use shared modality helpers rather than repeating this rule.
- Playback queue, mode, interval, active channel, and cursor are isolated per connected device.
  Only waveform definitions are shared by modality.
- A device feature is incomplete until Control, Chat, Voice/Agent tooling, Web Bluetooth, and Tauri
  Android callers have either adopted it or explicitly documented why it does not apply.
- Every stop, disconnect, background, and error path must preserve emergency-stop behavior.
- Never weaken limits or permission prompts merely to make a test or demo pass.

## Tests

- Put unit and component tests beside the source as `name.test.ts(x)`. Use a local `__tests__`
  directory only for cross-file app composition tests.
- Every bug fix needs a regression test that fails for the old behavior. Test observable contracts,
  not implementation trivia.
- Protocol and transport changes require byte/adapter tests. Cross-surface device changes require at
  least one shared-domain test and focused consumer tests.
- Tests must be deterministic: fake time, storage, BLE, network, and randomness at the boundary.
- Use `npm test` for changed-file feedback, `npm run test:module -- <name>` after completing a
  feature slice, and `npm run test:full` before handoff. Never silence or exclude a failing test.
- `npm run check:structure` verifies that every test file is collected by the root Vitest config.

## Growth control

- File size is a review signal, not a hard CI limit. Split a module when it owns unrelated behavior,
  has unclear boundaries, or becomes difficult to test and navigate—not merely because it crosses an
  arbitrary line count.
- Prefer cohesive modules with explicit names and narrow public APIs. A longer cohesive protocol or
  orchestration module can be clearer than several artificial fragments.
- React components render; hooks coordinate UI state; pure state transitions and domain decisions
  belong in plain TypeScript modules.
- Avoid generic `utils.ts`, `helpers.ts`, or `common.ts`. Name modules after the owned behavior.
- Remove dead compatibility code when its migration is complete. Do not add a second abstraction
  beside an old one without a deletion plan.

## Generated and historical files

Do not hand-edit `dist`, `target`, `src-tauri/gen`, `.astro`, `.wrangler`, build-info files, or
`docs/legacy`. Generated output is not source and should not be added merely because a local build
changed it.

## Verification

Run the narrowest relevant tests while iterating, then before handoff run:

```bash
npm run check:structure
npm run lint
npm run typecheck
npm run test:full
npm run build
```

For visual or device changes, also smoke-test the affected Web surface and Android build/device.
Do not publish a release from an unverified dirty worktree.

## Versioning and release

- `dev` is integration-only. `main` is the sole production publishing branch for npm, Cloudflare,
  and signed product artifacts.
- Product releases use merge commits from `dev -> main`, tagged `vX.Y.Z`, with one GitHub Release
  and an APK named `0xnuller-vX.Y.Z.apk`. Never squash or rebase a product release PR.
- Kit Version PRs may update package versions on `dev`, but Kit packages publish only after the
  promoted main commit passes CI. Kit publication never creates a product GitHub Release.
- Public changes to `packages/kit/*` or `apps/mcp` need an appropriate changeset.
- Never publish, deploy, rewrite history, or delete user work unless the user explicitly requests it.

See `docs/architecture.md`, `docs/testing.md`, and `docs/platform-release.md` for maintained details.
