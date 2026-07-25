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

## Two kinds of activation key

- **Static keys** — the `TRIAL_KEYS` registry below. Long-lived hand-out tokens
  with individual caps/expiry, revocable one by one.
- **Daily rotating key** — a single key that changes every AOE day and is
  emailed to you automatically. See [Daily rotating key](#daily-rotating-key).

Both are accepted at once: `/api/realtime` tries the daily key first, then the
static registry.

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

## Daily rotating key

A single key of the form `dgv-daily-<AOE date>-<hmac>` that rotates every day
and is emailed to you. It's **deterministic** — `HMAC-SHA256(TRIAL_DAILY_SEED,
<AOE date>)` — so the Worker derives and validates it on demand; nothing is
stored, and the key is valid whether or not the cron/email ran. The cron
(`0 12 * * *` = 00:00 AOE, UTC-12) only mails it to you.

Grace: after each rollover, yesterday's key keeps working for
`TRIAL_DAILY_GRACE_MINUTES` (default 180) so a call in progress at 12:00 UTC —
and anyone handed the key shortly before — isn't cut off mid-use.

### One-time setup

```sh
# 1. Seed for the HMAC (set once, keep it stable — changing it invalidates all keys):
openssl rand -base64 32 | wrangler secret put TRIAL_DAILY_SEED

# 2. Where to email the daily key (secret: personal address, public repo):
wrangler secret put TRIAL_KEY_EMAIL_TO      # e.g. you@icloud.com

# 3. Onboard the sender domain for Email Sending (adds SPF+DKIM DNS, once):
wrangler email sending enable 0xnullai.com
wrangler email sending dns get 0xnullai.com # verify records propagated
```

`TRIAL_KEY_EMAIL_FROM` (default `trial@0xnullai.com`), `TRIAL_DAILY_CAP_MINUTES`
and `TRIAL_DAILY_GRACE_MINUTES` are non-secret `vars` in `wrangler.jsonc`.

### Get today's key without waiting for the email

```sh
TRIAL_DAILY_SEED='…' node scripts/daily-key.mjs            # today (AOE)
TRIAL_DAILY_SEED='…' node scripts/daily-key.mjs --date 2026-07-25
```

Same derivation as the Worker. To fire the cron manually and send the email now,
use the **Trigger** button on the Worker's Cron Triggers page in the dashboard,
or in `wrangler dev`: `curl "http://localhost:8787/__scheduled?cron=0+12+*+*+*"`.

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
