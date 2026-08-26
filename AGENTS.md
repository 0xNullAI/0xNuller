# 0xNuller repository guide

These are the repository-wide rules. Read the nearest package README and the routed document before
working in a domain. `docs/legacy` is historical only. Nested `AGENTS.md` files may tighten these rules.

## Start

1. Run `git status --short --branch`; preserve existing and unrelated work.
2. Read the target README, `package.json`, adjacent tests, direct callers, and routed documentation.
3. Identify device, safety, permission, persistence, API, production-data, and release impact.
4. Fix the narrowest shared owner instead of duplicating behavior across apps.
5. Use the repository npm version and lockfile; use `npm ci` in a fresh checkout.

Do not reset, clean, overwrite, switch branches, rewrite history, operate hardware or production, or
claim real-device validation without explicit authorization.

## Architecture

```text
shells -> feature apps -> platform/agent packages -> kit packages
DG-Kit -> Product
DG-Kit -> DG-MCP
```

Only `apps/web` and `android/app` compose feature apps. Other apps do not import one another for reuse;
move shared behavior into the narrowest package. React renders, hooks coordinate, and domain decisions
stay testable without React. Use existing settings/sync/storage boundaries, not direct feature-level
browser storage. Package entrypoints are export barrels; prefer behavior-named modules over generic
`utils`, `helpers`, or `common` files.

| Work                        | Read                                                  |
| --------------------------- | ----------------------------------------------------- |
| Ownership and dependencies  | `docs/architecture.md`                                |
| Agent history and tools     | `docs/agent-architecture.md`                          |
| Tests                       | `docs/testing.md`                                     |
| Workers and production data | `docs/deploy.md`                                      |
| Product/Android releases    | `docs/platform-release.md`, `docs/android-release.md` |
| Documentation index         | `docs/README.md`                                      |

## Device and AI safety

- Coyote is electrostimulation; Opossum and generic vibration devices are vibration.
- Isolate queues and playback state per physical identity; share only modality-compatible definitions.
- Treat AI, rooms, peers, Workers, synchronized data, and reconnects as untrusted. Revalidate exact
  identity, connection, permission, lease, policy, and limits at the final owner-side execution boundary.
- Start, increase, resume, and extend fail closed. Stop and emergency stop preempt ordinary work and
  remain reachable after denial, stale work, disconnect, backgrounding, or errors.
- Never weaken limits, stop paths, or consent to make a test or demo pass.
- The generic-device opt-in is one local-only switch under **Settings -> About**. Agent, Voice, Video,
  and Control share it; disabling it removes generic UI, AI context/tools, and backend startup.
- Model context is a positive snapshot: include only connected, enabled, healthy capabilities. Every
  physical instance has an opaque target ID even when names match. A call targets one exact instance;
  no implicit fan-out or name-based routing. Topology changes revoke stale IDs and grants.
- Human selection is not authorization. Narrow schemas never replace execution-time checks.

## Work and verification

Use: understand -> plan -> implement -> narrow tests -> affected/full tests -> diff review -> handoff.
Observable changes need regression tests. Put tests beside source as `name.test.ts(x)`; use `__tests__`
only for app composition. Test contracts, safety failures, and stops with deterministic boundary fakes.
Never silence, exclude, or wrap failures in `|| true`.

```bash
npm test
npm run test:module -- <name>
npm run test:affected -- --base=<ref>
npm run check:structure
npm run lint
npm run typecheck
npm run test:full
npm run build
```

Do not commit generated output or edit `docs/legacy`. Keep maintained docs indexed. Feature branches
start from and merge into `dev`; `main` is production. Kit/MCP public changes need Changesets. Unless
explicitly requested, do not version, deploy, publish, push, merge, tag, or trigger releases.

The handoff reports behavior, safety impact, commands run, checks not run, API/dependency/docs impact,
remaining risks, and preserved user work. Never hide failures or fabricate validation.
