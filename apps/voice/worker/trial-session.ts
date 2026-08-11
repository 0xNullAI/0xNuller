import type { Env } from './env.js';

const UPSTREAM = 'https://api.x.ai/v1/realtime';
const DEFAULT_MODEL = 'grok-voice-think-fast-1.0';

interface DailyUsage {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  /** Fractional minutes consumed on `day`. */
  minutes: number;
}

/**
 * One instance per account (`idFromName(accountId)`). It is the
 * single choke point where the trial spends real money, so it owns three
 * guarantees the frontend can't be trusted with:
 *   - concurrency: at most one live session per account (in-memory `active`,
 *     accurate because the DO stays resident while a socket is open);
 *   - a hard per-session length cap (a storage alarm force-closes overruns);
 *   - a per-account daily minute cap, atomically persisted by Auth in D1.
 * Only after those pass does it open the upstream xAI socket with the real
 * key and pipe frames both directions.
 */
export class TrialSession {
  private active = 0;
  private closeActive: (() => void) | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const maxSessionMinutes = numHeader(request, 'x-trial-max-session', 20);
    const realKey = this.env.XAI_API_KEY;
    const ticket = request.headers.get('x-voice-ticket');
    if (!realKey) return new Response('upstream key not configured', { status: 503 });
    if (!ticket) return new Response('missing account ticket', { status: 401 });

    if (this.active >= 1) {
      return new Response('该账户已有一个通话在进行中', { status: 409 });
    }
    // Reserve before the first external await. Durable Object requests may
    // interleave while waiting on network I/O; reserving afterwards lets two
    // simultaneous devices both observe `active === 0` and open paid sockets.
    this.active = 1;

    const today = utcDay(Date.now());
    // Open the upstream leg first — if xAI rejects, fail before accepting the
    // client so the browser surfaces a connection error rather than a socket
    // that opens then immediately dies.
    const model = this.env.TRIAL_MODEL || DEFAULT_MODEL;
    let upstream: WebSocket | null;
    try {
      const resp = await fetch(`${UPSTREAM}?model=${encodeURIComponent(model)}`, {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': `realtime, openai-insecure-api-key.${realKey}`,
        },
      });
      upstream = resp.webSocket;
    } catch {
      this.active = 0;
      return new Response('无法连接上游语音服务', { status: 502 });
    }
    if (!upstream) {
      this.active = 0;
      return new Response('上游未升级为 WebSocket', { status: 502 });
    }
    upstream.accept();

    let reserved: Awaited<ReturnType<Env['AUTH']['consumeVoiceTicket']>>;
    try {
      reserved = await this.env.AUTH.consumeVoiceTicket(ticket, 1);
    } catch {
      this.active = 0;
      safeClose(upstream);
      return new Response('账户额度服务暂不可用', { status: 503 });
    }
    if (reserved === 'unauthorized') {
      this.active = 0;
      safeClose(upstream);
      return new Response('账户票据无效或已过期', { status: 401 });
    }
    if (!reserved.allowed) {
      this.active = 0;
      safeClose(upstream);
      return new Response('今日语音体验额度已用完', { status: 429 });
    }

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();

    const startedAt = Date.now();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.active = Math.max(0, this.active - 1);
      this.closeActive = null;
      const minutes = Math.min(
        maxSessionMinutes,
        Math.max(1, Math.ceil((Date.now() - startedAt) / 60_000)),
      );
      // The first minute was reserved before the client socket was accepted.
      // Keep close fast, but register both writes with the runtime so eviction
      // cannot silently drop account billing or the local diagnostic counter.
      this.state.waitUntil(
        Promise.all([
          minutes > 1 ? this.env.AUTH.consumeVoiceTicket(ticket, minutes - 1) : Promise.resolve(),
          this.addMinutes(today, minutes),
          this.state.storage.deleteAlarm(),
        ])
          .then(() => undefined)
          .catch((error) => {
            console.error(
              JSON.stringify({ event: 'voice_usage_persist_failed', error: String(error) }),
            );
          }),
      );
      safeClose(server);
      safeClose(upstream);
    };
    this.closeActive = finish;

    server.addEventListener('message', (event) => safeSend(upstream, event.data));
    upstream.addEventListener('message', (event) => safeSend(server, event.data));
    server.addEventListener('close', finish);
    upstream.addEventListener('close', finish);
    server.addEventListener('error', finish);
    upstream.addEventListener('error', finish);

    // The session ends at whichever comes first: the per-session cap or the
    // remaining daily budget.
    // `remaining` is reported after the first minute reservation; that reserved
    // minute is still available to this call.
    const remainingDailyMs = Math.max(1, reserved.remaining + 1) * 60_000;
    const sessionMs = Math.min(maxSessionMinutes * 60_000, remainingDailyMs);
    try {
      await this.state.storage.setAlarm(Date.now() + sessionMs);
    } catch (error) {
      console.error(JSON.stringify({ event: 'voice_alarm_schedule_failed', error: String(error) }));
      finish();
      return new Response('无法建立受限语音会话', { status: 503 });
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'realtime' },
    });
  }

  /** Fires when a session hits its hard length / daily-budget cap. */
  async alarm(): Promise<void> {
    this.closeActive?.();
  }

  private async readUsage(today: string): Promise<DailyUsage> {
    const stored = await this.state.storage.get<DailyUsage>('usage');
    if (stored && stored.day === today) return stored;
    return { day: today, minutes: 0 };
  }

  private async addMinutes(today: string, minutes: number): Promise<void> {
    const current = await this.readUsage(today);
    await this.state.storage.put<DailyUsage>('usage', {
      day: today,
      minutes: current.minutes + minutes,
    });
  }
}

function numHeader(request: Request, name: string, fallback: number): number {
  const parsed = Number(request.headers.get(name));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function safeSend(socket: WebSocket, data: string | ArrayBuffer): void {
  try {
    socket.send(data);
  } catch {
    /* peer already gone — the close handler will tear down */
  }
}

function safeClose(socket: WebSocket): void {
  try {
    socket.close();
  } catch {
    /* already closed */
  }
}
