// Managed realtime voice endpoint. Account tickets and Credit reservations are
// validated server-side; the upstream key never reaches the client.
import { parsePriceTable, realtimeReservation } from '@0xnullai/ai-pricing';
import type { Env } from './env.js';
import { isAllowedOrigin, parseVoiceTicket } from './managed-auth.js';
import { withServerErrorCounting } from '@0xnullai/observability';

export { ManagedVoiceSession } from './managed-session.js';

const voiceWorker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/api/realtime') return new Response('not found', { status: 404 });
    return handleManagedRealtime(request, env);
  },
};

export default withServerErrorCounting(voiceWorker, {
  worker: 'voice',
  // Older test fakes and Auth deployments may lack the method; counting then just stops.
  sink: (env: Env) =>
    env.AUTH.recordServerErrors
      ? { recordServerErrors: (report) => env.AUTH.recordServerErrors!(report) }
      : undefined,
});
async function handleManagedRealtime(request: Request, env: Env): Promise<Response> {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return new Response('expected a WebSocket upgrade', { status: 426 });
  }
  if (env.MANAGED_DISABLED === '1') {
    return new Response('语音服务已暂停', { status: 503 });
  }
  // No key or no valid price table: the service is off, never priced by a default.
  const table = parsePriceTable(env.AI_PRICE_TABLE);
  if (!env.VOLC_SPEECH_API_KEY || !table) {
    return new Response('语音服务或价格尚未配置', { status: 503 });
  }
  if (!isAllowedOrigin(request.headers.get('Origin'), env)) {
    return new Response('forbidden origin', { status: 403 });
  }

  const ticket = parseVoiceTicket(request.headers.get('Sec-WebSocket-Protocol'));
  if (!ticket) {
    return new Response('缺少账户票据', { status: 401 });
  }
  let authorization: Awaited<ReturnType<Env['AUTH']['authorizeVoiceTicket']>>;
  try {
    authorization = await env.AUTH.authorizeVoiceTicket(ticket);
  } catch (error) {
    console.error(JSON.stringify({ event: 'voice_auth_unavailable', error: String(error) }));
    return new Response('账户服务暂不可用', { status: 503 });
  }
  if (authorization === 'unauthorized') {
    return new Response('账户票据无效或已过期', { status: 401 });
  }
  // Hold enough for at least one minute at the generous usage bound, up to the session cap;
  // the call settles at reported usage and ends before usage can outgrow the hold.
  const maxMinutes = positiveNumber(env.MAX_SESSION_MINUTES, 20);
  if (authorization.available < realtimeReservation(table.realtime, 1))
    return new Response('Credit 不足', { status: 402 });
  const maxCredits = Math.min(
    authorization.available,
    realtimeReservation(table.realtime, maxMinutes),
  );
  const stub = env.VOICE_SESSION.get(env.VOICE_SESSION.idFromName(authorization.subject));
  const forwarded = new Request(request);
  forwarded.headers.delete('x-voice-conversation');
  forwarded.headers.delete('x-voice-run');
  const requestedContext = new URL(request.url).searchParams;
  if (requestedContext.has('conversationId')) {
    forwarded.headers.set('x-voice-conversation', requestedContext.get('conversationId') ?? '');
    forwarded.headers.set('x-voice-run', requestedContext.get('runId') ?? '');
  }
  forwarded.headers.set('x-voice-ticket', ticket);
  forwarded.headers.set('x-voice-subject', authorization.subject);
  forwarded.headers.set('x-voice-reservation', crypto.randomUUID());
  forwarded.headers.set('x-voice-max-credits', String(maxCredits));
  return stub.fetch(forwarded);
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
