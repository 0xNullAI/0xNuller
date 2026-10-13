import {
  parsePriceTable,
  realtimeCredits,
  realtimeReservation,
  type RealtimeRoute,
} from '@0xnullai/ai-pricing';
import type { Env } from './env.js';
import { DoubaoRealtimeBridge } from './doubao-realtime.js';
import {
  VoiceBillingOutbox,
  CHECKPOINT_MS,
  withBillingTimeout,
  type VoiceBillingRecord,
} from './voice-billing-outbox.js';

// Workers open outbound WebSockets with fetch + Upgrade on the https:// URL.
const UPSTREAM = 'https://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
/** After hang-up, how long rounds that already spoke may take to report usage. */
export const USAGE_GRACE_MS = 20_000;
/** After `session.close`, how long to wait for the provider's acknowledgement. */
export const CLOSE_ACK_MS = 3_000;
/** End the call before reported usage can outgrow the hold. */
const CREDIT_CLOSE_RATIO = 0.9;

type ShutdownReason = 'hangup' | 'upstream' | 'deadline' | 'credit' | 'provider';

/** Longest call the hold can cover at the generous per-minute usage bound. */
export function holdMinutes(route: RealtimeRoute, reservedCredits: number): number {
  return reservedCredits / realtimeReservation(route, 1);
}

