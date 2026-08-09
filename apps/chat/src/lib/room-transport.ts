// Room WebSocket transport: connects to the Cloudflare RoomDO (/ws/room/:code), replacing
// the old public MQTT broker.
// One connection, ordered and reliable; on disconnect it reconnects automatically with
// exponential backoff, and on reconnect the caller re-sends hello from onOpen (the DO
// replays history again).

import { apiWsUrl } from '@0xnullai/settings';

export type TransportStatus = 'connecting' | 'connected' | 'error';

export interface RoomConnectOptions {
  code: string;
  peerId: string;
  /**
   * Direct message: mint a fresh admission ticket for this connection.
   *
   * Present only on the DM path, and called again for **every reconnect** rather than
   * once at the start. That is what makes admission a repeated check against the live
   * follow graph instead of a gate you pass once: unfollow or block the other person and
   * the account service simply stops minting, so the next reconnect — which the backoff
   * below is always about to attempt — has nothing to present.
   *
   * Null means "not allowed, or nobody to ask". See the handling in open().
   */
  ticket?: () => Promise<string | null>;
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
  // Through apiWsUrl, not location.host: the Tauri WebView's origin is a
  // local scheme, so a same-origin ws:// dials tauri.localhost and the room
  // never connects. Android has no hot update, so that ships and stays.
  return apiWsUrl(
    `/ws/room/${encodeURIComponent(code)}?id=${encodeURIComponent(peerId)}`,
  );
}

/**
 * The DM endpoint takes no room code: the conversation id is inside the signed ticket,
 * so a client cannot ask for a conversation it was not admitted to. It is also why the
 * ticket rides in the query string — a WebSocket upgrade from a browser cannot carry an
 * Authorization header, and the Android shell can never hold the web domain's cookie.
 */
function dmUrl(ticket: string, peerId: string): string {
  return apiWsUrl(
    `/ws/dm?ticket=${encodeURIComponent(ticket)}&id=${encodeURIComponent(peerId)}`,
  );
}

export function connectRoom(opts: RoomConnectOptions): RoomTransport {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let reconnectTimer: number | null = null;

  async function open() {
    if (closed) return;
    opts.onStatus('connecting');

    let url: string;
    if (opts.ticket) {
      const ticket = await opts.ticket();
      // The caller may have torn the transport down while the mint was in flight.
      if (closed) return;
      if (!ticket) {
        // No ticket means either "you two are no longer allowed to talk" or "the account
        // service is having a bad minute", and the client cannot tell them apart —
        // deliberately, since a distinguishable answer makes a block detectable. So: report
        // the failure, and keep retrying on the same backoff. Giving up would turn a
        // thirty-second outage into a conversation that needs a reload to come back;
        // retrying costs one request every ten seconds at worst.
        //
        // Schedule first, then report: scheduleReconnect sets 'connecting', and the point
        // here is that the caller sees the failure rather than a spinner that never ends.
        scheduleReconnect();
        opts.onStatus('error');
        return;
      }
      url = dmUrl(ticket, opts.peerId);
    } else {
      url = roomUrl(opts.code, opts.peerId);
    }

    const sock = new WebSocket(url);
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
    reconnectTimer = window.setTimeout(() => void open(), delay);
  }

  void open();

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
