export interface Env {
  /** Per-activation-key metering Durable Object (`TrialSession`). */
  TRIAL_SESSION: DurableObjectNamespace;

  // ---- secrets (set with `wrangler secret put`, never committed) ----
  /** The real xAI API key. Only ever used on the Worker→xAI upstream leg. */
  XAI_API_KEY?: string;
  /**
   * Activation-key registry as a JSON object:
   *   { "dgv-trial-abc123": { "dailyCapMinutes": 30, "expiresAt": 1767225600000 } }
   * A bare `{}`-less/absent value disables every key. `enabled: false`,
   * a past `expiresAt`, or an absent entry all reject the key.
   */
  TRIAL_KEYS?: string;

  // ---- vars (plain config in wrangler.jsonc; strings) ----
  /** Grok model pinned for every trial session. */
  TRIAL_MODEL?: string;
  /** Hard per-session length cap (minutes). Default 20. */
  TRIAL_MAX_SESSION_MINUTES?: string;
  /** Default per-key daily minute cap when the registry entry omits one. Default 60. */
  TRIAL_DEFAULT_DAILY_CAP_MINUTES?: string;
  /** Global kill switch — `"1"` rejects all trial connections. */
  TRIAL_DISABLED?: string;
  /** Comma-separated allow-list of browser Origins. Unset ⇒ allow any (dev). */
  TRIAL_ALLOWED_ORIGINS?: string;
}

export interface TrialKeyConfig {
  maxSessionMinutes: number;
  dailyCapMinutes: number;
}
