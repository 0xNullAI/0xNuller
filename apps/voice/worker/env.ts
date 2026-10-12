import type { ServerErrorReport } from '@0xnullai/observability';

/** Provider-reported token usage summed over a call's rounds (see `@0xnullai/ai-pricing`). */
export interface RealtimeUsageTotals {
  inputAudioTokens: number;
  inputTextTokens: number;
  cachedAudioTokens: number;
  cachedTextTokens: number;
  outputAudioTokens: number;
  outputTextTokens: number;
}

export interface Env {
  VOICE_SESSION: DurableObjectNamespace;
  AUTH: {
    /** Fail-open error counter on the Auth binding (see @0xnullai/observability). */
    recordServerErrors?(report: ServerErrorReport): Promise<unknown>;
    finalizeVoiceReservation(
      subject: string,
      reservationKey: string,
      input: {
        action: 'settle' | 'release';
        durationMs: number;
        usage?: RealtimeUsageTotals;
        rounds?: number;
        missingRounds?: number;
      },
    ): Promise<{
      status: 'settled' | 'released' | 'missing' | 'rejected' | 'needs_review';
      charged: number | null;
    }>;
    authorizeVoiceTicket(ticket: string): Promise<VoiceTicketCreditResult | 'unauthorized'>;
    reserveVoiceCredits(
      ticket: string,
      idempotencyKey: string,
      credits: number,
      context?: { conversationId: string; runId: string },
    ): Promise<CreditReservationResult | 'unauthorized'>;
    settleVoiceCredits(
      ticket: string,
      idempotencyKey: string,
      credits: number,
      durationMs: number,
    ): Promise<CreditReservationResult | 'unauthorized'>;
    releaseVoiceCredits(
      ticket: string,
      idempotencyKey: string,
    ): Promise<CreditReservationResult | 'unauthorized'>;
  };
  /** Doubao speech key, sent upstream as `X-Api-Key`; never reaches the browser. */
  VOLC_SPEECH_API_KEY?: string;
  /** Managed AI routes and Credit prices (JSON); the realtime route names the model. */
  AI_PRICE_TABLE?: string;
  MAX_SESSION_MINUTES?: string;
  MANAGED_DISABLED?: string;
  ALLOWED_ORIGINS?: string;
}

export interface VoiceTicketCreditResult {
  subject: string;
  total: number;
  reserved: number;
  available: number;
}

export interface CreditReservationResult {
  allowed: boolean;
  status: 'pending' | 'settled' | 'released' | 'insufficient' | 'rejected';
  charged: number | null;
  total: number;
  reserved: number;
  available: number;
}