/** One live connection per account; durable finalization outbox survives restarts. */
export class ManagedVoiceSession {
  private active = false;
  private ownedKey: string | null = null;
  /** Calls that hung up but are still waiting for late usage; recovery must not settle them. */
  private draining = new Set<string>();
  private busyKeys = (): ReadonlySet<string> =>
    this.ownedKey === null ? this.draining : new Set([...this.draining, this.ownedKey]);
  private live: {
    subject: string;
    reservationKey: string;
    startedAt: number;
    deadline: number;
    reservedCredits: number;
    bridge: DoubaoRealtimeBridge;
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
    const reservedCredits = Math.floor(
      positiveNumber(request.headers.get('x-voice-max-credits'), 0),
    );
    const table = parsePriceTable(this.env.AI_PRICE_TABLE);
    const key = this.env.VOLC_SPEECH_API_KEY;
    if (!key || !table) return new Response('语音服务或价格尚未配置', { status: 503 });
    const route = table.realtime;
    if (!ticket || !subject || !reservationKey)
      return new Response('missing account ticket', { status: 401 });
    if (reservedCredits < 1) return new Response('Credit 不足', { status: 402 });
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
    const intent = (
      phase: VoiceBillingRecord['phase'],
      extra: Partial<VoiceBillingRecord> = {},
    ): VoiceBillingRecord => ({
      subject,
      reservationKey,
      phase,
      durationMs: 0,
      reservedCredits,
      ...extra,
    });
    try {
      // Write recovery intent BEFORE the reservation RPC. A crash after the RPC
      // succeeds but before its response still leaves a durable release job.
      await this.billing.save(intent('release'));
    } catch {
      clearCurrent();
      return new Response('无法建立可恢复的语音会话', { status: 503 });
    }
    const release = async () => {
      clearCurrent();
      try {
        await this.billing.save(intent('release'));
        await this.billing.flush(this.busyKeys);
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
      const response = await fetch(UPSTREAM, {
        headers: { Upgrade: 'websocket', 'X-Api-Key': key, 'X-Api-Connect-Id': reservationKey },
        signal: AbortSignal.timeout(30_000),
      });
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
          holdMinutes(route, reservedCredits) * 60_000,
          24 * 60 * 60 * 1000,
        ),
      ),
    );
    const bridge = new DoubaoRealtimeBridge(route.model);
    const live = {
      subject,
      reservationKey,
      startedAt,
      deadline: startedAt + maxMs,
      reservedCredits,
      bridge,
    };
    const usageFacts = (): Partial<VoiceBillingRecord> => ({
      usage: { ...bridge.usage },
      rounds: bridge.rounds,
      missingRounds: bridge.missingRounds,
      openRounds: bridge.pendingRounds,
    });
    let finished = false;
    let established = false;
    let upstreamClosed = false;
    let sessionClosed = false;
    // Set once the final intent is queued; later usage must not reopen the record.
    let finalQueued = false;
    let finishTask: Promise<void> | null = null;
    // Wakes waiters on every upstream event; shutdown waits on conditions, not fixed sleeps.
    let wake: () => void = () => undefined;
    const waitFor = (ready: () => boolean, timeoutMs: number) =>
      new Promise<void>((resolve) => {
        if (ready()) return resolve();
        const timer = setTimeout(done, timeoutMs);
        const previous = wake;
        function done() {
          clearTimeout(timer);
          wake = previous;
          resolve();
        }
        wake = () => {
          previous();
          if (ready()) done();
        };
      });
    const shutdown = (reason: ShutdownReason) => {
      if (finished) return finishTask ?? Promise.resolve();
      finished = true;
      // Still this call's until its final intent is durable, even after it stops being live.
      if (established) this.draining.add(reservationKey);
      clearCurrent();
      // The browser is gone or must go now; it gets nothing more from this call.
      safeClose(server);
      const endedAt = Math.min(Date.now(), live.deadline);
      const durationMs = Math.max(1, endedAt - startedAt);
      finishTask = (async () => {
        try {
          if (established) {
            // Durable first: if the object dies while draining, recovery bills reported
            // usage and treats the still-open rounds as missing.
            await this.billing.save(intent('active', { durationMs, ...usageFacts() }));
            if (!upstreamClosed && reason !== 'upstream' && bridge.ready) {
              // Rounds that already spoke report usage seconds later; muting keeps the
              // provider from timing out on missing audio while we wait for them.
              safeSend(upstream!, JSON.stringify({ type: 'input_audio_mute.commit' }));
              await waitFor(() => upstreamClosed || bridge.pendingRounds === 0, USAGE_GRACE_MS);
              if (!upstreamClosed) {
                safeSend(upstream!, JSON.stringify({ type: 'session.close' }));
                await waitFor(() => upstreamClosed || sessionClosed, CLOSE_ACK_MS);
              }
            }
          }
          safeClose(upstream);
          bridge.closeRounds();
          finalQueued = true;
          await this.billing.save(
            established
              ? intent('settle', { durationMs, ...usageFacts(), openRounds: 0 })
              : intent('release'),
          );
        } finally {
          // Saved or not, the durable record now stands for this call on its own.
          this.draining.delete(reservationKey);
        }
        await this.billing.flush(this.busyKeys);
      })();
      this.state.waitUntil(finishTask.catch(logFailure));
      return finishTask;
    };
    server.addEventListener('close', () => void shutdown('hangup'));
    server.addEventListener('error', () => void shutdown('hangup'));
    upstream.addEventListener('close', () => {
      upstreamClosed = true;
      wake();
      void shutdown('upstream');
    });
    upstream.addEventListener('error', () => {
      upstreamClosed = true;
      wake();
      void shutdown('upstream');
    });
    try {
      await this.billing.save(intent('active', usageFacts()));
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
    this.closeActive = () => shutdown('deadline');
    server.addEventListener('message', (event) => {
      if (finished || typeof event.data !== 'string' || event.data.length > 256_000) return;
      for (const message of bridge.fromClient(event.data)) safeSend(upstream!, message);
    });
    upstream.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      const result = bridge.fromUpstream(event.data);
      if (!finished) for (const message of result.client) safeSend(server!, message);
      if (result.closed) sessionClosed = true;
      wake();
      if (result.usage && !finalQueued) {
        // Keep reported usage durable as it arrives; a restart bills what was reported.
        this.billing
          .save(
            intent('active', { durationMs: Math.max(0, Date.now() - startedAt), ...usageFacts() }),
          )
          .catch(logFailure);
        if (
          !finished &&
          realtimeCredits(route, bridge.usage) >= reservedCredits * CREDIT_CLOSE_RATIO
        )
          void shutdown('credit');
      }
      if (result.closed) void shutdown('provider');
    });
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
          usage: { ...live.bridge.usage },
          rounds: live.bridge.rounds,
          missingRounds: live.bridge.missingRounds,
          openRounds: live.bridge.pendingRounds,
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
    await this.billing.flush(this.busyKeys);
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
