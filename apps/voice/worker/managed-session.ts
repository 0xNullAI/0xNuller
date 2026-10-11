import type { Env } from './env.js';
import {
  VoiceBillingOutbox,
  CHECKPOINT_MS,
  VOICE_CREDITS_PER_SEGMENT,
  VOICE_SEGMENT_MS,
  withBillingTimeout,
} from './voice-billing-outbox.js';

const UPSTREAM = 'https://api.x.ai/v1/realtime';
const DEFAULT_MODEL = 'grok-voice-think-fast-2.0';

/** One live connection per account; durable finalization outbox survives restarts. */
export class ManagedVoiceSession {
  private active = false;
  private ownedKey: string | null = null;
  private live: {
    subject: string;
    reservationKey: string;
    startedAt: number;
    deadline: number;
    reservedCredits: number;
  } | null = null;
  private closeActive: (() => Promise<void>) | null = null;
  private readonly billing: VoiceBillingOutbox;
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    this.billing = new VoiceBillingOutbox(state.storage, env.AUTH);
  }

  async fetch(request: Request): Promise<Response> {
    const ticket = request.headers.get('x-voice-ticket');
    const subject = request.headers.get('x-voice-subject');
    const reservationKey = request.headers.get('x-voice-reservation');
    const reservedCredits =
      Math.floor(
        positiveNumber(request.headers.get('x-voice-max-credits'), VOICE_CREDITS_PER_SEGMENT) /
          VOICE_CREDITS_PER_SEGMENT,
      ) * VOICE_CREDITS_PER_SEGMENT;
    if (!this.env.XAI_API_KEY) return new Response('upstream key not configured', { status: 503 });
    if (!ticket || !subject || !reservationKey)
      return new Response('missing account ticket', { status: 401 });
    if (reservedCredits < VOICE_CREDITS_PER_SEGMENT)
      return new Response('Credit 不足', { status: 402 });
    if (this.active) return new Response('该账户已有一个通话在进行中', { status: 409 });
    this.active = true;
    this.ownedKey = reservationKey;
    const clearCurrent = () => {
      if (this.ownedKey !== reservationKey) return;
      this.active = false;
      this.ownedKey = null;
      this.live = null;
      this.closeActive = null;
    };
    try {
      // Write recovery intent BEFORE the reservation RPC. A crash after the RPC
      // succeeds but before its response still leaves a durable release job.
      await this.billing.save({
        subject,
        reservationKey,
        phase: 'release',
        durationMs: 0,
        reservedCredits,
      });
    } catch {
      clearCurrent();
      return new Response('无法建立可恢复的语音会话', { status: 503 });
    }
    const release = async () => {
      clearCurrent();
      try {
        await this.billing.save({
          subject,
          reservationKey,
          phase: 'release',
          durationMs: 0,
          reservedCredits,
        });
        await this.billing.flush(() => this.ownedKey);
      } catch (error) {
        logFailure(error);
      }
    };
    let reservation: Awaited<ReturnType<Env['AUTH']['reserveVoiceCredits']>>;
    try {
      reservation = await withBillingTimeout(
        this.env.AUTH.reserveVoiceCredits(
          ticket,
          reservationKey,
          reservedCredits,
          ...(request.headers.has('x-voice-conversation')
            ? [
                {
                  conversationId: request.headers.get('x-voice-conversation')!,
                  runId: request.headers.get('x-voice-run') ?? '',
                },
              ]
            : []),
        ),
      );
    } catch {
      await release();
      return new Response('账户额度服务暂不可用', { status: 503 });
    }
    if (reservation === 'unauthorized' || !reservation.allowed) {
      clearCurrent();
      await this.billing.forget(reservationKey);
      return new Response(
        reservation === 'unauthorized'
          ? '账户票据无效或已过期'
          : reservation.status === 'rejected'
            ? '会话关联无效或不属于当前账户'
            : 'Credit 不足或请求重复',
        {
          status:
            reservation === 'unauthorized'
              ? 401
              : reservation.status === 'rejected'
                ? 403
                : reservation.status === 'insufficient'
                  ? 402
                  : 409,
        },
      );
    }
    let upstream: WebSocket | null = null;
    let server: WebSocket | null = null;
    let client: WebSocket;
    try {
      const response = await fetch(
        `${UPSTREAM}?model=${encodeURIComponent(this.env.MANAGED_MODEL || DEFAULT_MODEL)}`,
        {
          headers: {
            Upgrade: 'websocket',
            'Sec-WebSocket-Protocol': `realtime, openai-insecure-api-key.${this.env.XAI_API_KEY}`,
          },
          signal: AbortSignal.timeout(30_000),
        },
      );
      upstream = response.webSocket;
      if (!upstream) throw new Error('upstream did not upgrade');
      upstream.accept();
      [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
      server.accept();
    } catch {
      safeClose(server);
      safeClose(upstream);
      await release();
      return new Response('无法连接上游语音服务', { status: 502 });
    }
    const startedAt = Date.now();
    const maxMs = Math.max(
      1,
      Math.floor(
        Math.min(
          positiveNumber(this.env.MAX_SESSION_MINUTES, 20) * 60_000,
          (reservedCredits / VOICE_CREDITS_PER_SEGMENT) * VOICE_SEGMENT_MS,
          24 * 60 * 60 * 1000,
        ),
      ),
    );
    const live = {
      subject,
      reservationKey,
      startedAt,
      deadline: startedAt + maxMs,
      reservedCredits,
    };
    let finished = false;
    let established = false;
    let finishTask: Promise<void> | null = null;
    const finish = () => {
      if (finished) return finishTask ?? Promise.resolve();
      finished = true;
      clearCurrent();
      safeClose(server);
      safeClose(upstream);
      const durationMs = Math.max(1, Math.min(Date.now(), live.deadline) - startedAt);
      finishTask = this.billing
        .save({
          subject,
          reservationKey,
          phase: established ? 'settle' : 'release',
          durationMs: established ? durationMs : 0,
          reservedCredits,
        })
        .then(() => this.billing.flush(() => this.ownedKey));
      this.state.waitUntil(finishTask.catch(logFailure));
      return finishTask;
    };
    for (const socket of [server, upstream]) {
      socket.addEventListener('close', finish);
      socket.addEventListener('error', finish);
    }
    try {
      await this.billing.save({
        subject,
        reservationKey,
        phase: 'active',
        durationMs: 0,
        reservedCredits,
      });
      await this.state.storage.setAlarm(Math.min(live.deadline, Date.now() + CHECKPOINT_MS));
    } catch {
      finished = true;
      safeClose(server);
      safeClose(upstream);
      await release();
      return new Response('无法建立受限语音会话', { status: 503 });
    }
    if (finished) {
      await release();
      return new Response('上游在建立通话时关闭', { status: 502 });
    }
    established = true;
    this.live = live;
    this.closeActive = finish;
    server.addEventListener('message', (event) => safeSend(upstream!, event.data));
    upstream.addEventListener('message', (event) => safeSend(server!, event.data));
    return new Response(null, {
      status: 101,
      webSocket: client!,
      headers: { 'Sec-WebSocket-Protocol': 'realtime' },
    });
  }

  async alarm(): Promise<void> {
    const live = this.live;
    if (live) {
      if (Date.now() >= live.deadline) {
        await this.closeActive?.();
        return;
      }
      try {
        await this.billing.save({
          subject: live.subject,
          reservationKey: live.reservationKey,
          phase: 'active',
          durationMs: Math.max(0, Date.now() - live.startedAt),
          reservedCredits: live.reservedCredits,
        });
      } catch (error) {
        await this.closeActive?.();
        throw error;
      }
    } else if (this.active) {
      // An opening RPC is still in progress in this instance; it owns release.
      await this.state.storage.setAlarm(Date.now() + CHECKPOINT_MS);
      return;
    }
    await this.billing.flush(() => this.ownedKey);
    if (this.live)
      await this.state.storage.setAlarm(Math.min(this.live.deadline, Date.now() + CHECKPOINT_MS));
  }
}
function positiveNumber(value: string | null | undefined, fallback: number) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function safeSend(socket: WebSocket, data: string | ArrayBuffer) {
  try {
    socket.send(data);
  } catch {
    try {
      socket.close();
    } catch {
      /* already closed */
    }
  }
}
function safeClose(socket: WebSocket | null) {
  try {
    socket?.close();
  } catch {
    /* already closed */
  }
}
function logFailure(error: unknown) {
  console.error(JSON.stringify({ event: 'voice_credit_finalize_pending', error: String(error) }));
}
