---
'@dg-kit/core': patch
'@dg-kit/protocol': patch
'@dg-kit/waveforms': patch
'@dg-kit/tools': patch
'@dg-kit/transport-webbluetooth': patch
---

Fix published `package.json` so `main` / `types` / `exports` point to `dist/`. The previous 0.1.0 tarballs had `main: src/index.ts` from the unsupported `publishConfig.main` override pattern, which broke `import` resolution for downstream consumers. Local dev now requires `npm run build` before `typecheck` / `test` (wired automatically via `pretypecheck` / `pretest`).
