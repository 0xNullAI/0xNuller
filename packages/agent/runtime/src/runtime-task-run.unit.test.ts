import { describe, expect, it } from 'vitest';
import { RuntimeTaskRunLedger } from './runtime-task-run.js';

describe('client TaskRun ledger', () => {
  it('keeps separately named runs across retries and never accepts a repeated server run ID', () => {
    const ledger = new RuntimeTaskRunLedger();
    ledger.begin({ runId: 'server-run-1', sessionId: 'chat', requestId: 'request-1' });
    ledger.startCall('server-run-1', 'call-1', 'timer');
    ledger.record({
      runId: 'server-run-1',
      callId: 'call-1',
      name: 'timer',
      status: 'succeeded',
      output: JSON.stringify({ timer: { id: 'timer-1' } }),
    });
    ledger.finish('server-run-1', 'completed');
    ledger.begin({ runId: 'server-run-2', sessionId: 'chat', requestId: 'request-2' });

    expect(ledger.list('chat').map((run) => run.status)).toEqual(['completed', 'running']);
    expect(ledger.get('server-run-1')?.receipts).toEqual([
      expect.objectContaining({
        runId: 'server-run-1',
        callId: 'call-1',
        status: 'succeeded',
        provenance: 'client-reported',
      }),
    ]);
    expect(ledger.get('server-run-1')?.receipts[0]).not.toHaveProperty('output');
    expect(() =>
      ledger.begin({ runId: 'server-run-1', sessionId: 'chat', requestId: 'request-1' }),
    ).toThrow('任务编号重复');
  });

  it('marks an interrupted in-flight call unknown while retaining prior receipts', () => {
    const ledger = new RuntimeTaskRunLedger();
    ledger.begin({ runId: 'run', sessionId: 'chat', requestId: 'request' });
    ledger.startCall('run', 'first', 'file_read');
    ledger.record({
      runId: 'run',
      callId: 'first',
      name: 'file_read',
      status: 'succeeded',
      output: '{}',
    });
    ledger.startCall('run', 'second', 'shock_adjust');

    const final = ledger.finish('run', 'aborted');
    expect(final.status).toBe('needs-review');
    expect(final.receipts.map((receipt) => [receipt.callId, receipt.status])).toEqual([
      ['first', 'succeeded'],
      ['second', 'unknown'],
    ]);
    expect(() =>
      ledger.record({
        runId: 'run',
        callId: 'third',
        name: 'timer',
        status: 'succeeded',
        output: '{}',
      }),
    ).toThrow('任务不存在或已结束');
  });

  it('returns defensive snapshots so consumers cannot forge the local audit', () => {
    const ledger = new RuntimeTaskRunLedger();
    ledger.begin({ runId: 'run', sessionId: 'chat', requestId: 'request' });
    const snapshot = ledger.startCall('run', 'call', 'timer');
    snapshot.activeCall!.name = 'forged';
    expect(ledger.get('run')?.activeCall?.name).toBe('timer');
  });

  it('never overwrites an in-flight call or reuses a settled call ID', () => {
    const ledger = new RuntimeTaskRunLedger();
    ledger.begin({ runId: 'run', sessionId: 'chat', requestId: 'request' });
    ledger.startCall('run', 'call', 'shock_start');
    expect(() => ledger.startCall('run', 'another', 'shock_stop')).toThrow('上一调用尚未结算');
    expect(() =>
      ledger.record({
        runId: 'run',
        callId: 'another',
        name: 'shock_stop',
        status: 'succeeded',
        output: '{}',
      }),
    ).toThrow('工具结果与正在执行的调用不匹配');
    expect(ledger.get('run')?.activeCall).toEqual({ callId: 'call', name: 'shock_start' });
    ledger.record({
      runId: 'run',
      callId: 'call',
      name: 'shock_start',
      status: 'unknown',
      output: '{}',
    });
    expect(() => ledger.startCall('run', 'call', 'shock_start')).toThrow('工具调用编号重复');
    expect(ledger.get('run')?.receipts).toHaveLength(1);
  });
});
