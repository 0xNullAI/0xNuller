import { describe, expect, it } from 'vitest';
import { createToolExecutionReceipt } from './runtime-tool-receipt.js';

const receipt = (name: string, output: unknown, args?: Record<string, unknown>) =>
  createToolExecutionReceipt({
    runId: 'run-1',
    callId: 'call-1',
    name,
    args,
    output: typeof output === 'string' ? output : JSON.stringify(output),
  });

describe('tool execution receipts', () => {
  it('binds status to the exact run and call, requiring an owner-specific success shape', () => {
    expect(receipt('timer', { timer: { id: 'timer-1' } })).toMatchObject({
      runId: 'run-1',
      callId: 'call-1',
      status: 'succeeded',
    });
    expect(receipt('timer', { status: 'completed' }).status).toBe('unknown');
    expect(receipt('task_plan_save', { item: { id: 'plan-1' } }).status).toBe('succeeded');
    expect(receipt('task_plan_save', { item: { id: 'plan-1' }, status: 'pending' }).status).toBe(
      'pending',
    );
    expect(receipt('memory_search', { items: [] }).status).toBe('unknown');
    expect(receipt('file_read', 'read file').status).toBe('unknown');
  });

  it('never promotes denial, failure, pending or unknown execution to success', () => {
    expect(receipt('timer', { error: 'denied', _meta: { kind: 'tool-denied' } }).status).toBe(
      'denied',
    );
    expect(receipt('timer', { error: 'timeout', _meta: { kind: 'tool-unknown' } }).status).toBe(
      'unknown',
    );
    expect(receipt('timer', { error: 'failed', _meta: { kind: 'tool-failed' } }).status).toBe(
      'failed',
    );
    expect(receipt('timer', { status: 'queued', timer: { id: 'timer-1' } }).status).toBe('pending');
  });

  it('requires the actual executed device command instead of an ok flag alone', () => {
    expect(receipt('shock_start', { ok: true }).status).toBe('unknown');
    expect(receipt('shock_start', { ok: 'clamped', command: { type: 'stop' } }).status).toBe(
      'unknown',
    );
    expect(receipt('shock_start', { ok: true, command: { type: 'start' } }).status).toBe(
      'succeeded',
    );
    expect(
      receipt('shock_start', {
        ok: true,
        command: { type: 'start' },
        interrupted: true,
      }).status,
    ).toBe('unknown');
    expect(receipt('shock_stop', { ok: true, command: { type: 'start' } }).status).toBe('unknown');
    expect(receipt('vibrate_stop', { ok: true, command: { type: 'stop' } }).status).toBe('unknown');
    expect(receipt('vibrate_stop', { ok: true, command: { type: 'vibrateStop' } }).status).toBe(
      'succeeded',
    );
    expect(receipt('set_indicator_color', { ok: true }).status).toBe('unknown');
    expect(
      receipt(
        'set_indicator_color',
        { ok: true, deviceKind: 'opossum', color: 2 },
        { deviceKind: 'opossum', color: 2 },
      ).status,
    ).toBe('succeeded');
  });

  it('does not credit an indicator change to a different device or color', () => {
    const args = { deviceKind: 'paw-prints', color: 7 };
    expect(
      receipt('set_indicator_color', { ok: true, deviceKind: 'opossum', color: 7 }, args).status,
    ).toBe('unknown');
    expect(
      receipt('set_indicator_color', { ok: true, deviceKind: 'paw-prints', color: 2 }, args).status,
    ).toBe('unknown');
    expect(
      receipt('set_indicator_color', { ok: true, deviceKind: 'paw-prints', color: 7 }).status,
    ).toBe('unknown');
    expect(
      receipt('set_indicator_color', { ok: true, deviceKind: 'paw-prints', color: 7 }, args).status,
    ).toBe('succeeded');
  });

  it('requires the exact Coyote target when the call names one', () => {
    const args = { targetId: 'opaque/second' };
    const output = { ok: true, command: { type: 'start' }, targetId: 'opaque/second' };
    expect(receipt('shock_start', output, args).status).toBe('succeeded');
    expect(receipt('shock_start', { ...output, targetId: 'opaque/first' }, args).status).toBe(
      'unknown',
    );
    expect(receipt('shock_start', { ok: true, command: { type: 'start' } }, args).status).toBe(
      'unknown',
    );
  });
});
