// LobbyDO: a singleton (idFromName("v1")). Public room registry + live push.
// RoomDO reports in with POST /update when members join/leave or on keepalive; the lobby page subscribes live over /ws/lobby and pulls a snapshot from /api/lobby/rooms.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { RESERVED_ROOM_CODE, RESERVED_ROOM_NAME } from './wire';

/** A room with no keepalive for longer than this is treated as offline (a fallback; normally RoomDO removes it actively with count=0). */
const LOBBY_STALE_MS = 45 * 1000;

/** Permanent lobby rooms (pinned): always shown, immune to keepalive expiry / empty-room removal. */
const PINNED_ROOMS: { code: string; name: string }[] = [
  { code: RESERVED_ROOM_CODE, name: RESERVED_ROOM_NAME },
];
const PINNED_CODES = new Set(PINNED_ROOMS.map(r => r.code));

interface LobbyRoom {
  code: string;
  name: string;
  count: number;
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
    try {
      this.sql.exec('ALTER TABLE rooms ADD COLUMN pinned INTEGER DEFAULT 0');
    } catch {
      /* column already exists */
    }
    // Seed the permanent rooms: create them if missing (count=0), and force pinned=1 (old rows may have pinned=0).
    for (const r of PINNED_ROOMS) {
      this.sql.exec(
        'INSERT OR IGNORE INTO rooms (code, name, count, ts, pinned) VALUES (?, ?, 0, ?, 1)',
        r.code,
        r.name,
        Date.now(),
      );
      this.sql.exec('UPDATE rooms SET pinned = 1, name = ? WHERE code = ?', r.name, r.code);
    }
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
      const { code, name, count } = (await request.json()) as LobbyRoom;
      const pinned = PINNED_CODES.has(code) ? 1 : 0;
      if (count > 0) {
        this.sql.exec(
          'INSERT OR REPLACE INTO rooms (code, name, count, ts, pinned) VALUES (?, ?, ?, ?, ?)',
          code,
          (pinned ? RESERVED_ROOM_NAME : name) ?? '',
          count,
          Date.now(),
          pinned,
        );
      } else if (pinned) {
        // Permanent room went empty: keep the row, just zero out the member count.
        this.sql.exec('UPDATE rooms SET count = 0, ts = ? WHERE code = ?', Date.now(), code);
      } else {
        this.sql.exec('DELETE FROM rooms WHERE code = ?', code);
      }
      this.broadcast();
      await this.ctx.storage.setAlarm(Date.now() + LOBBY_STALE_MS);
      return new Response('ok');
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketClose(): Promise<void> {
    // A lobby subscriber disconnecting needs no special handling (hibernation reclaims it automatically).
  }

  async alarm(): Promise<void> {
    // Sweep expired rooms (fallback), push if anything changed; keep rescheduling while rooms remain.
    const cutoff = Date.now() - LOBBY_STALE_MS;
    const before = this.count();
    this.sql.exec('DELETE FROM rooms WHERE ts < ? AND pinned = 0', cutoff);
    if (this.count() !== before) this.broadcast();
    // Only reschedule while there are non-pinned rooms that still need the expiry fallback, so the pinned rooms don't keep the alarm spinning forever.
    if (this.count(true) > 0) await this.ctx.storage.setAlarm(Date.now() + LOBBY_STALE_MS);
  }

  // -- Internals --

  private count(excludePinned = false): number {
    const sql = excludePinned
      ? 'SELECT COUNT(*) AS n FROM rooms WHERE pinned = 0'
      : 'SELECT COUNT(*) AS n FROM rooms';
    const row = this.sql.exec(sql).one();
    return Number(row.n);
  }

  private snapshot(): { t: 'lobby'; rooms: LobbyRoom[] } {
    const cutoff = Date.now() - LOBBY_STALE_MS;
    const rows = this.sql
      .exec(
        'SELECT code, name, count FROM rooms WHERE ts >= ? OR pinned = 1 ORDER BY pinned DESC, count DESC, name ASC',
        cutoff,
      )
      .toArray();
    return {
      t: 'lobby',
      rooms: rows.map(r => ({
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
