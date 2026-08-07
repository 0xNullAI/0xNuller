// 房间 WebSocket 传输：连 Cloudflare RoomDO（/ws/room/:code），替代原公共 MQTT broker。
// 单连接、有序可靠；断线自动指数退避重连，重连时由调用方在 onOpen 重发 hello（DO 会重新回放历史）。

export type TransportStatus = 'connecting' | 'connected' | 'error';

export interface RoomConnectOptions {
  code: string;
  peerId: string;
  /** 每次连接就绪（含重连）触发，调用方应在此重发 hello。 */
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
      // 触发 onclose → 重连。
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
