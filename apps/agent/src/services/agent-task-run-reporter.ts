import { claimAgentRunCall, finishAgentRun, getAgentRun, recordAgentRunCall } from '@0xnullai/auth';

type RuntimeStatus = 'completed' | 'incomplete' | 'needs-review' | 'aborted' | 'failed';
type ReceiptStatus = 'succeeded' | 'denied' | 'failed' | 'pending' | 'unknown';

/** The server claim prevents a retried model call from executing twice. Reports are client observations. */
export function createAgentTaskRunReporter() {
  const claimTokens = new Map<string, string>();
  const key = (runId: string, callId: string) => `${runId}\0${callId}`;
  return {
    async begin(input: { runId: string; sessionId: string; requestId: string }) {
      const { item } = await getAgentRun(input.sessionId, input.runId);
      if (
        item.conversationId !== input.sessionId ||
        item.requestId !== input.requestId ||
        item.status !== 'active'
      )
        throw new Error('服务器任务状态已变化，请重新发送消息');
    },
    async beforeToolCall(input: {
      runId: string;
      sessionId: string;
      callId: string;
      name: string;
    }) {
      const claimed = await claimAgentRunCall(
        input.sessionId,
        input.runId,
        input.callId,
        input.name,
      );
      claimTokens.set(key(input.runId, input.callId), claimed.claimToken);
    },
    async recordReceipt(input: {
      runId: string;
      sessionId: string;
      callId: string;
      name: string;
      status: ReceiptStatus;
    }) {
      const callKey = key(input.runId, input.callId);
      const token = claimTokens.get(callKey);
      if (!token) throw new Error('工具调用未取得服务器执行许可');
      const { item } = await recordAgentRunCall(
        input.sessionId,
        input.runId,
        input.callId,
        token,
        input.status,
      );
      if (item.callId !== input.callId || item.name !== input.name || item.status !== input.status)
        throw new Error('服务器工具结果与本次调用不一致');
      claimTokens.delete(callKey);
    },
    async finish(input: { runId: string; sessionId: string; status: RuntimeStatus }) {
      const status =
        input.status === 'needs-review'
          ? 'needs_review'
          : input.status === 'aborted'
            ? 'cancelled'
            : input.status;
      try {
        const { item } = await finishAgentRun(input.sessionId, input.runId, status);
        if (
          item.id !== input.runId ||
          item.conversationId !== input.sessionId ||
          item.status !== status
        )
          throw new Error('服务器任务结果未确认，请核对工具记录');
      } finally {
        for (const callKey of claimTokens.keys())
          if (callKey.startsWith(`${input.runId}\0`)) claimTokens.delete(callKey);
      }
    },
  };
}
