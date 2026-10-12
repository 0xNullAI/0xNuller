import type { SourceType } from '@dg-agent/core';
import type { ToolExecutionReceipt, ToolReceiptStatus } from './runtime-tool-receipt.js';

export type RuntimeTaskRunStatus =
  'running' | 'completed' | 'incomplete' | 'needs-review' | 'aborted' | 'failed';

/** This is a client observation, never a server-issued proof of a device action. */
export interface ClientToolReceipt {
  runId: string;
  callId: string;
  name: string;
  status: ToolReceiptStatus;
  provenance: 'client-reported';
}

export interface RuntimeTaskRunSnapshot {
  runId: string;
  sessionId: string;
  requestId: string;
  status: RuntimeTaskRunStatus;
  receipts: readonly ClientToolReceipt[];
  activeCall: { callId: string; name: string } | null;
  startedAt: number;
  updatedAt: number;
  provenance: 'client-reported';
}

/**
 * Optional durable boundary. The owner may allocate a server run ID and must
 * reject a reused request ID for a different conversation. A failed preflight
 * prevents non-stop tools from dispatching. All receipts here are untrusted
 * client reports; server-owned tool executors must issue their own evidence.
 */
export interface RuntimeTaskRunReporter {
  begin(input: {
    runId: string;
    sessionId: string;
    requestId: string;
    sourceType: SourceType;
  }): Promise<void>;
  beforeToolCall(input: {
    runId: string;
    sessionId: string;
    callId: string;
    name: string;
  }): Promise<void>;
  recordReceipt(input: ClientToolReceipt & { sessionId: string }): Promise<void>;
  finish(input: {
    runId: string;
    sessionId: string;
    status: Exclude<RuntimeTaskRunStatus, 'running'>;
  }): Promise<void>;
}

const RUN_LIMIT = 50;

export class RuntimeTaskRunLedger {
  private readonly runs = new Map<string, RuntimeTaskRunSnapshot>();

  begin(input: { runId: string; sessionId: string; requestId: string }): RuntimeTaskRunSnapshot {
    if (this.runs.has(input.runId)) throw new Error('任务编号重复，不能重放工具调用');
    if (this.runs.size >= RUN_LIMIT) {
      const oldestFinished = [...this.runs].find(([, run]) => run.status !== 'running');
      if (!oldestFinished) throw new Error('运行中的任务过多');
      this.runs.delete(oldestFinished[0]);
    }
    const now = Date.now();
    const snapshot: RuntimeTaskRunSnapshot = {
      ...input,
      status: 'running',
      receipts: [],
      activeCall: null,
      startedAt: now,
      updatedAt: now,
      provenance: 'client-reported',
    };
    this.runs.set(input.runId, snapshot);
    return copy(snapshot);
  }

  startCall(runId: string, callId: string, name: string): RuntimeTaskRunSnapshot {
    const run = this.requireRunning(runId);
    if (!callId || run.activeCall || run.receipts.some((receipt) => receipt.callId === callId))
      throw new Error('工具调用编号重复或上一调用尚未结算');
    run.activeCall = { callId, name };
    run.updatedAt = Date.now();
    return copy(run);
  }

  record(receipt: ToolExecutionReceipt): RuntimeTaskRunSnapshot {
    const run = this.requireRunning(receipt.runId);
    if (
      run.activeCall &&
      (run.activeCall.callId !== receipt.callId || run.activeCall.name !== receipt.name)
    )
      throw new Error('工具结果与正在执行的调用不匹配');
    if (run.receipts.some((existing) => existing.callId === receipt.callId))
      throw new Error('同一任务不能重复记录工具调用编号');
    run.receipts = [
      ...run.receipts,
      {
        runId: receipt.runId,
        callId: receipt.callId,
        name: receipt.name,
        status: receipt.status,
        provenance: 'client-reported',
      },
    ];
    if (run.activeCall?.callId === receipt.callId) run.activeCall = null;
    run.updatedAt = Date.now();
    return copy(run);
  }

  finish(runId: string, status: Exclude<RuntimeTaskRunStatus, 'running'>): RuntimeTaskRunSnapshot {
    const run = this.requireRunning(runId);
    if (run.activeCall) {
      run.receipts = [
        ...run.receipts,
        {
          runId,
          ...run.activeCall,
          status: 'unknown',
          provenance: 'client-reported',
        },
      ];
      run.activeCall = null;
      status = 'needs-review';
    }
    if (run.receipts.some((receipt) => receipt.status === 'unknown')) status = 'needs-review';
    run.status = status;
    run.updatedAt = Date.now();
    return copy(run);
  }

  markNeedsReview(runId: string): RuntimeTaskRunSnapshot {
    const run = this.runs.get(runId);
    if (!run) throw new Error('任务不存在');
    run.status = 'needs-review';
    run.updatedAt = Date.now();
    return copy(run);
  }

  get(runId: string): RuntimeTaskRunSnapshot | null {
    const run = this.runs.get(runId);
    return run ? copy(run) : null;
  }

  list(sessionId: string): RuntimeTaskRunSnapshot[] {
    return [...this.runs.values()].filter((run) => run.sessionId === sessionId).map(copy);
  }

  private requireRunning(runId: string): RuntimeTaskRunSnapshot {
    const run = this.runs.get(runId);
    if (!run || run.status !== 'running') throw new Error('任务不存在或已结束');
    return run;
  }
}

function copy(run: RuntimeTaskRunSnapshot): RuntimeTaskRunSnapshot {
  return {
    ...run,
    receipts: run.receipts.map((receipt) => ({ ...receipt })),
    activeCall: run.activeCall ? { ...run.activeCall } : null,
  };
}
