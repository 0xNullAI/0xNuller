import { describe, expect, it } from 'vitest';
import {
  parseServerErrorReport,
  withServerErrorCounting,
  type ServerErrorReport,
} from './worker-errors';

type Env = { reports: ServerErrorReport[]; broken?: boolean; unbound?: boolean };

function context() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: { waitUntil: (promise: Promise<unknown>) => void pending.push(promise) },
    settle: async () => {
      while (pending.length) await Promise.allSettled(pending.splice(0));
    },
  };
}

function monitored(fetch: (request: Request) => Promise<Response> | Response) {
  return withServerErrorCounting<
    Env,
    { fetch(request: Request, env: Env, ctx: unknown): Promise<Response> }
  >(
    { fetch: async (request) => fetch(request) },
    {
      worker: 'market',
      flushDelayMs: 0,
      sink: (env) =>
        env.unbound
          ? undefined
          : {
              recordServerErrors: async (report) => {
                if (env.broken) throw new Error('auth down');
                env.reports.push(report);
              },
            },
    },
  );
}

const request = () => new Request('https://0xnullai.com/api/items');

describe('withServerErrorCounting', () => {
  it('passes responses through and counts 5xx in one coalesced flush', async () => {
    const env: Env = { reports: [] };
    const { ctx, settle } = context();
    let status = 503;
    const worker = monitored(() => new Response('x', { status }));
    const first = await worker.fetch(request(), env, ctx as never);
    await worker.fetch(request(), env, ctx as never);
    status = 200;
    await worker.fetch(request(), env, ctx as never);
    expect(first.status).toBe(503);
    expect(await first.text()).toBe('x');
    await settle();
    expect(env.reports).toEqual([{ worker: 'market', counts: [{ kind: 'http_5xx', count: 2 }] }]);
  });

  it('rethrows the original exception and counts it', async () => {
    const env: Env = { reports: [] };
    const { ctx, settle } = context();
    const boom = new Error('boom');
    const worker = monitored(() => {
      throw boom;
    });
    await expect(worker.fetch(request(), env, ctx as never)).rejects.toBe(boom);
    await settle();
    expect(env.reports[0]!.counts).toEqual([{ kind: 'exception', count: 1 }]);
  });

  it('fails open when the sink throws, is unbound, or there is no ctx', async () => {
    for (const env of [
      { reports: [], broken: true },
      { reports: [], unbound: true },
    ] as Env[]) {
      const { ctx, settle } = context();
      const worker = monitored(() => new Response(null, { status: 500 }));
      expect((await worker.fetch(request(), env, ctx as never)).status).toBe(500);
      await settle();
      expect(env.reports).toEqual([]);
    }
    const worker = monitored(() => new Response(null, { status: 502 }));
    expect((await worker.fetch(request(), { reports: [] }, undefined as never)).status).toBe(502);
  });

  it('counts failed crons, including rejected background work', async () => {
    const env: Env = { reports: [] };
    const { ctx, settle } = context();
    const worker = withServerErrorCounting<
      Env,
      { scheduled(c: unknown, e: Env, x: typeof ctx): Promise<void> }
    >(
      {
        async scheduled(_controller, _env, inner) {
          inner.waitUntil(Promise.reject(new Error('background')));
        },
      },
      {
        worker: 'auth',
        flushDelayMs: 0,
        sink: (e) => ({ recordServerErrors: async (report) => void e.reports.push(report) }),
      },
    );
    await worker.scheduled({}, env, ctx);
    await settle();
    expect(env.reports).toEqual([{ worker: 'auth', counts: [{ kind: 'scheduled', count: 1 }] }]);
  });
});

describe('parseServerErrorReport', () => {
  it('accepts known workers and kinds and clamps counts', () => {
    expect(
      parseServerErrorReport({ worker: 'chat', counts: [{ kind: 'http_5xx', count: 1e9 }] }),
    ).toEqual({ worker: 'chat', counts: [{ kind: 'http_5xx', count: 10_000 }] });
  });

  it.each([
    { worker: 'web', counts: [{ kind: 'http_5xx', count: 1 }] },
    { worker: 'chat', counts: [] },
    { worker: 'chat', counts: [{ kind: 'oops', count: 1 }] },
    { worker: 'chat', counts: [{ kind: 'http_5xx', count: 0 }] },
    { worker: 'chat', counts: [{ kind: 'http_5xx', count: 1.5 }] },
    {
      worker: 'chat',
      counts: [
        { kind: 'http_5xx', count: 1 },
        { kind: 'http_5xx', count: 1 },
      ],
    },
    null,
  ])('rejects %j', (value) => {
    expect(parseServerErrorReport(value)).toBeNull();
  });
});
