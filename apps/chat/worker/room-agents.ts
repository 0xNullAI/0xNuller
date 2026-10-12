import {
  MAX_GROUP_AGENTS,
  MAX_ROOM_AGENT_NAME,
  MAX_ROOM_AGENT_PERSONA,
  type NamedRoomAgent,
  type WireRoomAgent,
} from './wire';

/**
 * A group AI belongs to the member who brought it in.
 *
 * It is that member's own character, runs only on the server and spends only that member's
 * Credit. Ownership is an account, never a peer or a browser: it leaves with the account
 * (leave, removal, deletion) and is the only identity that may change or bill it.
 */
export interface RoomAgentRecord extends NamedRoomAgent {
  owner: string;
  ownerName: string;
  /** The owner's character; null for an AI migrated from before AIs had owners. */
  characterId: string | null;
  /** Credit the owner allows per day in this group; null means only the balance limits it. */
  dailyCap: number | null;
}

export type AddRoomAgentResult =
  { ok: true; agent: RoomAgentRecord } | { ok: false; message: string };

/** One owner may bring this many AIs into one group. */
const PER_OWNER = 1;
/** A cap above any plausible day keeps the column a plain bounded number. */
export const MAX_AGENT_DAILY_CAP = 100_000;

export function initializeRoomAgents(sql: SqlStorage): void {
  sql.exec(`CREATE TABLE IF NOT EXISTS room_agents (
    id TEXT PRIMARY KEY,
    owner_account TEXT NOT NULL,
    owner_name TEXT NOT NULL,
    character_id TEXT,
    name TEXT NOT NULL,
    persona TEXT NOT NULL,
    daily_cap REAL,
    created_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS room_agent_spend (
    agent_id TEXT NOT NULL,
    day TEXT NOT NULL,
    credits REAL NOT NULL,
    PRIMARY KEY(agent_id, day)
  )`);
}

export function listRoomAgents(sql: SqlStorage): RoomAgentRecord[] {
  return sql
    .exec(
      'SELECT id,owner_account,owner_name,character_id,name,persona,daily_cap FROM room_agents ORDER BY created_at,id',
    )
    .toArray()
    .map((row) => ({
      id: String(row.id),
      owner: String(row.owner_account),
      ownerName: String(row.owner_name),
      characterId: row.character_id == null ? null : String(row.character_id),
      name: String(row.name),
      persona: String(row.persona),
      dailyCap: row.daily_cap == null ? null : Number(row.daily_cap),
    }));
}

/** What every member sees; the character id stays with the owner's account. */
export function wireRoomAgents(agents: RoomAgentRecord[]): WireRoomAgent[] {
  return agents.map(({ id, name, persona, owner, ownerName, dailyCap }) => ({
    id,
    name,
    persona,
    owner,
    ownerName,
    dailyCap,
  }));
}

export function validAgentText(name: unknown, persona: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    name.trim().length <= MAX_ROOM_AGENT_NAME &&
    typeof persona === 'string' &&
    persona.length <= MAX_ROOM_AGENT_PERSONA
  );
}

