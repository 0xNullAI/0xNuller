export interface Env {
  VOICE_SESSION: DurableObjectNamespace;
  AUTH: {
    finalizeVoiceReservation(
      subject: string,
      reservationKey: string,
      input: { action: 'settle' | 'release'; durationMs: number },
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
  XAI_API_KEY?: string;
  MANAGED_MODEL?: string;
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
