import { afterEach, describe, expect, it, vi } from 'vitest';
import example from '@0xnullai/ai-pricing/example-price-table.json';
import { parsePriceTable } from '@0xnullai/ai-pricing';
import {
  CLOSE_ACK_MS,
  holdMinutes,
  ManagedVoiceSession,
  USAGE_GRACE_MS,
} from './managed-session.js';
import type { Env } from './env.js';

const route = parsePriceTable(example)!.realtime;
/** The hold of 100 Credits covers this much call time at the usage bound. */
const HOLD_MS = Math.floor(holdMinutes(route, 100) * 60_000);
const NO_USAGE = {
  usage: {
    inputAudioTokens: 0,
    inputTextTokens: 0,
    cachedAudioTokens: 0,
    cachedTextTokens: 0,
    outputAudioTokens: 0,
    outputTextTokens: 0,
  },
  rounds: 0,
  missingRounds: 0,
};

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
    VOLC_SPEECH_API_KEY: 'test-key',
    AI_PRICE_TABLE: JSON.stringify(example),
    AUTH: {
      reserveVoiceCredits: vi.fn().mockResolvedValue({ allowed: true, status: 'pending' }),
      finalizeVoiceReservation: vi
        .fn()
        .mockImplementation(
          async (_s: string, _k: string, input: { action: string; durationMs: number }) => ({
            status: input.action === 'release' ? 'released' : 'settled',
            charged: input.action === 'release' ? null : 20,
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
    const handlers = new Map<string, ((event: { data?: unknown }) => void)[]>();
    const sent: string[] = [];
    return {
      sent,
      accept: vi.fn(),
      send: vi.fn((data: string) => sent.push(data)),
      close: vi.fn(),
      addEventListener: vi.fn((type: string, callback: (event: { data?: unknown }) => void) =>
        handlers.set(type, [...(handlers.get(type) ?? []), callback]),
      ),
      emit: (type: string, data?: unknown) => handlers.get(type)?.forEach((fn) => fn({ data })),
      /** Delivers one JSON event as a text frame. */
      message: (event: Record<string, unknown>) =>
        handlers.get('message')?.forEach((fn) => fn({ data: JSON.stringify(event) })),
      events: () => sent.map((data) => JSON.parse(data) as Record<string, unknown>),
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
      ...NO_USAGE,
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
    vi.setSystemTime(1_000 + HOLD_MS + 5_000);
    await f.session.alarm();
    await f.drain();
    expect(f.server.close).toHaveBeenCalled();
    expect(f.upstream.close).toHaveBeenCalled();
    expect(f.records.size).toBe(1);
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledWith('alice', expect.any(String), {
      action: 'settle',
      durationMs: HOLD_MS,
      ...NO_USAGE,
    });
    vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockResolvedValue({
      status: 'settled',
      charged: 100,
    });
    vi.setSystemTime(1_000 + HOLD_MS + 70_000);
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
      ...NO_USAGE,
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

  it('keeps finalizing earlier calls one at a time during a live call, never the live one', async () => {
    const f = setup();
    for (const key of ['old-1', 'old-2'])
      f.records.set(`billing:${key}`, {
        subject: 'alice',
        reservationKey: key,
        phase: 'release',
        durationMs: 0,
      });
    await f.session.fetch(f.request());
    await f.session.alarm();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledTimes(1);
    await f.session.alarm();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledTimes(2);
    await f.session.alarm();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.env.AUTH.finalizeVoiceReservation).mock.calls.map(([, key]) => key)).toEqual(
      ['old-1', 'old-2'],
    );
    expect([...f.records.values()]).toEqual([expect.objectContaining({ phase: 'active' })]);
  });

  it('stops retrying a release whose hold stays missing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const f = setup();
    f.records.set('billing:never', {
      subject: 'alice',
      reservationKey: 'never',
      phase: 'release',
      durationMs: 0,
    });
    vi.mocked(f.env.AUTH.finalizeVoiceReservation).mockResolvedValue({
      status: 'missing',
      charged: null,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(f.records.size).toBe(1);
      vi.setSystemTime(1_000 + attempt * 600_000);
      await f.session.alarm();
    }
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledTimes(3);
    expect(f.records.size).toBe(0);
    expect(f.alarm()).toBeNull();
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

/** The usage shape a live Seeduplex `response.done` carried. */
const roundUsage = (outputAudioTokens = 204) => ({
  type: 'response.done',
  response: {
    usage: {
      input_token_details: {
        text_tokens: 2736,
        audio_tokens: 122,
        cached_tokens_details: { text_tokens: 2560, audio_tokens: 0 },
      },
      output_token_details: { text_tokens: 89, audio_tokens: outputAudioTokens },
    },
  },
});

describe('Doubao realtime call through the Worker', () => {
  async function connected() {
    const f = setup();
    expect((await f.session.fetch(f.request())).status).toBe(101);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('https://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue');
    expect(new Headers(init!.headers).get('X-Api-Key')).toBe('test-key');
    f.server.message({
      type: 'session.update',
      session: {
        instructions: '角色设定',
        voice: 'ara',
        tools: [
          {
            type: 'function',
            name: 'stop_all',
            description: '停止',
            parameters: { type: 'object' },
          },
        ],
      },
    });
    f.upstream.message({ type: 'session.created', session: { id: 'dialog-1' } });
    return f;
  }

  it('relays a tool round trip and bills the round from reported usage', async () => {
    const f = await connected();
    expect(f.upstream.events()[0]).toMatchObject({
      type: 'session.create',
      session: {
        model: 'example-realtime-model',
        instructions: '角色设定',
        audio: { output: { voice: 'zh_female_xiaohe_uranus_bigtts' } },
        tools: [{ name: 'stop_all' }],
      },
    });
    f.server.message({ type: 'input_audio_buffer.append', audio: 'AAAA' });
    expect(f.upstream.events().at(-1)).toEqual({
      type: 'input_audio_buffer.append',
      audio: 'AAAA',
    });

    f.upstream.message({
      type: 'conversation.item.input_audio_transcription.started',
      item_id: 'q1',
    });
    f.upstream.message({
      type: 'response.function_call_arguments.done',
      items: [{ call_id: 'c1', name: 'stop_all', arguments: '{}' }],
    });
    expect(f.server.events()).toContainEqual({
      type: 'response.function_call_arguments.done',
      call_id: 'c1',
      name: 'stop_all',
      arguments: '{}',
    });
    f.server.message({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'c1', output: '{"stopped":true}' },
    });
    f.server.message({ type: 'response.create' });
    expect(f.upstream.events().slice(-1)).toEqual([
      {
        type: 'conversation.item.create',
        items: [
          {
            call_id: 'c1',
            role: 'tool',
            content: [{ type: 'input_text', text: '{"stopped":true}' }],
          },
        ],
      },
    ]);
    f.upstream.message({
      type: 'response.output_audio.started',
      question_id: 'q1',
      response_id: 'r1',
    });
    f.upstream.message({
      type: 'response.output_audio.done',
      question_id: 'q1',
      response_id: 'r1',
    });
    expect(f.server.events().at(-1)).toEqual({ type: 'response.done' });
    f.upstream.message(roundUsage());
    await vi.waitFor(() =>
      expect(
        f.records.get(`billing:${vi.mocked(f.env.AUTH.reserveVoiceCredits).mock.calls[0]![1]}`),
      ).toMatchObject({
        phase: 'active',
        rounds: 1,
        usage: { outputAudioTokens: 204, cachedTextTokens: 2560 },
      }),
    );

    // Hang-up: nothing pending, so the provider session is closed right away.
    f.server.emit('close');
    await vi.waitFor(() =>
      expect(f.upstream.events().map((event) => event.type)).toContain('session.close'),
    );
    f.upstream.message({ type: 'session.closed' });
    await f.drain();
    expect(f.upstream.close).toHaveBeenCalled();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledWith(
      'alice',
      expect.any(String),
      expect.objectContaining({
        action: 'settle',
        rounds: 1,
        missingRounds: 0,
        usage: expect.objectContaining({ outputAudioTokens: 204, inputTextTokens: 2736 }),
      }),
    );
  });

  it('after hang-up waits for late usage, forwards nothing more, then reviews rounds that never report', async () => {
    vi.useFakeTimers();
    const f = await connected();
    f.upstream.message({
      type: 'response.output_audio.started',
      question_id: 'q1',
      response_id: 'r1',
    });
    f.upstream.message({
      type: 'response.output_audio.done',
      question_id: 'q1',
      response_id: 'r1',
    });
    const delivered = f.server.sent.length;
    f.server.emit('close');
    await vi.advanceTimersByTimeAsync(0);
    expect(f.server.close).toHaveBeenCalled();
    expect(f.upstream.events().at(-1)).toEqual({ type: 'input_audio_mute.commit' });
    // A device tool call racing the hang-up never reaches the (closed) browser.
    f.upstream.message({
      type: 'response.function_call_arguments.done',
      items: [{ call_id: 'late', name: 'stop_all', arguments: '{}' }],
    });
    expect(f.server.sent.length).toBe(delivered);
    await vi.advanceTimersByTimeAsync(USAGE_GRACE_MS + CLOSE_ACK_MS + 10);
    await f.drain();
    expect(f.upstream.events().map((event) => event.type)).toContain('session.close');
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledWith(
      'alice',
      expect.any(String),
      expect.objectContaining({ action: 'settle', rounds: 0, missingRounds: 2 }),
    );
  });

  it('keeps usage that arrives during the grace period', async () => {
    vi.useFakeTimers();
    const f = await connected();
    f.upstream.message({
      type: 'response.output_audio.started',
      question_id: 'q1',
      response_id: 'r1',
    });
    f.server.emit('close');
    await vi.advanceTimersByTimeAsync(1_000);
    f.upstream.message(roundUsage());
    await vi.advanceTimersByTimeAsync(0);
    expect(f.upstream.events().map((event) => event.type)).toContain('session.close');
    f.upstream.message({ type: 'session.closed' });
    await vi.advanceTimersByTimeAsync(0);
    await f.drain();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledWith(
      'alice',
      expect.any(String),
      expect.objectContaining({ rounds: 1, missingRounds: 0 }),
    );
  });

  it('does not let an alarm settle a call that is still draining usage after hang-up', async () => {
    vi.useFakeTimers();
    const f = await connected();
    f.upstream.message({
      type: 'response.output_audio.started',
      question_id: 'q1',
      response_id: 'r1',
    });
    f.server.emit('close');
    await vi.advanceTimersByTimeAsync(1_000);
    await f.session.alarm();
    expect(f.env.AUTH.finalizeVoiceReservation).not.toHaveBeenCalled();
    f.upstream.message(roundUsage());
    f.upstream.message({ type: 'session.closed' });
    await vi.advanceTimersByTimeAsync(0);
    await f.drain();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledOnce();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledWith(
      'alice',
      expect.any(String),
      expect.objectContaining({ action: 'settle', rounds: 1, missingRounds: 0 }),
    );
  });

  it('ends the call before reported usage outgrows the hold', async () => {
    const f = await connected();
    // 30k output audio tokens at the example rate cost more than 90% of the 100 Credit hold.
    f.upstream.message({
      type: 'response.output_audio.started',
      question_id: 'q1',
      response_id: 'r1',
    });
    f.upstream.message(roundUsage(30_000));
    expect(f.server.close).toHaveBeenCalled();
    f.upstream.message({ type: 'session.closed' });
    await f.drain();
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledWith(
      'alice',
      expect.any(String),
      expect.objectContaining({ action: 'settle', rounds: 1 }),
    );
  });

  it('settles at once when the provider drops the connection', async () => {
    const f = await connected();
    f.upstream.message({
      type: 'response.output_audio.started',
      question_id: 'q1',
      response_id: 'r1',
    });
    f.upstream.emit('close');
    await f.drain();
    expect(f.server.close).toHaveBeenCalled();
    expect(f.upstream.events().map((event) => event.type)).not.toContain('session.close');
    expect(f.env.AUTH.finalizeVoiceReservation).toHaveBeenCalledWith(
      'alice',
      expect.any(String),
      expect.objectContaining({ missingRounds: 1 }),
    );
  });

  it('refuses to open a call without the speech key or a valid price table', async () => {
    for (const patch of [{ VOLC_SPEECH_API_KEY: undefined }, { AI_PRICE_TABLE: '{}' }]) {
      const f = setup();
      Object.assign(f.env, patch);
      expect((await f.session.fetch(f.request())).status).toBe(503);
      expect(f.env.AUTH.reserveVoiceCredits).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  });
});
