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
 * One instance per activation key (`idFromName(activationKey)`). It is the
 * single choke point where the trial spends real money, so it owns three
 * guarantees the frontend can't be trusted with:
 *   - concurrency: at most one live session per key (in-memory `active`,
 *     accurate because the DO stays resident while a socket is open);
 *   - a hard per-session length cap (a storage alarm force-closes overruns);
 *   - a rolling daily minute cap, persisted so it survives eviction.
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
    const dailyCapMinutes = numHeader(request, 'x-trial-daily-cap', 60);
    const realKey = this.env.XAI_API_KEY;
    if (!realKey) return new Response('upstream key not configured', { status: 503 });

    if (this.active >= 1) {
      return new Response('该激活密钥已有一个通话在进行中', { status: 409 });
    }

    const today = utcDay(Date.now());
    const usage = await this.readUsage(today);
    if (usage.minutes >= dailyCapMinutes) {
      return new Response('该激活密钥今日额度已用完', { status: 429 });
    }

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
      return new Response('无法连接上游语音服务', { status: 502 });
    }
    if (!upstream) return new Response('上游未升级为 WebSocket', { status: 502 });
    upstream.accept();

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();

    this.active += 1;
    const startedAt = Date.now();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.active = Math.max(0, this.active - 1);
      this.closeActive = null;
      const minutes = (Date.now() - startedAt) / 60_000;
      // Persist accounting off the critical close path.
      void this.addMinutes(today, minutes);
      void this.state.storage.deleteAlarm();
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
    const remainingDailyMs = Math.max(0, (dailyCapMinutes - usage.minutes) * 60_000);
    const sessionMs = Math.min(maxSessionMinutes * 60_000, remainingDailyMs);
    await this.state.storage.setAlarm(Date.now() + sessionMs);

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
