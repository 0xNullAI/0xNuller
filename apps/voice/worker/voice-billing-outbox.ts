import type { Env, RealtimeUsageTotals } from './env.js';

const PREFIX = 'billing:';
export const CHECKPOINT_MS = 10_000;
// Duration tariff of records written before calls billed by provider usage. Kept only so
// those durable records can still be acknowledged; new calls never use it.
const LEGACY_CREDITS_PER_SEGMENT = 20;
const LEGACY_SEGMENT_MS = 10_000;
/** Failed looks before a release whose hold is still `missing` counts as done. */
const MISSING_RELEASE_CONFIRMATIONS = 2;

/** A late RPC can still commit; the reservation key makes the next retry safe. */
export async function withBillingTimeout<T>(request: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Billing service timed out')), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export interface VoiceBillingRecord {
  subject: string;
  reservationKey: string;
  phase: 'release' | 'active' | 'settle';
  durationMs: number;
  /** Quote accepted when this hold was created. Older durable records omit it. */
  reservedCredits?: number;
  /** Provider usage summed over reported rounds. Absent on duration-billed records. */
  usage?: RealtimeUsageTotals;
  rounds?: number;
  /** Rounds known to have ended without a usage report. */
  missingRounds?: number;
  /** Rounds still awaiting usage at this checkpoint; missing if the call never resumes. */
  openRounds?: number;
  attempts?: number;
  nextAttemptAt?: number;
}

function acknowledged(
  record: VoiceBillingRecord,
  result: Awaited<ReturnType<Env['AUTH']['finalizeVoiceReservation']>>,
) {
  if (result.status === 'needs_review') return result.charged === null;
  if (record.phase === 'release')
    return (
      (result.status === 'released' && result.charged === null) ||
      // No hold exists: the reserve RPC never committed. A late commit could still land just
      // after the first look, so only believe it once it has stayed missing across retries.
      (result.status === 'missing' &&
        result.charged === null &&
        (record.attempts ?? 0) >= MISSING_RELEASE_CONFIRMATIONS)
    );
  if (record.usage) {
    // Auth prices usage with its own copy of the table; accept any charge within the hold,
    // or a release when nothing billable was reported.
    if (result.status === 'released') return result.charged === null;
    return (
      result.status === 'settled' &&
      Number.isSafeInteger(result.charged) &&
      result.charged! > 0 &&
      Number.isSafeInteger(record.reservedCredits) &&
      result.charged! <= record.reservedCredits!
    );
  }
  if (result.status !== 'settled' || !Number.isSafeInteger(result.charged)) return false;
  const charge = result.charged!;
  const quoted = Math.max(
    LEGACY_CREDITS_PER_SEGMENT,
    Math.ceil(record.durationMs / LEGACY_SEGMENT_MS) * LEGACY_CREDITS_PER_SEGMENT,
  );
  if (record.reservedCredits === undefined) {
    // Before this field existed, do not strand valid persisted tasks. Still
    // reject zero, fractional or over-tariff receipts rather than losing them.
    return charge > 0 && charge % LEGACY_CREDITS_PER_SEGMENT === 0 && charge <= quoted;
  }
  return (
    Number.isSafeInteger(record.reservedCredits) &&
    record.reservedCredits >= LEGACY_CREDITS_PER_SEGMENT &&
    charge === Math.min(record.reservedCredits, quoted)
  );
}

/** Durable, serialized finalization intents. Never stores a browser ticket/key. */
export class VoiceBillingOutbox {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private storage: DurableObjectStorage,
    private auth: Env['AUTH'],
  ) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.tail.then(operation);
    this.tail = task.catch(() => undefined);
    return task;
  }
  private async write(record: VoiceBillingRecord) {
    await this.storage.transaction(async (tx) => {
      await tx.put(PREFIX + record.reservationKey, record);
      const previous = await tx.getAlarm();
      const next = Math.max(Date.now() + 1, record.nextAttemptAt ?? Date.now() + CHECKPOINT_MS);
      await tx.setAlarm(
        previous !== null && previous > Date.now() ? Math.min(previous, next) : next,
      );
    });
  }
  save(record: VoiceBillingRecord) {
    return this.serial(() => this.write(record));
  }
  forget(reservationKey: string) {
    return this.serial(async () => {
      await this.storage.delete(PREFIX + reservationKey);
    });
  }
  /**
   * Finalize due records. `busy` names reservations still owned by a call: the live one and
   * any still draining usage after hang-up. Those are skipped, never settled early; every
   * other record is still worked through, one per flush while a call is busy so compensation
   * RPC latency cannot hold up its checkpoints or hard deadline.
   */
  flush(busy: () => ReadonlySet<string>) {
    return this.serial(async () => {
      const records = await this.storage.list<VoiceBillingRecord>({ prefix: PREFIX });
      let processed = 0;
      for (const [key, record] of records) {
        if (processed >= (busy().size ? 1 : 4)) break;
        if (busy().has(record.reservationKey)) continue;
        if ((record.nextAttemptAt ?? 0) > Date.now()) continue;
        processed++;
        // No matching live socket after restart: charge only durably observed usage
        // (or, for old records, connected time), never the downtime since the checkpoint.
        // Rounds still open at the checkpoint will never report usage now.
        const pending: VoiceBillingRecord =
          record.phase === 'active'
            ? {
                ...record,
                phase: 'settle',
                ...(record.usage
                  ? {
                      missingRounds: (record.missingRounds ?? 0) + (record.openRounds ?? 0),
                      openRounds: 0,
                    }
                  : {}),
              }
            : record;
        if (record.phase === 'active') await this.write(pending);
        let unexpectedStatus = false;
        try {
          const result = await withBillingTimeout(
            this.auth.finalizeVoiceReservation(record.subject, record.reservationKey, {
              action: pending.phase === 'release' ? 'release' : 'settle',
              durationMs: record.durationMs,
              ...(pending.usage && pending.phase !== 'release'
                ? {
                    usage: pending.usage,
                    rounds: pending.rounds ?? 0,
                    missingRounds: pending.missingRounds ?? 0,
                  }
                : {}),
            }),
          );
          if (!acknowledged(pending, result)) {
            unexpectedStatus = true;
            throw new Error(`Unexpected billing receipt: ${result.status}`);
          }
          await this.storage.delete(key);
        } catch (error) {
          const attempts = Math.min(30, (record.attempts ?? 0) + 1);
          const delay = Math.min(
            300_000,
            Math.max(unexpectedStatus ? 60_000 : 10_000, 10_000 * 2 ** (attempts - 1)),
          );
          await this.write({ ...pending, attempts, nextAttemptAt: Date.now() + delay });
          console.error(
            JSON.stringify({ event: 'voice_credit_finalize_retry', error: String(error) }),
          );
        }
      }
      const remaining = [
        ...(await this.storage.list<VoiceBillingRecord>({ prefix: PREFIX })).values(),
      ];
      if (remaining.length) {
        // A busy record is not due until its call lets go of it; it only needs the regular
        // checkpoint cadence, not an immediate re-run of this flush.
        const due = Math.min(
          ...remaining
            .filter((record) => !busy().has(record.reservationKey))
            .map((record) => record.nextAttemptAt ?? Date.now() + 1),
        );
        const next = busy().size ? Math.min(due, Date.now() + CHECKPOINT_MS) : due;
        await this.storage.setAlarm(Math.max(Date.now() + 1, next));
      } else await this.storage.deleteAlarm();
    });
  }
}
