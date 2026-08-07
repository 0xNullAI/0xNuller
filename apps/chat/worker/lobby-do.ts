// LobbyDO：单例（idFromName("v1")）。公开房间注册表 + 实时推送。
// RoomDO 在成员进出 / 保活时 POST /update 上报；大厅页通过 /ws/lobby 实时订阅、/api/lobby/rooms 取快照。
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { RESERVED_ROOM_CODE, RESERVED_ROOM_NAME } from './wire';

/** 超过该时长未保活的房间视为下线（兜底，正常由 RoomDO count=0 主动移除）。 */
const LOBBY_STALE_MS = 45 * 1000;

/** 大厅常驻房间（pinned）：始终展示、不受保活/空房移除影响。 */
const PINNED_ROOMS: { code: string; name: string }[] = [
  { code: RESERVED_ROOM_CODE, name: RESERVED_ROOM_NAME },
];
const PINNED_CODES = new Set(PINNED_ROOMS.map(r => r.code));

interface LobbyRoom {
  code: string;
  name: string;
  count: number;
  /** 房间当前场景名（无场景则缺省），用于大厅标注角色扮演房。 */
  sceneName?: string;
}

export class LobbyDO extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS rooms (code TEXT PRIMARY KEY, name TEXT, count INTEGER, ts INTEGER)',
    );
    // 幂等迁移：已存在的单例旧表补上 scene_name / pinned 列（重复执行会抛错，忽略即可）。
    try {
      this.sql.exec('ALTER TABLE rooms ADD COLUMN scene_name TEXT');
    } catch {
      /* 列已存在 */
    }
    try {
      this.sql.exec('ALTER TABLE rooms ADD COLUMN pinned INTEGER DEFAULT 0');
    } catch {
      /* 列已存在 */
    }
    // 播种常驻房：不存在则建（count=0），并确保 pinned=1（旧行可能 pinned=0）。
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

    // 来自 RoomDO 的上报。
    if (url.pathname.endsWith('/update') && request.method === 'POST') {
      const { code, name, count, sceneName } = (await request.json()) as LobbyRoom;
      const pinned = PINNED_CODES.has(code) ? 1 : 0;
      if (count > 0) {
        this.sql.exec(
          'INSERT OR REPLACE INTO rooms (code, name, count, ts, scene_name, pinned) VALUES (?, ?, ?, ?, ?, ?)',
          code,
          (pinned ? RESERVED_ROOM_NAME : name) ?? '',
          count,
          Date.now(),
          sceneName ?? null,
          pinned,
        );
      } else if (pinned) {
        // 常驻房空置：保留行，仅清零人数与场景。
        this.sql.exec(
          'UPDATE rooms SET count = 0, scene_name = ?, ts = ? WHERE code = ?',
          sceneName ?? null,
          Date.now(),
          code,
        );
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
    // 大厅订阅者断开无需特殊处理（Hibernation 自动回收）。
  }

  async alarm(): Promise<void> {
    // 清理过期房间（兜底），有变化则推送；仍有房间则继续排程。
    const cutoff = Date.now() - LOBBY_STALE_MS;
    const before = this.count();
    this.sql.exec('DELETE FROM rooms WHERE ts < ? AND pinned = 0', cutoff);
    if (this.count() !== before) this.broadcast();
    // 仅当还有非常驻房需要兜底过期时继续排程，避免常驻房导致 alarm 永久空转。
    if (this.count(true) > 0) await this.ctx.storage.setAlarm(Date.now() + LOBBY_STALE_MS);
  }

  // —— 内部 ——

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
        'SELECT code, name, count, scene_name FROM rooms WHERE ts >= ? OR pinned = 1 ORDER BY pinned DESC, count DESC, name ASC',
        cutoff,
      )
      .toArray();
    return {
      t: 'lobby',
      rooms: rows.map(r => ({
        code: r.code as string,
        name: r.name as string,
        count: Number(r.count),
        sceneName: (r.scene_name as string | null) ?? undefined,
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
