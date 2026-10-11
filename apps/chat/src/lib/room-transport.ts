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
   * A direct message connects to `/ws/dm` with its ticket; a group to `/ws/room/:code`.
   * Stated by the caller: both paths now carry tickets, so the code cannot tell them apart.
   */
  dm: boolean;
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
  send: (payload: object) => boolean;
  close: () => void;
}

function roomUrl(code: string, peerId: string, ticket: string): string {
  // Through apiWsUrl, not location.host: the Tauri WebView's origin is a
  // local scheme, so a same-origin ws:// dials tauri.localhost and the room
  // never connects. Android has no hot update, so that ships and stays.
  return apiWsUrl(
    `/ws/room/${encodeURIComponent(code)}?id=${encodeURIComponent(peerId)}&ticket=${encodeURIComponent(ticket)}`,
  );
}

/**
 * The DM endpoint takes no room code: the conversation id is inside the signed ticket,
 * so a client cannot ask for a conversation it was not admitted to. It is also why the
 * ticket rides in the query string — a WebSocket upgrade from a browser cannot carry an
 * Authorization header, and the Android shell can never hold the web domain's cookie.
 */
function dmUrl(ticket: string, peerId: string): string {
  return apiWsUrl(`/ws/dm?ticket=${encodeURIComponent(ticket)}&id=${encodeURIComponent(peerId)}`);
}

/**
 * Admission tickets live 60 s and the server caps a socket's lease at 65 s. Renewing every
 * 25 s keeps the same socket alive across one failed mint without ever reconnecting.
 */
const LEASE_RENEW_INTERVAL_MS = 25_000;

export function connectRoom(opts: RoomConnectOptions): RoomTransport {
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let reconnectTimer: number | null = null;
  let renewTimer: number | null = null;

  function stopRenewing() {
    if (renewTimer !== null) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
  }

  /**
   * Starts in-place lease renewal, only after this socket's server said it supports it:
   * an older server relays unknown frames to the room and would expose the ticket.
   */
  function startRenewing(sock: WebSocket) {
    stopRenewing();
    const mint = opts.ticket;
    if (!mint) return;
    renewTimer = window.setInterval(() => {
      void mint()
        .catch(() => null)
        .then((ticket) => {
          if (!ticket || closed || ws !== sock || sock.readyState !== WebSocket.OPEN) return;
          try {
            sock.send(JSON.stringify({ t: 'renew', ticket }));
          } catch {
            /* the close handler reconnects */
          }
        });
    }, LEASE_RENEW_INTERVAL_MS);
  }

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
      url = opts.dm ? dmUrl(ticket, opts.peerId) : roomUrl(opts.code, opts.peerId, ticket);
    } else {
      scheduleReconnect();
      opts.onStatus('error');
      return;
    }

    const sock = new WebSocket(url);
    ws = sock;

    sock.onopen = () => {
      retry = 0;
      opts.onStatus('connected');
      opts.onOpen();
    };
    sock.onmessage = (e: MessageEvent) => {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(e.data as string);
      } catch {
        return; /* malformed frame; ignore */
      }
      if (data?.t === 'media-auth' && data.renew === true && ws === sock) startRenewing(sock);
      try {
        opts.onMessage(data);
      } catch {
        /* a handler error must not break the socket */
      }
    };
    sock.onclose = () => {
      if (ws === sock) stopRenewing();
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
        try {
          ws.send(JSON.stringify(payload));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    },
    close() {
      closed = true;
      stopRenewing();
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
