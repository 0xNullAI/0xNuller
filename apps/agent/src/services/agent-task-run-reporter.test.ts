import { beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  getAgentRun: vi.fn(),
  claimAgentRunCall: vi.fn(),
  recordAgentRunCall: vi.fn(),
  finishAgentRun: vi.fn(),
}));

vi.mock('@0xnullai/auth', () => auth);

import { createAgentTaskRunReporter } from './agent-task-run-reporter.js';

const run = { runId: 'server-run-1', sessionId: 'conversation-1' };
const call = { ...run, callId: 'call-1', name: 'shock_start' };

beforeEach(() => {
  vi.resetAllMocks();
  auth.getAgentRun.mockResolvedValue({
    item: {
      id: run.runId,
      conversationId: run.sessionId,
      requestId: 'request-1',
      status: 'active',
    },
  });
  auth.claimAgentRunCall.mockResolvedValue({ claimToken: 'claim-token' });
  auth.recordAgentRunCall.mockResolvedValue({
    item: { callId: call.callId, name: call.name, status: 'succeeded' },
  });
  auth.finishAgentRun.mockResolvedValue({
    item: { id: run.runId, conversationId: run.sessionId, status: 'completed' },
  });
});

describe('server TaskRun reporter', () => {
  it('rejects a server downgrade instead of acknowledging a completed client run', async () => {
    const reporter = createAgentTaskRunReporter();
    await reporter.begin({ ...run, requestId: 'request-1' });
    await reporter.beforeToolCall(call);
    await reporter.recordReceipt({ ...call, status: 'succeeded' });
    auth.finishAgentRun.mockResolvedValue({
      item: { id: run.runId, conversationId: run.sessionId, status: 'needs_review' },
    });

    await expect(reporter.finish({ ...run, status: 'completed' })).rejects.toThrow(
      '服务器任务结果未确认',
    );
  });

  it('rejects a mismatched receipt before the model can rely on it', async () => {
    const reporter = createAgentTaskRunReporter();
    await reporter.beforeToolCall(call);
    auth.recordAgentRunCall.mockResolvedValue({
      item: { callId: call.callId, name: call.name, status: 'unknown' },
    });

    await expect(reporter.recordReceipt({ ...call, status: 'succeeded' })).rejects.toThrow(
      '服务器工具结果与本次调用不一致',
    );
    expect(auth.finishAgentRun).not.toHaveBeenCalled();
  });
});
