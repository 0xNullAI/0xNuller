// Room WebSocket transport: connects to the Cloudflare RoomDO (/ws/room/:code), replacing
// the old public MQTT broker.
// One connection, ordered and reliable; on disconnect it reconnects automatically with
// exponential backoff, and on reconnect the caller re-sends hello from onOpen (the DO
// replays history again).

export type TransportStatus = 'connecting' | 'connected' | 'error';

export interface RoomConnectOptions {
  code: string;
  peerId: string;
  /** Fires every time the connection is ready (including reconnects); the caller should re-send hello here. */
  onOpen: () => void;
  onMessage: (data: Record<string, unknown>) => void;
  onStatus: (status: TransportStatus) => void;
}

export interface RoomTransport {
  send: (payload: object) => void;
  close: () => void;
}

function roomUrl(code: string, peerId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws/room/${encodeURIComponent(code)}?id=${encodeURIComponent(peerId)}`;
}

export function connectRoom(opts: RoomConnectOptions): RoomTransport {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let reconnectTimer: number | null = null;

  function open() {
    if (closed) return;
    opts.onStatus('connecting');
    const sock = new WebSocket(roomUrl(opts.code, opts.peerId));
    ws = sock;

    sock.onopen = () => {
      retry = 0;
      opts.onStatus('connected');
      opts.onOpen();
    };
    sock.onmessage = (e: MessageEvent) => {
      try {
        opts.onMessage(JSON.parse(e.data as string));
      } catch {
        /* malformed frame; ignore */
      }
    };
    sock.onclose = () => {
      if (!closed) scheduleReconnect();
    };
    sock.onerror = () => {
      // Triggers onclose → reconnect.
      sock.close();
    };
  }

  function scheduleReconnect() {
    opts.onStatus('connecting');
    const delay = Math.min(1000 * 2 ** retry, 10000);
    retry++;
    reconnectTimer = window.setTimeout(open, delay);
  }

  open();

  return {
    send(payload: object) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
      }
    },
    close() {
      closed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
      ws = null;
    },
  };
}
