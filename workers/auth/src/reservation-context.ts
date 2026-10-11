import type { SessionEnv } from './session-domain';
export class ReservationContextRejected extends Error {}
export interface ReservationContext {
  conversationId: string;
  runId: string;
}
export async function reserveWithContext<T extends { allowed: boolean; created?: boolean }>(
  env: Pick<SessionEnv, 'DB'>,
  user: string,
  key: string,
  context: unknown,
  reserve: () => Promise<T>,
): Promise<T> {
  if (context === undefined) return reserve();
  const value = context as ReservationContext | null;
  if (
    !value ||
    typeof value.conversationId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(value.conversationId) ||
    typeof value.runId !== 'string' ||
    !/^[A-Za-z0-9._:-]{8,128}$/.test(value.runId)
  )
    throw new ReservationContextRejected('credit_context_invalid');
  if (
    !(await env.DB.prepare(
      'SELECT 1 FROM server_conversations WHERE user_id=? AND id=? AND deleted_at IS NULL',
    )
      .bind(user, value.conversationId)
      .first())
  )
    throw new ReservationContextRejected('credit_conversation_not_owned');
  const existed = await env.DB.prepare('SELECT 1 FROM credit_reservations WHERE idempotency_key=?')
    .bind(key)
    .first();
  const result = await reserve();
  // Duplicate keys never overwrite the original association or grant another generation.
  if (!result.allowed || existed || result.created !== true) return { ...result, allowed: false };
  try {
    const inserted = await env.DB.prepare(
      `INSERT INTO reservation_context(reservation_key,user_id,conversation_id,run_id,relationship_id,created_at)
      SELECT ?,c.user_id,c.id,?,json_extract(c.metadata,'$.relationshipId'),? FROM server_conversations c
      WHERE c.user_id=? AND c.id=? AND c.deleted_at IS NULL AND EXISTS(SELECT 1 FROM credit_reservations r WHERE r.idempotency_key=? AND r.user_id=c.user_id AND r.status='pending') ON CONFLICT(reservation_key) DO NOTHING RETURNING reservation_key`,
    )
      .bind(key, value.runId, Date.now(), user, value.conversationId, key)
      .first();
    if (!inserted) {
      if (
        await env.DB.prepare('SELECT 1 FROM reservation_context WHERE reservation_key=?')
          .bind(key)
          .first()
      )
        return { ...result, allowed: false };
      throw new Error('credit_conversation_changed');
    }
  } catch (error) {
    // No model/voice upstream has begun. Release only the just-created, owner-scoped hold.
    await env.DB.prepare(
      "UPDATE credit_reservations SET status='released',updated_at=? WHERE idempotency_key=? AND user_id=? AND status='pending'",
    )
      .bind(Date.now(), key, user)
      .run()
      .catch(() => console.error('Credit context cleanup deferred'));
    throw error;
  }
  return result;
}
