// 大厅客户端：订阅 /ws/lobby 实时获取公开房间列表，断线自动重连；REST 兜底首屏。
export interface LobbyRoom {
  code: string;
  name: string;
  count: number;
  /** 房间当前场景名（角色扮演房才有）。 */
  sceneName?: string;
}

export type LobbyStatus = 'connecting' | 'connected' | 'error';

export interface LobbySubscription {
  close(): void;
}

function lobbyWsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/lobby`;
}

export function subscribeLobby(
  onRooms: (rooms: LobbyRoom[]) => void,
  onStatus?: (status: LobbyStatus) => void,
): LobbySubscription {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let timer: number | null = null;

  function open() {
    if (closed) return;
    onStatus?.('connecting');
    const sock = new WebSocket(lobbyWsUrl());
    ws = sock;
    sock.onopen = () => {
      retry = 0;
      onStatus?.('connected');
    };
    sock.onmessage = (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data as string) as { t?: string; rooms?: LobbyRoom[] };
        if (data.t === 'lobby' && Array.isArray(data.rooms)) onRooms(data.rooms);
      } catch {
        /* ignore */
      }
    };
    sock.onclose = () => {
      if (closed) return;
      onStatus?.('connecting');
      const delay = Math.min(1000 * 2 ** retry, 10000);
      retry++;
      timer = window.setTimeout(open, delay);
    };
    sock.onerror = () => sock.close();
  }

  open();

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    },
  };
}

/** REST 快照（首屏兜底，WS 未连上时先有内容）。 */
export async function fetchLobbyRooms(): Promise<LobbyRoom[]> {
  const res = await fetch('/api/lobby/rooms');
  if (!res.ok) return [];
  const data = (await res.json()) as { rooms?: LobbyRoom[] };
  return data.rooms ?? [];
}
