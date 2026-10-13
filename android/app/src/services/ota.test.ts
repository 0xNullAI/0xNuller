import { describe, expect, it, vi } from 'vitest';
import { OtaUpdater, toBase64 } from './ota.js';

const ENDPOINT = 'https://ota.test/android';

function respond(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

function setup(
  begin: Record<string, unknown>,
  files: Record<string, string> = {},
  native: Record<string, unknown> = {},
) {
  const calls: { cmd: string; args: unknown; options: unknown }[] = [];
  const invoke = vi.fn(async (cmd: string, args?: unknown, options?: unknown) => {
    calls.push({ cmd, args, options });
    if (cmd === 'ota_begin') return { missing: [], reloadRequired: false, ...begin };
    if (cmd === 'ota_commit') return { buildId: 'b2', version: '7.1.1', notes: '修复' };
    if (cmd === 'ota_status')
      return { nativeApi: 1, embeddedVersion: '7.1.0', active: null, pending: null, ...native };
    return null;
  });
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === `${ENDPOINT}/latest.json`) return respond({ manifest: '{}', signature: 'sig' });
    const path = url.slice(`${ENDPOINT}/b2/`.length);
    return path in files ? respond(files[path]!) : respond('missing', 404);
  });
  const updater = new OtaUpdater({
    endpoint: ENDPOINT,
    invoke: invoke as never,
    fetchImpl: fetchImpl as never,
  });
  return { updater, calls, fetchImpl };
}

describe('OtaUpdater', () => {
  it('hands each missing file to the native store and reports the ready version', async () => {
    const { updater, calls } = setup(
      {
        action: 'download',
        buildId: 'b2',
        version: '7.1.1',
        missing: ['index.html', 'assets/a b.js'],
      },
      { 'index.html': '<html>', 'assets/a%20b.js': 'js' },
    );
    await updater.check();
    expect(updater.getStatus()).toEqual({ phase: 'ready', readyVersion: '7.1.1', notes: '修复' });
    const writes = calls.filter((call) => call.cmd === 'ota_write');
    expect(writes.map((write) => write.args)).toEqual([
      { buildId: 'b2', path: 'index.html', data: btoa('<html>') },
      { buildId: 'b2', path: 'assets/a b.js', data: btoa('js') },
    ]);
    expect(calls.at(-1)).toMatchObject({ cmd: 'ota_commit', args: { buildId: 'b2' } });
  });

  it('encodes large files to base64 without overflowing the call stack', () => {
    const bytes = new Uint8Array(300_000).map((_, index) => index % 251);
    expect(Buffer.from(toBase64(bytes), 'base64').equals(Buffer.from(bytes))).toBe(true);
  });

  it('stays idle when there is nothing for this APK', async () => {
    for (const action of ['upToDate', 'nativeMismatch']) {
      const { updater, calls } = setup({ action, buildId: 'b2', version: '7.2.0' });
      await updater.check();
      expect(updater.getStatus().phase).toBe('idle');
      expect(calls.some((call) => call.cmd === 'ota_write')).toBe(false);
    }
  });

  it('fetches nothing when native hot updates are off for this run', async () => {
    const { updater, calls, fetchImpl } = setup(
      { action: 'download', buildId: 'b2', version: '7.2.0' },
      {},
      { available: false },
    );
    await updater.check();
    expect(updater.getStatus().phase).toBe('idle');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls.some((call) => call.cmd === 'ota_begin')).toBe(false);
  });

  it('does not commit a partial download', async () => {
    const { updater, calls } = setup(
      { action: 'download', buildId: 'b2', version: '7.1.1', missing: ['index.html', 'gone.js'] },
      { 'index.html': '<html>' },
    );
    await updater.check();
    expect(updater.getStatus().phase).toBe('idle');
    expect(calls.some((call) => call.cmd === 'ota_commit')).toBe(false);
  });

  it('asks for a reload when the running UI was revoked', async () => {
    const { updater } = setup({
      action: 'upToDate',
      buildId: 'b3',
      version: '7.1.3',
      reloadRequired: true,
    });
    await updater.check();
    expect(updater.getStatus().phase).toBe('reload-required');
  });

  it('shares one run between overlapping checks', async () => {
    const { updater, fetchImpl } = setup({ action: 'upToDate', buildId: 'b2', version: '7.1.0' });
    await Promise.all([updater.check(), updater.check()]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
