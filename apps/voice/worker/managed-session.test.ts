import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManagedVoiceSession } from './managed-session.js';
import type { Env } from './env.js';

function setup() {
  const records = new Map<string, unknown>();
  let alarm: number | null = null;
  const storage = {
    put: vi.fn(async (key: string, value: unknown) => {
      records.set(key, structuredClone(value));
    }),
    get: async (key: string) => records.get(key),
    delete: vi.fn(async (key: string) => records.delete(key)),
    list: vi.fn(async () => new Map(records)),
    getAlarm: async () => alarm,
    setAlarm: vi.fn(async (time: number) => {
      alarm = time;
    }),
    deleteAlarm: vi.fn(async () => {
      alarm = null;
    }),
    transaction: async (run: (tx: unknown) => Promise<void>) => {
      const saved = new Map(records);
      const oldAlarm = alarm;
      try {
        await run(storage);
      } catch (error) {
        records.clear();
        for (const [k, v] of saved) records.set(k, v);
        alarm = oldAlarm;
        throw error;
      }
    },
  };
  const pending: Promise<unknown>[] = [];
  const state = {
    storage,
    waitUntil: (task: Promise<unknown>) => pending.push(task),
  } as unknown as DurableObjectState;
  const env = {
    XAI_API_KEY: 'test-key',
    AUTH: {
      reserveVoiceCredits: vi.fn().mockResolvedValue({ allowed: true, status: 'pending' }),
      finalizeVoiceReservation: vi
        .fn()
        .mockImplementation(
          async (_s: string, _k: string, input: { action: string; durationMs: number }) => ({
            status: input.action === 'release' ? 'released' : 'settled',
            charged:
              input.action === 'release'
                ? null
                : Math.max(20, Math.ceil(input.durationMs / 10_000) * 20),
          }),
        ),
    },
  } as unknown as Env;
  const request = () =>
    new Request('https://test/api/realtime', {
      headers: {
        'x-voice-ticket': 'ticket',
        'x-voice-subject': 'alice',
        'x-voice-reservation': crypto.randomUUID(),
        'x-voice-max-credits': '100',
      },
    });
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const socket = () => {
    const handlers = new Map<string, (() => void)[]>();
    return {
      accept: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      addEventListener: vi.fn((type: string, callback: () => void) =>
        handlers.set(type, [...(handlers.get(type) ?? []), callback]),
      ),
      emit: (type: string) => handlers.get(type)?.forEach((fn) => fn()),
    };
  };
  const upstream = socket();
  const server = socket();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ webSocket: upstream }));
  vi.stubGlobal(
    'WebSocketPair',
    class {
      0 = socket();
      1 = server;
    },
  );
  const NativeResponse = Response;
  // Node fetch disallows 101; Cloudflare's Response supports the upgrade option.
  vi.stubGlobal(
    'Response',
    class extends NativeResponse {
      private upgrade = false;
      constructor(body: BodyInit | null, init?: ResponseInit) {
        super(body, init?.status === 101 ? { ...init, status: 200 } : init);
        this.upgrade = init?.status === 101;
      }
      get status() {
        return this.upgrade ? 101 : super.status;
      }
    },
  );
  return {
    env,
    state,
    storage,
    records,
    request,
    upstream,
    server,
    session: new ManagedVoiceSession(state, env),
    drain: async () => {
      await Promise.all(pending);
    },
    alarm: () => alarm,
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('durable Voice billing lifecycle', () => {
  it.each(['network', 'upgrade'])(
    'keeps release intent through %s failure and billing outage, then retries after restart',
    async (failure) => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const f = setup();
      if (failure === 'network') vi.mocked(fetch).mockRejectedValue(new Error('offline'));
      else vi.mocked(fetch).mockResolvedValue({ webSocket: null } as Response);
      vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockRejectedValue(
        new Error('billing offline'),
      );
      expect((await f.session.fetch(f.request())).status).toBe(502);
      expect((await f.session.fetch(f.request())).status).toBe(502);
      expect(f.records.size).toBe(2);
      expect(f.alarm()).not.toBeNull();
      vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockResolvedValue({
        status: 'released',
        charged: null,
      });
      vi.setSystemTime(11_001);
      await new ManagedVoiceSession(f.state, f.env).alarm();
      expect(f.records.size).toBe(0);
    },
  );
  it('closes sockets and releases when duration alarm cannot be established', async () => {
    const f = setup();
    // Initial reservation intent and active-intent transactions succeed, final
    // hard deadline fails; subsequent recovery writes remain available.
    f.storage.setAlarm
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('alarm unavailable'));
    expect((await f.session.fetch(f.request())).status).toBe(503);
    expect(f.server.close).toHaveBeenCalled();
    expect(f.upstream.close).toHaveBeenCalled();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledWith('alice', expect.any(String), {
      action: 'release',
      durationMs: 0,
    });
  });
  it('checkpoints connected time and never bills downtime after object restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const f = setup();
    expect((await f.session.fetch(f.request())).status).toBe(101);
    vi.setSystemTime(11_000);
    await f.session.alarm();
    expect(f.env.AUTH.finalizeVoiceReservation).not.toHaveBeenCalled();
    vi.setSystemTime(900_000);
    await new ManagedVoiceSession(f.state, f.env).alarm();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledWith('alice', expect.any(String), {
      action: 'settle',
      durationMs: 10_000,
    });
    expect(f.records.size).toBe(0);
  });
  it('closes at the credit deadline and persists unsuccessful settlement until acknowledged', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const f = setup();
    expect((await f.session.fetch(f.request())).status).toBe(101);
    vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockResolvedValue({
      status: 'rejected',
      charged: null,
    });
    vi.setSystemTime(100_000);
    await f.session.alarm();
    await f.drain();
    expect(f.server.close).toHaveBeenCalled();
    expect(f.upstream.close).toHaveBeenCalled();
    expect(f.records.size).toBe(1);
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledWith('alice', expect.any(String), {
      action: 'settle',
      durationMs: 50_000,
    });
    vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockResolvedValue({
      status: 'settled',
      charged: 100,
    });
    vi.setSystemTime(160_001);
    await new ManagedVoiceSession(f.state, f.env).alarm();
    expect(f.records.size).toBe(0);
  });
  it('settles close/error only once while preserving normal billed duration', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const f = setup();
    await f.session.fetch(f.request());
    vi.setSystemTime(12_000);
    f.server.emit('close');
    f.upstream.emit('error');
    await f.drain();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledTimes(1);
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledWith('alice', expect.any(String), {
      action: 'settle',
      durationMs: 11_000,
    });
  });

  it('bounds recovery batches and upgrades legacy intents with durable exponential backoff', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const f = setup();
    for (let i = 0; i < 6; i++)
      f.records.set(`billing:legacy-${i}`, {
        subject: 'alice',
        reservationKey: `legacy-${i}`,
        phase: 'release',
        durationMs: 0,
      });
    vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockRejectedValue(new Error('offline'));
    await f.session.alarm();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledTimes(4);
    expect(f.records.get('billing:legacy-0')).toMatchObject({ attempts: 1, nextAttemptAt: 11_000 });
    await f.session.alarm();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledTimes(6);
    vi.setSystemTime(11_000);
    await new ManagedVoiceSession(f.state, f.env).alarm();
    expect(f.records.get('billing:legacy-0')).toMatchObject({ attempts: 2, nextAttemptAt: 31_000 });
    f.records.set('billing:legacy-0', {
      subject: 'alice',
      reservationKey: 'legacy-0',
      phase: 'release',
      durationMs: 0,
      attempts: 29,
      nextAttemptAt: 0,
    });
    await f.session.alarm();
    expect(f.records.get('billing:legacy-0')).toMatchObject({
      attempts: 30,
      nextAttemptAt: 311_000,
    });
  });

  it('does not let recovery work delay a live call or finalize its new reservation', async () => {
    const f = setup();
    f.records.set('billing:old', {
      subject: 'alice',
      reservationKey: 'old-key',
      phase: 'release',
      durationMs: 0,
    });
    await f.session.fetch(f.request());
    await f.session.alarm();
    expect(f.env.AUTH.finalizeVoiceReservation).not.toHaveBeenCalled();
    f.server.emit('close');
    const next = f.session.fetch(f.request());
    await next;
    await f.drain();
    expect(f.env.AUTH.finalizeVoiceReservation).not.toHaveBeenCalled();
    expect(
      [...f.records.values()].filter((value) => (value as { phase: string }).phase === 'active'),
    ).toHaveLength(1);
  });
});

