export interface Env {
  /** Per-activation-key metering Durable Object (`TrialSession`). */
  TRIAL_SESSION: DurableObjectNamespace;
  AUTH: {
    authorizeVoiceTicket(ticket: string): Promise<VoiceTicketQuotaResult | 'unauthorized'>;
    consumeVoiceTicket(
      ticket: string,
      minutes: number,
    ): Promise<VoiceTicketQuotaResult | 'unauthorized'>;
  };

  // ---- secrets (set with `wrangler secret put`, never committed) ----
  /** The real xAI API key. Only ever used on the Worker→xAI upstream leg. */
  XAI_API_KEY?: string;

  // ---- vars (plain config in wrangler.jsonc; strings) ----
  /** Grok model pinned for every trial session. */
  TRIAL_MODEL?: string;
  /** Hard per-session length cap (minutes). Default 20. */
  TRIAL_MAX_SESSION_MINUTES?: string;
  /** Global kill switch — `"1"` rejects all trial connections. */
  TRIAL_DISABLED?: string;
  /** Comma-separated allow-list of browser Origins. Unset only allows local development. */
  TRIAL_ALLOWED_ORIGINS?: string;
}

export interface VoiceTicketQuotaResult {
  subject: string;
  allowed: boolean;
  remaining: number;
  limit: number;
}
