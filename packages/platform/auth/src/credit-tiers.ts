/**
 * The Credit tiers sold for money: one list for the admin key generator, the server that
 * validates it, and every label that names a tier. A redeem key is minted for exactly one tier.
 */
/** Recorded on every Credit grant so a later price change can tell old purchases apart. */
export const CREDIT_PRICE_VERSION = 'credits-2026-09';

export interface CreditTier {
  amountCny: number;
  /** What one key of this tier adds. Round numbers; larger tiers give more per yuan. */
  credits: number;
}

/** The familiar store price points (6 / 30 / 68 / 128 / 328 / 648). */
export const CREDIT_TIERS: readonly CreditTier[] = Object.freeze([
  { amountCny: 6, credits: 1_000 },
  { amountCny: 30, credits: 5_000 },
  { amountCny: 68, credits: 12_000 },
  { amountCny: 128, credits: 23_000 },
  { amountCny: 328, credits: 60_000 },
  { amountCny: 648, credits: 120_000 },
]);

export function creditTierForCny(amountCny: number): CreditTier | undefined {
  return CREDIT_TIERS.find((tier) => tier.amountCny === amountCny);
}

/** Redeem keys are 64 characters from this alphabet: no 0/O or 1/I to misread. */
export const REDEEM_CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const REDEEM_CODE_LENGTH = 64;

/** What a user typed, as stored: spaces and dashes dropped, upper case. Null when malformed. */
export function normalizeRedeemCode(input: string): string | null {
  const code = input.replace(/[\s-]+/g, '').toUpperCase();
  if (code.length !== REDEEM_CODE_LENGTH) return null;
  for (const char of code) if (!REDEEM_CODE_ALPHABET.includes(char)) return null;
  return code;
}