it('reserves Voice against the explicit call snapshot before opening upstream', async () => {
  const f = setup();
  const input = f.request();
  input.headers.set('x-voice-conversation', 'private-chat');
  input.headers.set('x-voice-run', 'call:actual:001');
  expect((await f.session.fetch(input)).status).toBe(101);
  expect(f.env.AUTH.reserveVoiceCredits).toHaveBeenCalledWith('ticket', expect.any(String), 100, {
    conversationId: 'private-chat',
    runId: 'call:actual:001',
  });
  f.server.emit('close');
  await f.drain();
});

it('forgets a deterministically rejected context without opening upstream or retrying a missing hold', async () => {
  const f = setup();
  vi.mocked(f.env.AUTH.reserveVoiceCredits).mockResolvedValue({
    allowed: false,
    status: 'rejected',
    charged: null,
    total: 100,
    reserved: 0,
    available: 100,
  });
  expect((await f.session.fetch(f.request())).status).toBe(403);
  expect(fetch).not.toHaveBeenCalled();
  expect(f.records.size).toBe(0);
});

it('acknowledges a durable expiry review once and stops retrying after process recovery', async () => {
  const f = setup();
  f.records.set('billing:expired:001', {
    subject: 'alice',
    reservationKey: 'expired:001',
    phase: 'settle',
    durationMs: 40_000,
  });
  vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockResolvedValue({
    status: 'needs_review',
    charged: null,
  });
  await new ManagedVoiceSession(f.state, f.env).alarm();
  expect(f.records.size).toBe(0);
  expect(f.alarm()).toBeNull();
  await new ManagedVoiceSession(f.state, f.env).alarm();
  expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledTimes(1);
});
it('does not discard an invalid review acknowledgement containing a charge', async () => {
  const f = setup();
  f.records.set('billing:expired:002', {
    subject: 'alice',
    reservationKey: 'expired:002',
    phase: 'settle',
    durationMs: 40_000,
  });
  vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockResolvedValue({
    status: 'needs_review',
    charged: 80,
  });
  await f.session.alarm();
  expect(f.records.size).toBe(1);
  expect(f.records.get('billing:expired:002')).toMatchObject({ attempts: 1 });
});

