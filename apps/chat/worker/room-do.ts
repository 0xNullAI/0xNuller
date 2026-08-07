// RoomDO：每个房间一个实例（idFromName(roomCode)）。
// 职责：WebSocket relay（替代公共 MQTT broker）+ 连接级 presence + 聊天历史(SQLite) 持久化与回放
//       + 公开房间向 LobbyDO 上报 + 房间空置后宽限清理（历史 + R2 媒体 + 大厅注销）。
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';
import { deleteRoomMedia } from './media';
import { LOBBY_NAME, ROOM_GRACE_MS, RESERVED_ROOM_CODE, RESERVED_ROOM_NAME, type WireChat, type Scene } from './wire';

interface Attachment {
  peerId: string;
  name: string;
}

/** 公开房间向大厅保活的最小间隔（毫秒）。 */
const LOBBY_KEEPALIVE_MS = 20 * 1000;

export class RoomDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private lastLobbyReport = 0;
  // 场景 / 角色认领的内存缓存（storage 持久；hibernation 唤醒后惰性重载）。
  private sceneCache: Scene | null | undefined;
  private assignmentsCache: Record<string, string> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(
      'CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, from_id TEXT, name TEXT, body TEXT, ts INTEGER)',
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const url = new URL(request.url);
    const code = url.searchParams.get('code') ?? '';
    const peerId = url.searchParams.get('id') || crypto.randomUUID();
    await this.ctx.storage.put('code', code);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ peerId, name: '' } satisfies Attachment);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;
    const t = msg.t as string;

    switch (t) {
      case 'hello': {
        att.name = (msg.name as string) ?? '';
        ws.serializeAttachment(att);
        const helloCode = (await this.ctx.storage.get<string>('code')) ?? '';
        const reserved = helloCode === RESERVED_ROOM_CODE;
        if (msg.public || reserved) {
          await this.ctx.storage.put('public', true);
          await this.ctx.storage.put(
            'roomName',
            reserved ? RESERVED_ROOM_NAME : (msg.roomName as string) || att.name || '',
          );
        }
        // 房主 = 第一个加入者。常驻讨论房无房主（纯开放聊天），不指派并清除任何残留。
        let host = '';
        if (reserved) {
          await this.ctx.storage.delete('hostPeerId');
        } else {
          host = (await this.ctx.storage.get<string>('hostPeerId')) ?? '';
          if (!host) {
            host = att.peerId;
            await this.ctx.storage.put('hostPeerId', host);
          }
        }
        // 回放历史给该连接（含此前全部消息与媒体引用）。
        ws.send(JSON.stringify({ t: 'history', messages: this.loadHistory() }));
        // 同步当前场景 + 房主 + 角色认领状态。
        ws.send(JSON.stringify({ t: 'scene', scene: await this.getScene(), host }));
        ws.send(JSON.stringify({ t: 'role', assignments: await this.getAssignments() }));
        // 通知其他成员有人加入。
        this.broadcast({ t: 'sys', kind: 'joined', peerId: att.peerId }, ws);
        await this.reportLobby(this.ctx.getWebSockets().length);
        return;
      }

      case 'chat': {
        const scene = await this.getScene();
        const assignments = await this.getAssignments();
        // 房主可代某个 AI 托管角色发言（校验：sender=host 且该角色确为 AI 托管）。
        const aiAs = await this.aiSenderOk(att.peerId, msg.as, assignments);
        const fromId = aiAs ?? att.peerId;
        const chat: WireChat = {
          id: (msg.id as string) ?? crypto.randomUUID(),
          _from: fromId,
          n: (msg.n as string) || att.name,
          x: msg.x as string | undefined,
          m: msg.m as WireChat['m'],
          mentions: msg.mentions as WireChat['mentions'],
          senderRole: this.roleNameOf(fromId, scene, assignments),
          ts: (msg.ts as number) ?? Date.now(),
        };
        this.saveMessage(chat);
        // 普通消息：发送者已有乐观副本，广播时排除自己；
        // AI 代发消息：房主本地无副本，需广播给所有人（含房主）。
        this.broadcast({ t: 'chat', ...chat }, aiAs ? undefined : ws);
        return;
      }

      case 'scene': {
        // 仅房主可设/改场景。换场景会清空角色认领（角色 id 变了）。
        const host = await this.ctx.storage.get<string>('hostPeerId');
        if (att.peerId !== host) return;
        const scene = (msg.scene as Scene | null) ?? null;
        this.sceneCache = scene;
        await this.ctx.storage.put('scene', scene);
        await this.setAssignments({});
        this.broadcast({ t: 'scene', scene, host });
        this.broadcast({ t: 'role', assignments: {} });
        // 即时刷新大厅，让场景名（或清除）立刻反映到公开房间卡片。
        await this.reportLobby(this.ctx.getWebSockets().length);
        return;
      }

      case 'role': {
        // 认领/释放（人）；托管/取消（AI，仅房主）。一人最多一个角色；AI 占位为 "ai:<roleId>"。
        const act = msg.act as 'claim' | 'release' | 'assign-ai' | 'release-ai';
        const roleId = msg.roleId as string;
        const assignments = { ...(await this.getAssignments()) };
        const aiHolder = `ai:${roleId}`;
        if (act === 'assign-ai' || act === 'release-ai') {
          const host = await this.ctx.storage.get<string>('hostPeerId');
          if (att.peerId !== host) return; // 仅房主可托管/取消 AI
          if (act === 'assign-ai') {
            const role = (await this.getScene())?.roles.find(r => r.id === roleId);
            if (!role?.aiPlayable) return; // 仅 aiPlayable 角色可交给 AI
            assignments[roleId] = aiHolder; // 覆盖现有占用
          } else if (assignments[roleId] === aiHolder) {
            delete assignments[roleId];
          }
        } else if (act === 'claim') {
          if (assignments[roleId]?.startsWith('ai:')) return; // AI 占用的角色，需房主先取消 AI
          for (const [rid, pid] of Object.entries(assignments)) {
            if (pid === att.peerId) delete assignments[rid];
          }
          if (!assignments[roleId]) assignments[roleId] = att.peerId;
        } else if (assignments[roleId] === att.peerId) {
          delete assignments[roleId];
        }
        await this.setAssignments(assignments);
        this.broadcast({ t: 'role', assignments });
        return;
      }

      case 'cmd':
      case 'wave': {
        // 定向转发给目标 peer。房主可代 AI 托管角色操作（_from = ai:<roleId>，供设备端授权校验）。
        const aiAs = await this.aiSenderOk(att.peerId, msg.as, await this.getAssignments());
        this.sendTo(msg.to as string, { ...msg, _from: aiAs ?? att.peerId });
        return;
      }

      case 'leave': {
        this.broadcast({ t: 'sys', kind: 'left', peerId: att.peerId }, ws);
        return;
      }

      default: {
        // sf / ss / presence：广播给房间其他人，注入可信 _from。
        this.broadcast({ ...msg, _from: att.peerId }, ws);
        // 借 presence 心跳给大厅保活（节流），避免有人在线却被判过期移除。
        if (t === 'presence') {
          const now = Date.now();
          if (now - this.lastLobbyReport >= LOBBY_KEEPALIVE_MS) {
            this.lastLobbyReport = now;
            await this.reportLobby(this.ctx.getWebSockets().length);
          }
        }
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.onDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.onDisconnect(ws);
  }

  async alarm(): Promise<void> {
    // 宽限期到：若仍无人在线，彻底清理房间。否则有人重连，取消清理。
    if (this.ctx.getWebSockets().length > 0) return;
    const code = (await this.ctx.storage.get<string>('code')) ?? '';
    // 常驻讨论房永不清理：保留历史，仅上报空闲（大厅由 pinned 兜底保留）。
    if (code === RESERVED_ROOM_CODE) {
      await this.reportLobby(0);
      return;
    }
    this.sql.exec('DELETE FROM messages');
    if (code) await deleteRoomMedia(this.env, code);
    await this.reportLobby(0);
    await this.ctx.storage.deleteAll();
  }

  // —— 内部 ——

  private async onDisconnect(ws: WebSocket): Promise<void> {
    let att: Attachment | undefined;
    try {
      att = ws.deserializeAttachment() as Attachment;
    } catch {
      att = undefined;
    }
    const remaining = this.ctx.getWebSockets().filter(w => w !== ws);
    if (att) {
      this.broadcast({ t: 'sys', kind: 'left', peerId: att.peerId }, ws);
      // 释放该成员认领的角色，广播更新。
      const assignments = { ...(await this.getAssignments()) };
      let changed = false;
      for (const [rid, pid] of Object.entries(assignments)) {
        if (pid === att.peerId) {
          delete assignments[rid];
          changed = true;
        }
      }
      if (changed) {
        await this.setAssignments(assignments);
        this.broadcast({ t: 'role', assignments }, ws);
      }
    }
    await this.reportLobby(remaining.length);
    if (remaining.length === 0) {
      // 房间空：保留历史一个宽限期，期间无人重连则由 alarm 清理。
      await this.ctx.storage.setAlarm(Date.now() + ROOM_GRACE_MS);
    }
  }

  private broadcast(payload: unknown, except?: WebSocket): void {
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(data);
      } catch {
        /* socket gone; ignore */
      }
    }
  }

  private sendTo(toPeerId: string, payload: unknown): void {
    if (!toPeerId) return;
    const data = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.peerId === toPeerId) {
        try {
          ws.send(data);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private saveMessage(chat: WireChat): void {
    this.sql.exec(
      'INSERT OR REPLACE INTO messages (id, from_id, name, body, ts) VALUES (?, ?, ?, ?, ?)',
      chat.id,
      chat._from ?? '',
      chat.n,
      JSON.stringify({ x: chat.x, m: chat.m, mentions: chat.mentions, senderRole: chat.senderRole }),
      chat.ts,
    );
  }

  private loadHistory(): WireChat[] {
    const rows = this.sql
      .exec('SELECT id, from_id, name, body, ts FROM messages ORDER BY ts ASC, id ASC')
      .toArray();
    return rows.map(r => {
      const body = JSON.parse(r.body as string) as {
        x?: string;
        m?: WireChat['m'];
        mentions?: WireChat['mentions'];
        senderRole?: string;
      };
      return {
        id: r.id as string,
        _from: r.from_id as string,
        n: r.name as string,
        x: body.x,
        m: body.m,
        mentions: body.mentions,
        senderRole: body.senderRole,
        ts: r.ts as number,
      };
    });
  }

  // —— 场景 / 角色认领 ——

  private async getScene(): Promise<Scene | null> {
    if (this.sceneCache === undefined) {
      this.sceneCache = (await this.ctx.storage.get<Scene>('scene')) ?? null;
    }
    return this.sceneCache;
  }

  private async getAssignments(): Promise<Record<string, string>> {
    if (this.assignmentsCache === undefined) {
      this.assignmentsCache = (await this.ctx.storage.get<Record<string, string>>('roleAssignments')) ?? {};
    }
    return this.assignmentsCache;
  }

  private async setAssignments(a: Record<string, string>): Promise<void> {
    this.assignmentsCache = a;
    await this.ctx.storage.put('roleAssignments', a);
  }

  /** 查某成员当前认领角色的名字（= 头衔）。AI 占位 "ai:<roleId>" 同样可解析。 */
  private roleNameOf(peerId: string, scene: Scene | null, assignments: Record<string, string>): string | undefined {
    if (!scene) return undefined;
    const entry = Object.entries(assignments).find(([, pid]) => pid === peerId);
    if (!entry) return undefined;
    return scene.roles.find(r => r.id === entry[0])?.name;
  }

  /**
   * 校验「房主代某 AI 托管角色发言/操作」是否合法。
   * 合法返回该 AI 占位 id（"ai:<roleId>"），否则 null。
   * 条件：as 形如 ai:<roleId>、发送者为房主、且该角色当前确为 AI 托管。
   */
  private async aiSenderOk(
    senderPeerId: string,
    as: unknown,
    assignments: Record<string, string>,
  ): Promise<string | null> {
    if (typeof as !== 'string' || !as.startsWith('ai:')) return null;
    const host = await this.ctx.storage.get<string>('hostPeerId');
    if (senderPeerId !== host) return null;
    const roleId = as.slice(3);
    return assignments[roleId] === as ? as : null;
  }

  /** 仅公开房间上报大厅；count=0 表示房间空，从大厅移除。 */
  private async reportLobby(count: number): Promise<void> {
    const isPublic = await this.ctx.storage.get<boolean>('public');
    if (!isPublic) return;
    const code = (await this.ctx.storage.get<string>('code')) ?? '';
    const name = (await this.ctx.storage.get<string>('roomName')) ?? '';
    if (!code) return;
    const sceneName = (await this.getScene())?.name || undefined;
    const stub = this.env.LOBBY.get(this.env.LOBBY.idFromName(LOBBY_NAME));
    await stub.fetch('https://lobby/update', {
      method: 'POST',
      body: JSON.stringify({ code, name, count, sceneName }),
    });
  }
}
