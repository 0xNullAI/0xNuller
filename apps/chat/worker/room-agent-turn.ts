import type { NamedRoomAgent } from './wire';

const TURN_WINDOW_MS = 5 * 60_000;
const MAX_PENDING_TURNS = 4;
const MAX_TURNS_PER_MINUTE = 12;
const MAX_TURNS_PER_HOUR = 120;

export function initializeRoomAgentTurns(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS room_agent_turns (
    trigger_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    role_config TEXT NOT NULL,
    host_peer_id TEXT NOT NULL,
    grant_id TEXT NOT NULL,
    response_id TEXT,
    claimed_at INTEGER NOT NULL,
    PRIMARY KEY(trigger_id, role_id)
  )`);
}

/** The server is the only runner; the column predates owned AIs and keeps its old name. */
export const SERVER_TURN_RUNNER = 'managed';

/** A claimed turn is never reissued: a fresh human mention retries it. */
export function claimRoomAgentTurn(
  sql: SqlStorage,
  triggerId: unknown,
  roleId: unknown,
  agents: NamedRoomAgent[],
  now: number,
): string | null {
  const agent = agents.find((candidate) => candidate.id === roleId);
  if (
    typeof triggerId !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(triggerId) ||
    typeof roleId !== 'string' ||
    !agent
  )
    return null;
  const trigger = sql
    .exec(
      `SELECT m.from_id,m.body,m.ts,s.sender_account FROM messages m
       LEFT JOIN message_sequences s ON s.message_id=m.id WHERE m.id=?`,
      triggerId,
    )
    .toArray()[0];
  if (
    !trigger ||
    typeof trigger.from_id !== 'string' ||
    trigger.from_id.startsWith('ai:') ||
    typeof trigger.sender_account !== 'string' ||
    !trigger.sender_account ||
    typeof trigger.ts !== 'number' ||
    trigger.ts > now ||
    now - trigger.ts > TURN_WINDOW_MS ||
    !activeMember(sql, trigger.sender_account)
  )
    return null;
  let body: { mentions?: unknown };
  try {
    body = JSON.parse(String(trigger.body));
  } catch {
    return null;
  }
  if (!Array.isArray(body.mentions)) return null;
  if (firstMentionedAgent(body.mentions, agents) !== agent.id) return null;
  // A trigger expires before its claim is pruned; the one-hour ledger bounds
  // rate-limit state without reopening an old message for replay.
  sql.exec('DELETE FROM room_agent_turns WHERE claimed_at<?', now - 60 * 60_000);
  const usage = sql
    .exec(
      'SELECT COUNT(*) AS hourly, SUM(CASE WHEN claimed_at>? THEN 1 ELSE 0 END) AS minute FROM room_agent_turns',
      now - 60_000,
    )
    .toArray()[0];
  if (
    Number(usage?.hourly ?? 0) >= MAX_TURNS_PER_HOUR ||
    Number(usage?.minute ?? 0) >= MAX_TURNS_PER_MINUTE
  )
    return null;
  const pending = sql
    .exec(
      'SELECT COUNT(*) AS n FROM room_agent_turns WHERE response_id IS NULL AND claimed_at>?',
      now - TURN_WINDOW_MS,
    )
    .toArray()[0];
  if (Number(pending?.n ?? 0) >= MAX_PENDING_TURNS) return null;
  const grantId = crypto.randomUUID();
  const inserted = sql
    .exec(
      `INSERT INTO room_agent_turns(trigger_id,role_id,role_config,host_peer_id,grant_id,claimed_at)
       VALUES(?,?,?,?,?,?) ON CONFLICT(trigger_id,role_id) DO NOTHING RETURNING grant_id`,
      triggerId,
      roleId,
      JSON.stringify([agent.name, agent.persona]),
      SERVER_TURN_RUNNER,
      grantId,
      now,
    )
    .toArray();
  return inserted.length ? grantId : null;
}

/** One message wakes at most one AI: the first configured one it mentions. */
export function firstMentionedAgent(
  mentions: unknown,
  agents: readonly NamedRoomAgent[],
): string | null {
  if (!Array.isArray(mentions)) return null;
  for (const mention of mentions) {
    const peerId = (mention as { peerId?: unknown } | null)?.peerId;
    const agent = agents.find((candidate) => peerId === `ai:${candidate.id}`);
    if (agent) return agent.id;
  }
  return null;
}

/** Called inside the same synchronous transaction as inserting the AI message. */
export function canCompleteRoomAgentTurn(
  sql: SqlStorage,
  triggerId: unknown,
  roleId: string,
  agent: NamedRoomAgent | undefined,
  grantId: unknown,
  now: number,
): boolean {
  if (typeof triggerId !== 'string' || typeof grantId !== 'string' || !agent) return false;
  const row = sql
    .exec(
      `SELECT response_id,claimed_at FROM room_agent_turns
       WHERE trigger_id=? AND role_id=? AND role_config=? AND grant_id=? AND host_peer_id=?`,
      triggerId,
      roleId,
      JSON.stringify([agent.name, agent.persona]),
      grantId,
      SERVER_TURN_RUNNER,
    )
    .toArray()[0];
  return !!row && row.response_id == null && Number(row.claimed_at) + TURN_WINDOW_MS >= now;
}

/**
 * Recheck the durable trigger and both accounts whenever a turn crosses network I/O: the
 * member who asked must still be in the group, and so must the owner who pays.
 */
export function managedRoomAgentTurnCurrent(
  sql: SqlStorage,
  triggerId: string,
  roleId: string,
  agent: NamedRoomAgent,
  grantId: string,
  owner: string,
  now: number,
): boolean {
  if (!canCompleteRoomAgentTurn(sql, triggerId, roleId, agent, grantId, now)) return false;
  const trigger = sql
    .exec(
      `SELECT m.from_id,s.sender_account FROM messages m
       JOIN message_sequences s ON s.message_id=m.id WHERE m.id=?`,
      triggerId,
    )
    .toArray()[0];
  return (
    !!trigger &&
    typeof trigger.from_id === 'string' &&
    !trigger.from_id.startsWith('ai:') &&
    typeof trigger.sender_account === 'string' &&
    activeMember(sql, trigger.sender_account) &&
    activeMember(sql, owner)
  );
}

export function completeRoomAgentTurn(
  sql: SqlStorage,
  triggerId: string,
  roleId: string,
  responseId: string,
): void {
  const updated = sql
    .exec(
      'UPDATE room_agent_turns SET response_id=? WHERE trigger_id=? AND role_id=? AND response_id IS NULL RETURNING trigger_id',
      responseId,
      triggerId,
      roleId,
    )
    .toArray();
  if (updated.length !== 1) throw new Error('room agent turn was consumed concurrently');
}

function activeMember(sql: SqlStorage, account: string): boolean {
  return (
    sql
      .exec(
        "SELECT account_id FROM group_memberships WHERE account_id=? AND state='active'",
        account,
      )
      .toArray().length > 0
  );
}
