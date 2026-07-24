# DG-Voice Worker

Two jobs:

1. **Static hosting** — serves the built SPA (`dist/`). Providers you bring your
   own key for (xAI / OpenAI / Azure / 智谱) connect straight from the browser
   and never touch the Worker.
2. **体验版 (trial) proxy** — `/api/realtime`. The trial user pastes an
   **activation key** instead of a real API key. The Worker validates + meters
   it, then opens the upstream xAI realtime socket using the **real** xAI key
   (a Worker secret, never sent to the browser) and pipes audio both ways.

## How the trial connection works

```
browser ──WS── /api/realtime ──(validate key + meter)── TrialSession DO ──WS── api.x.ai
  激活密钥 in                                            real XAI_API_KEY out
  Sec-WebSocket-Protocol                                (Worker can set headers;
                                                         the browser can't)
```

- Frontend: provider `trial` (`src/lib/realtime/providers.ts`) points its WS at
  the same-origin `/api/realtime` and sends the activation key in the
  `openai-insecure-api-key.<key>` subprotocol — the identical shape as a direct
  xAI connection, so the adapter is a two-line branch in
  `openai-realtime-session.ts`.
- `worker/index.ts` validates the key and forwards to a `TrialSession` Durable
  Object (one per activation key).
- `worker/trial-session.ts` (the DO) enforces the caps and does the piping.

## Money-safety caps

Everything the frontend can't be trusted with lives in the DO:

| Guard | Default | Source |
|---|---|---|
| Concurrent sessions per key | 1 | in-memory in the DO |
| Hard per-session length | 20 min | `TRIAL_MAX_SESSION_MINUTES` (storage alarm) |
| Rolling daily minutes per key | 60 min | `TRIAL_DEFAULT_DAILY_CAP_MINUTES` or per-key `dailyCapMinutes` |
| Global kill switch | off | `TRIAL_DISABLED="1"` rejects everything |
| Origin allow-list | `voice.0xnullai.com` | `TRIAL_ALLOWED_ORIGINS` (localhost always allowed) |

A session also ends early if it would exceed the remaining daily budget.

## Configure

Non-secret config is in `wrangler.jsonc` under `vars`. Secrets are set out of
band (never committed):

```sh
wrangler secret put XAI_API_KEY      # your real xAI key
wrangler secret put TRIAL_KEYS       # the activation-key registry (JSON)
```

`TRIAL_KEYS` is a JSON object mapping activation key → options:

```json
{
  "dgv-trial-aaa": { "dailyCapMinutes": 30 },
  "dgv-trial-bbb": { "dailyCapMinutes": 60, "expiresAt": 1785537261567 },
  "dgv-trial-ccc": { "enabled": false }
}
```

- `dailyCapMinutes` (optional) — overrides `TRIAL_DEFAULT_DAILY_CAP_MINUTES`.
- `expiresAt` (optional) — epoch ms; past ⇒ rejected.
- `enabled: false` — revoke without deleting.

## Manage keys

```sh
node scripts/gen-trial-key.mjs --daily 30 --days 7
```

Prints a fresh `dgv-trial-…` key and the JSON entry. Merge it into the full
`TRIAL_KEYS` object and re-run `wrangler secret put TRIAL_KEYS`. **Activation
keys are bearer tokens** — anyone holding one spends your xAI credit up to its
caps. Hand them out privately; revoke by removing the entry or setting
`"enabled": false`.

## Run locally

```sh
cp .dev.vars.example .dev.vars   # fill in XAI_API_KEY + a test key
npm run build                    # trial WS is served from ./dist by wrangler
npm run cf:dev                   # wrangler dev (serves SPA + /api/realtime)
```

Then pick 体验版 in settings and paste the local test key. (`npm run dev` / Vite
alone does **not** run the Worker, so the trial path is unavailable there — use
`wrangler dev`.)

## Deploy

```sh
npm run deploy   # build + wrangler deploy
```

The first deploy runs the `v1` Durable Object migration (`wrangler.jsonc` →
`migrations`).