it('retains a settlement with the wrong charge and retries the exact reservation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
  const f = setup();
  f.records.set('billing:charge-mismatch', {
    subject: 'alice',
    reservationKey: 'charge-mismatch',
    phase: 'settle',
    durationMs: 40_000,
    reservedCredits: 100,
  });
  vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockResolvedValueOnce({
    status: 'settled',
    charged: 20,
  });
  await f.session.alarm();
  expect(f.records.get('billing:charge-mismatch')).toMatchObject({
    attempts: 1,
    nextAttemptAt: 61_000,
  });
  vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockResolvedValue({
    status: 'settled',
    charged: 80,
  });
  vi.setSystemTime(61_000);
  await new ManagedVoiceSession(f.state, f.env).alarm();
  expect(f.records.size).toBe(0);
  expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledTimes(2);
  expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenLastCalledWith('alice', 'charge-mismatch', {
    action: 'settle',
    durationMs: 40_000,
  });
});

it('does not discard a release receipt that still reports a charge', async () => {
  const f = setup();
  f.records.set('billing:bad-release', {
    subject: 'alice',
    reservationKey: 'bad-release',
    phase: 'release',
    durationMs: 0,
    reservedCredits: 100,
  });
  vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockResolvedValue({
    status: 'released',
    charged: 20,
  });
  await f.session.alarm();
  expect(f.records.get('billing:bad-release')).toMatchObject({ attempts: 1 });
});

it('keeps old durable settlement records recoverable without an accepted quote', async () => {
  const f = setup();
  f.records.set('billing:legacy-settle', {
    subject: 'alice',
    reservationKey: 'legacy-settle',
    phase: 'settle',
    durationMs: 10_000,
  });
  vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockResolvedValue({
    status: 'settled',
    charged: 20,
  });
  await f.session.alarm();
  expect(f.records.size).toBe(0);
});
