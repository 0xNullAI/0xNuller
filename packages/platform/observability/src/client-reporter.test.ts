import { describe, expect, it } from 'vitest';
import {
  createClientErrorReporter,
  installClientErrorReporting,
  reportModuleError,
  type ClientErrorReporterOptions,
} from './client-reporter';

function setup(overrides: Partial<ClientErrorReporterOptions> = {}) {
  const sent: Array<Record<string, unknown>> = [];
  let clock = 1_000_000;
  const options: ClientErrorReporterOptions = {
    platform: 'web',
    version: '6.5.7',
    buildId: 'test',
    endpoint: '/api/auth/client-errors',
    sessionId: 'session-0001',
    pathname: () => '/u/alice',
    now: () => clock,
    send: async (_endpoint, body) => {
      sent.push(JSON.parse(body) as Record<string, unknown>);
    },
    ...overrides,
  };
  return {
    options,
    sent,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('client error reporter', () => {
  it('sends a sanitized report without identifiers', async () => {
    const { options, sent } = setup();
    const reporter = createClientErrorReporter(options);
    expect(
      reporter.report(new Error('failed for bob@example.com ?token=x'), { moduleId: 'agent' }),
    ).toBe(true);
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'error',
      moduleId: 'agent',
      platform: 'web',
      route: '/u/:param',
      sessionId: 'session-0001',
    });
    expect(JSON.stringify(sent[0])).not.toContain('bob@example.com');
  });

  it('never serializes a non-error rejection value', async () => {
    const { options, sent } = setup();
    createClientErrorReporter(options).report({ chat: '私密内容' }, { kind: 'unhandledrejection' });
    await flush();
    expect(JSON.stringify(sent)).not.toContain('私密');
    expect(sent[0]!.message).toBe('Non-error rejection (object)');
  });

  it('deduplicates identical errors inside the window', async () => {
    const { options, sent, advance } = setup();
    const reporter = createClientErrorReporter(options);
    expect(reporter.report(new Error('same 1'))).toBe(true);
    expect(reporter.report(new Error('same 2'))).toBe(false);
    advance(10 * 60 * 1000);
    expect(reporter.report(new Error('same 3'))).toBe(true);
    await flush();
    expect(sent).toHaveLength(2);
  });

  it('caps reports per minute and per session', () => {
    const { options, advance } = setup({ maxPerMinute: 2, maxPerSession: 3 });
    const reporter = createClientErrorReporter(options);
    expect(reporter.report(new Error('a'))).toBe(true);
    expect(reporter.report(new Error('b'))).toBe(true);
    expect(reporter.report(new Error('c'))).toBe(false);
    advance(60_000);
    expect(reporter.report(new Error('d'))).toBe(true);
    advance(60_000);
    expect(reporter.report(new Error('e'))).toBe(false);
  });

  it('swallows send failures', async () => {
    const { options } = setup({
      send: () => Promise.reject(new Error('offline')),
    });
    expect(createClientErrorReporter(options).report(new Error('x'))).toBe(true);
    await flush();
  });

  it('listens for uncaught errors and rejections and serves boundaries until uninstalled', async () => {
    const { options, sent } = setup();
    const target = new EventTarget();
    const uninstall = installClientErrorReporting(target, options);
    target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('uncaught') }));
    target.dispatchEvent(
      Object.assign(new Event('unhandledrejection'), { reason: new Error('rejected') }),
    );
    reportModuleError(new Error('render'), 'chat');
    await flush();
    expect(sent.map((report) => report.kind)).toEqual(['error', 'unhandledrejection', 'boundary']);
    expect(sent[2]!.moduleId).toBe('chat');
    uninstall();
    target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('after') }));
    reportModuleError(new Error('after'), 'chat');
    await flush();
    expect(sent).toHaveLength(3);
  });
});
