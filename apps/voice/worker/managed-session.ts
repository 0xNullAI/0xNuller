import type { Env } from './env.js';

const UPSTREAM = 'https://api.x.ai/v1/realtime';
const DEFAULT_MODEL = 'grok-voice-think-fast-2.0';
const CREDIT_PER_SEGMENT = 20;
const SEGMENT_MS = 10_000;

/** One instance per account: one paid realtime connection and one Credit reservation. */
export class ManagedVoiceSession {
  private active = 0;
  private closeActive: (() => void) | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const realKey = this.env.XAI_API_KEY;
    const ticket = request.headers.get('x-voice-ticket');
    const reservationKey = request.headers.get('x-voice-reservation');
    const requestedCredits = positiveNumber(
      request.headers.get('x-voice-max-credits'),
      CREDIT_PER_SEGMENT,
    );
    const reservedCredits = Math.floor(requestedCredits / CREDIT_PER_SEGMENT) * CREDIT_PER_SEGMENT;
    if (!realKey) return new Response('upstream key not configured', { status: 503 });
    if (!ticket || !reservationKey) return new Response('missing account ticket', { status: 401 });
    if (reservedCredits < CREDIT_PER_SEGMENT) return new Response('Credit 不足', { status: 402 });
    if (this.active >= 1) return new Response('该账户已有一个通话在进行中', { status: 409 });
    this.active = 1;

    let reservation: Awaited<ReturnType<Env['AUTH']['reserveVoiceCredits']>>;
    try {
      reservation = await this.env.AUTH.reserveVoiceCredits(
        ticket,
        reservationKey,
        reservedCredits,
      );
    } catch {
      this.active = 0;
      return new Response('账户额度服务暂不可用', { status: 503 });
    }
    if (reservation === 'unauthorized') {
      this.active = 0;
      return new Response('账户票据无效或已过期', { status: 401 });
    }
    if (!reservation.allowed) {
      this.active = 0;
      return new Response(
        reservation.status === 'insufficient' ? 'Credit 不足' : '通话请求已提交',
        { status: reservation.status === 'insufficient' ? 402 : 409 },
      );
    }

    const model = this.env.MANAGED_MODEL || DEFAULT_MODEL;
    let upstream: WebSocket | null;
    try {
      const response = await fetch(`${UPSTREAM}?model=${encodeURIComponent(model)}`, {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': `realtime, openai-insecure-api-key.${realKey}`,
        },
      });
      upstream = response.webSocket;
    } catch {
      await this.env.AUTH.releaseVoiceCredits(ticket, reservationKey);
      this.active = 0;
      return new Response('无法连接上游语音服务', { status: 502 });
    }
    if (!upstream) {
      await this.env.AUTH.releaseVoiceCredits(ticket, reservationKey);
      this.active = 0;
      return new Response('上游未升级为 WebSocket', { status: 502 });
    }
    upstream.accept();

    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    server.accept();
    const startedAt = Date.now();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      this.active = Math.max(0, this.active - 1);
      this.closeActive = null;
      const durationMs = Math.max(1, Date.now() - startedAt);
      const charged = Math.min(
        reservedCredits,
        Math.max(CREDIT_PER_SEGMENT, Math.ceil(durationMs / SEGMENT_MS) * CREDIT_PER_SEGMENT),
      );
      this.state.waitUntil(
        Promise.all([
          this.env.AUTH.settleVoiceCredits(ticket, reservationKey, charged, durationMs),
          this.state.storage.deleteAlarm(),
        ])
          .then(() => undefined)
          .catch((error) => {
            console.error(
              JSON.stringify({ event: 'voice_credit_settle_failed', error: String(error) }),
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

    const configuredMaxMs = positiveNumber(this.env.MAX_SESSION_MINUTES, 20) * 60_000;
    const creditMaxMs = (reservedCredits / CREDIT_PER_SEGMENT) * SEGMENT_MS;
    try {
      await this.state.storage.setAlarm(Date.now() + Math.min(configuredMaxMs, creditMaxMs));
    } catch {
      settled = true;
      this.active = 0;
      this.closeActive = null;
      await this.env.AUTH.releaseVoiceCredits(ticket, reservationKey);
      safeClose(server);
      safeClose(upstream);
      return new Response('无法建立受限语音会话', { status: 503 });
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'realtime' },
    });
  }

  async alarm(): Promise<void> {
    this.closeActive?.();
  }
}

function positiveNumber(value: string | null | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function safeSend(socket: WebSocket, data: string | ArrayBuffer): void {
  try {
    socket.send(data);
  } catch {
    // The close event owns final settlement.
  }
}

function safeClose(socket: WebSocket): void {
  try {
    socket.close();
  } catch {
    // Already closed.
  }
}
