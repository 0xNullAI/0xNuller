// LobbyDO: a singleton (idFromName("v1")). Public group registry + live push.
// RoomDO reports in with POST /update when members join/leave or on keepalive; the lobby page subscribes live over /ws/lobby and pulls a snapshot from /api/lobby/rooms.
//
// A row means "this group is public", not "somebody is in it". Groups are permanent, so an
// empty public group stays listed exactly the way the reserved room always has — a row only
// leaves when its owner turns the group private (listed=false).
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

/** A group with no keepalive for longer than this is treated as having nobody online (a fallback; normally RoomDO reports count=0 as it empties). */
const LOBBY_STALE_MS = 45 * 1000;

interface LobbyRoom {
  code: string;
  name: string;
  count: number;
}

/** What RoomDO posts to /update. `listed` false means "take this group out of the lobby". */
interface LobbyUpdate extends LobbyRoom {
  listed?: boolean;
}

export class LobbyDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, name TEXT, count INTEGER, ts INTEGER)',
    );
    // Idempotent migration: add the scene_name / pinned columns to the existing singleton's old table
    // (running it again throws, which is fine to ignore).
    // scene_name is dead: the roleplay feature it described is gone and nothing reads or
    // writes it any more. It is kept because this is a live singleton DO — dropping a
    // column there is a migration with real failure modes, in exchange for nothing.
    try {
      this.sql.exec('ALTER TABLE rooms ADD COLUMN scene_name TEXT');
    } catch {
      /* column already exists */
    }
    // Remove the pre-6.0 hard-coded discussion room. It has no owner and therefore cannot
    // participate in the unified room lifecycle; keeping its old row would make it immortal.
    this.sql.exec("DELETE FROM rooms WHERE code = '0xNullAI'");
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws/lobby') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].send(JSON.stringify(this.snapshot()));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === '/api/lobby/rooms') {
      return Response.json(this.snapshot());
    }

    // Report coming in from a RoomDO.
    if (url.pathname.endsWith('/update') && request.method === 'POST') {
      const { code, name, count, listed } = (await request.json()) as LobbyUpdate;
      // Every report carries `listed` today, but treating an absent one as true keeps the
      // older shape meaning what it used to: "this group is public, here is its count".
      if (listed === false) {
        // The owner made the group private. This is the only thing that unlists a group.
        this.sql.exec('DELETE FROM rooms WHERE code = ?', code);
      } else {
        // count=0 is a normal steady state now: an empty public group is still a group.
        this.sql.exec(
          'INSERT OR REPLACE INTO rooms (code, name, count, ts) VALUES (?, ?, ?, ?)',
          code,
          name ?? '',
          Math.max(0, count),
          Date.now(),
        );
      }
      this.broadcast();
      // The sweep only exists to correct a count nobody is refreshing, so it is only worth
      // scheduling while some group claims to have members.
      if (this.count(true) > 0) await this.ctx.storage.setAlarm(Date.now() + LOBBY_STALE_MS);
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketClose(): Promise<void> {
    // A lobby subscriber disconnecting needs no special handling (hibernation reclaims it automatically).
  }

  async alarm(): Promise<void> {
    // Fallback for a group whose DO stopped reporting while it still claimed members (a crash,
    // a lost report). It zeroes the count instead of dropping the row: with permanent groups a
    // stale row means "nobody is online right now", never "this group is gone", and deleting it
    // would make an idle public group vanish from the lobby ten minutes after its last message.
    const cutoff = Date.now() - LOBBY_STALE_MS;
    const stale = this.count(true, cutoff);
    if (stale > 0) {
      this.sql.exec('UPDATE rooms SET count = 0 WHERE ts < ? AND count > 0', cutoff);
      this.broadcast();
    }
    // Keep rescheduling only while some group still claims members, so idle rows don't spin the alarm forever.
    if (this.count(true) > 0) await this.ctx.storage.setAlarm(Date.now() + LOBBY_STALE_MS);
  }

  // -- Internals --

  /** Row count; `occupiedOnly` narrows it to groups that claim members, optionally only stale ones. */
  private count(occupiedOnly = false, staleBefore?: number): number {
    let sql = 'SELECT COUNT(*) AS n FROM rooms';
    const binds: unknown[] = [];
    if (occupiedOnly) sql += ' WHERE count > 0';
    if (staleBefore !== undefined) {
      sql += occupiedOnly ? ' AND ts < ?' : ' WHERE ts < ?';
      binds.push(staleBefore);
    }
    const row = this.sql.exec(sql, ...binds).one();
    return Number(row.n);
  }

  private snapshot(): { t: 'lobby'; rooms: LobbyRoom[] } {
    // Every row, including the empty ones: a public group is listed because it is public.
    const rows = this.sql
      .exec('SELECT code, name, count FROM rooms ORDER BY count DESC, name ASC')
      .toArray();
    return {
      t: 'lobby',
      rooms: rows.map((r) => ({
        code: r.code as string,
        name: r.name as string,
        count: Number(r.count),
      })),
    };
  }

  private broadcast(): void {
    const data = JSON.stringify(this.snapshot());
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }
}