export function addRoomAgent(
  sql: SqlStorage,
  input: { owner: string; ownerName: string; characterId: string; name: string; persona: string },
  now: number,
): AddRoomAgentResult {
  if (!validAgentText(input.name, input.persona))
    return {
      ok: false,
      message: `AI 名字须为 1–${MAX_ROOM_AGENT_NAME} 个字符，人设最多 ${MAX_ROOM_AGENT_PERSONA} 个字符`,
    };
  const agents = listRoomAgents(sql);
  if (agents.filter((agent) => agent.owner === input.owner).length >= PER_OWNER)
    return { ok: false, message: '每人在一个群里只能带一个 AI，请先撤出原来的 AI' };
  if (agents.length >= MAX_GROUP_AGENTS)
    return { ok: false, message: `每个群最多 ${MAX_GROUP_AGENTS} 个 AI` };
  const agent: RoomAgentRecord = {
    id: `a${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    owner: input.owner,
    ownerName: input.ownerName.slice(0, 80),
    characterId: input.characterId,
    name: input.name.trim(),
    persona: input.persona,
    dailyCap: null,
  };
  sql.exec(
    'INSERT INTO room_agents(id,owner_account,owner_name,character_id,name,persona,daily_cap,created_at) VALUES(?,?,?,?,?,?,NULL,?)',
    agent.id,
    agent.owner,
    agent.ownerName,
    agent.characterId,
    agent.name,
    agent.persona,
    now,
  );
  return { ok: true, agent };
}

/** Only the owner sets its own AI's daily cap. Returns false when nothing changed. */
export function setRoomAgentDailyCap(
  sql: SqlStorage,
  id: unknown,
  owner: string,
  cap: unknown,
): boolean {
  if (typeof id !== 'string') return false;
  if (
    cap !== null &&
    (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0 || cap > MAX_AGENT_DAILY_CAP)
  )
    return false;
  return (
    sql
      .exec(
        'UPDATE room_agents SET daily_cap=? WHERE id=? AND owner_account=? RETURNING id',
        cap,
        id,
        owner,
      )
      .toArray().length > 0
  );
}

export function removeRoomAgent(sql: SqlStorage, id: unknown): boolean {
  if (typeof id !== 'string') return false;
  const removed = sql.exec('DELETE FROM room_agents WHERE id=? RETURNING id', id).toArray();
  sql.exec('DELETE FROM room_agent_spend WHERE agent_id=?', id);
  return removed.length > 0;
}

/** An AI never outlives its owner's membership. */
export function removeOwnerAgents(sql: SqlStorage, owner: string): boolean {
  const removed = sql
    .exec('DELETE FROM room_agents WHERE owner_account=? RETURNING id', owner)
    .toArray();
  for (const row of removed) sql.exec('DELETE FROM room_agent_spend WHERE agent_id=?', row.id);
  return removed.length > 0;
}

export function clearRoomAgents(sql: SqlStorage): void {
  sql.exec('DELETE FROM room_agents');
  sql.exec('DELETE FROM room_agent_spend');
}

/**
 * Give an ownerless pre-ownership AI to the group's owner, keeping its sender id so its
 * history still reads as the same speaker. A group with no owner yet keeps it stored until
 * its first signed-in member becomes the owner. Returns true when the legacy storage is done.
 */
export function migrateLegacyAgent(
  sql: SqlStorage,
  legacy: NamedRoomAgent | null,
  owner: { account: string; name: string } | null,
  now: number,
): boolean {
  if (!legacy) return true;
  if (!owner) return false;
  if (listRoomAgents(sql).length > 0) return true;
  if (!validAgentText(legacy.name, legacy.persona)) return true;
  sql.exec(
    'INSERT OR IGNORE INTO room_agents(id,owner_account,owner_name,character_id,name,persona,daily_cap,created_at) VALUES(?,?,?,NULL,?,?,NULL,?)',
    legacy.id,
    owner.account,
    owner.name.slice(0, 80),
    legacy.name.trim(),
    legacy.persona,
    now,
  );
  return true;
}

/** Days follow China time, where the users are, so a cap resets at local midnight. */
export function agentSpendDay(now: number): string {
  return new Date(now + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

export function agentSpentToday(sql: SqlStorage, id: string, now: number): number {
  const row = sql
    .exec('SELECT credits FROM room_agent_spend WHERE agent_id=? AND day=?', id, agentSpendDay(now))
    .toArray()[0];
  return row ? Number(row.credits) : 0;
}

export function recordAgentSpend(sql: SqlStorage, id: string, credits: number, now: number): void {
  if (!Number.isFinite(credits) || credits <= 0) return;
  const day = agentSpendDay(now);
  sql.exec('DELETE FROM room_agent_spend WHERE agent_id=? AND day<>?', id, day);
  sql.exec(
    `INSERT INTO room_agent_spend(agent_id,day,credits) VALUES(?,?,?)
     ON CONFLICT(agent_id,day) DO UPDATE SET credits=credits+excluded.credits`,
    id,
    day,
    credits,
  );
}

/** The cap is checked before a turn; one turn may overshoot it by its own cost. */
export function agentOverDailyCap(sql: SqlStorage, agent: RoomAgentRecord, now: number): boolean {
  return agent.dailyCap !== null && agentSpentToday(sql, agent.id, now) >= agent.dailyCap;
}
