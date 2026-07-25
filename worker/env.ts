export interface Env {
  /** SPA static assets (the built `dist/`). */
  ASSETS: Fetcher;

  /** Per-activation-key metering Durable Object (`TrialSession`). */
  TRIAL_SESSION: DurableObjectNamespace;

  /** Cloudflare Email Sending binding — mails the daily rotating key. */
  EMAIL: SendEmailBinding;

  // ---- secrets (set with `wrangler secret put`, never committed) ----
  /** The real xAI API key. Only ever used on the Worker→xAI upstream leg. */
  XAI_API_KEY?: string;
  /**
   * Activation-key registry as a JSON object:
   *   { "dgv-trial-abc123": { "dailyCapMinutes": 30, "expiresAt": 1767225600000 } }
   * A bare `{}`-less/absent value disables every key. `enabled: false`,
   * a past `expiresAt`, or an absent entry all reject the key.
   *
   * This is the STATIC registry (hand-out keys with individual caps/expiry). The
   * self-rotating daily key is separate — see `TRIAL_DAILY_SEED` and daily-key.ts.
   */
  TRIAL_KEYS?: string;
  /**
   * HMAC seed for the deterministic daily key. Set once with a long random value
   * (`openssl rand -base64 32`). When set, `dgv-daily-<AOE date>-<hmac>` is
   * accepted; when unset, only the static `TRIAL_KEYS` registry is used.
   */
  TRIAL_DAILY_SEED?: string;
  /** Recipient of the daily-key email. SECRET (personal address; repo is public). */
  TRIAL_KEY_EMAIL_TO?: string;

  // ---- vars (plain config in wrangler.jsonc; strings) ----
  /** Grok model pinned for every trial session. */
  TRIAL_MODEL?: string;
  /** Hard per-session length cap (minutes). Default 20. */
  TRIAL_MAX_SESSION_MINUTES?: string;
  /** Default per-key daily minute cap when the registry entry omits one. Default 60. */
  TRIAL_DEFAULT_DAILY_CAP_MINUTES?: string;
  /** Daily minute cap for the rotating daily key. Falls back to the default above. */
  TRIAL_DAILY_CAP_MINUTES?: string;
  /** Minutes after AOE rollover (12:00 UTC) that yesterday's daily key still works. Default 180. */
  TRIAL_DAILY_GRACE_MINUTES?: string;
  /** `From` address for the daily-key email. Must be on an onboarded domain. Default trial@0xnullai.com. */
  TRIAL_KEY_EMAIL_FROM?: string;
  /** Global kill switch — `"1"` rejects all trial connections. */
  TRIAL_DISABLED?: string;
  /** Comma-separated allow-list of browser Origins. Unset ⇒ allow any (dev). */
  TRIAL_ALLOWED_ORIGINS?: string;
}

/** Minimal shape of the Cloudflare `send_email` binding's object-form `send()`. */
export interface SendEmailBinding {
  send(message: {
    to: string | string[];
    from: string | { email: string; name?: string };
    replyTo?: string;
    subject: string;
    html?: string;
    text?: string;
  }): Promise<{ messageId?: string }>;
}

export interface TrialKeyConfig {
  maxSessionMinutes: number;
  dailyCapMinutes: number;
}
