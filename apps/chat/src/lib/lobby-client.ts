// Lobby client: subscribes to /ws/lobby for a live public room list and reconnects automatically
// on disconnect; REST covers the first paint.

import { apiBaseUrl, apiWsUrl } from '@0xnullai/settings';
export interface LobbyRoom {
  code: string;
  name: string;
  count: number;
}

export type LobbyStatus = 'connecting' | 'connected' | 'error';

export interface LobbySubscription {
  close(): void;
}

const LEGACY_DISCUSSION_CODE = '0xNullAI';

function currentRooms(rooms: LobbyRoom[]): LobbyRoom[] {
  return rooms.filter((room) => room.code !== LEGACY_DISCUSSION_CODE);
}

function lobbyWsUrl(): string {
  // See room-transport: same-origin resolves to the WebView's own scheme
  // inside the Android shell.
  return apiWsUrl('/ws/lobby');
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
        if (data.t === 'lobby' && Array.isArray(data.rooms)) onRooms(currentRooms(data.rooms));
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

/** REST snapshot (first-paint fallback, so there is content before the WS connects). */
export async function fetchLobbyRooms(): Promise<LobbyRoom[]> {
  const res = await fetch(`${apiBaseUrl()}/api/lobby/rooms`);
  if (!res.ok) return [];
  const data = (await res.json()) as { rooms?: LobbyRoom[] };
  return currentRooms(data.rooms ?? []);
}
