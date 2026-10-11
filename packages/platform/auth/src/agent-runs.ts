import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';

export type AgentRunStatus =
  'active' | 'completed' | 'incomplete' | 'needs_review' | 'failed' | 'cancelled';
export type AgentCallStatus = 'claimed' | 'succeeded' | 'denied' | 'failed' | 'pending' | 'unknown';
export interface AgentRun {
  id: string;
  conversationId: string;
  requestId: string;
  status: AgentRunStatus;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
  provenance: 'client-reported';
}
export interface AgentRunCall {
  callId: string;
  name: string;
  status: AgentCallStatus;
  createdAt: number;
  updatedAt: number;
  provenance: 'client-reported';
}

// A run owner capability lives only in the creating window's memory. A second
// window may inspect the run but cannot append a different callId to replay work.
const ownerTokens = new Map<string, string>();
const OWNER_TOKEN = /^[a-f0-9-]{36}$/;
let observedAccount: string | null = null;
let observingAuth = false;
const ownerKey = (accountId: string, conversationId: string, runId: string) =>
  `${accountId}\0${conversationId}\0${runId}`;
function observeAccount() {
  const account = currentAuthUserId();
  if (account !== observedAccount) {
    ownerTokens.clear();
    observedAccount = account;
  }
  if (!observingAuth) {
    observingAuth = true;
    subscribeAuthChanges(() => {
      const next = currentAuthUserId();
      if (next !== observedAccount) {
        ownerTokens.clear();
        observedAccount = next;
      }
    });
  }
  return account;
}
function ownerTokenFor(conversationId: string, runId: string): string {
  const account = observeAccount();
  const token = account && ownerTokens.get(ownerKey(account, conversationId, runId));
  if (!token) throw new Error('此窗口没有任务执行权，请先核对原任务状态，不要直接重试操作');
  return token;
}

async function request<T>(
  conversationId: string,
  suffix: string,
  init: RequestInit = {},
): Promise<T> {
  const accountId = observeAccount();
  if (!accountId) throw new Error('请先登录');
  const url = `${apiBaseUrl()}/api/auth/agent-runs${suffix}?conversationId=${encodeURIComponent(conversationId)}`;
  let valid = true;
  const unsubscribe = subscribeAuthChanges(() => {
    if (currentAuthUserId() !== accountId) valid = false;
  });
  const assertAccount = () => {
    if (!valid || currentAuthUserId() !== accountId) throw new Error('账号已切换，请重新打开会话');
  };
  try {
    const response = await fetch(url, {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...authRequestHeaders(),
        'X-Account-Id': accountId,
      },
    });
    assertAccount();
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    assertAccount();
    if (!response.ok) throw new Error(data.error ?? '任务记录暂不可用');
    return data;
  } finally {
    unsubscribe();
  }
}

/** A repeat requestId is never allowed to start another execution. */
export async function startAgentRun(conversationId: string, requestId: string) {
  const account = observeAccount();
  const result = await request<{ item: AgentRun; claimed: boolean; ownerToken?: string }>(
    conversationId,
    '',
    {
      method: 'POST',
      body: JSON.stringify({ conversationId, requestId }),
    },
  );
  if (result.claimed) {
    if (
      !account ||
      currentAuthUserId() !== account ||
      !result.ownerToken ||
      !OWNER_TOKEN.test(result.ownerToken)
    )
      throw new Error('任务执行权未确认，不能开始 Agent 回复');
    if (ownerTokens.size >= 100) ownerTokens.delete(ownerTokens.keys().next().value!);
    ownerTokens.set(ownerKey(account, conversationId, result.item.id), result.ownerToken);
  }
  return { item: result.item, claimed: result.claimed };
}
export function getAgentRun(conversationId: string, runId: string) {
  return request<{ item: AgentRun; calls: AgentRunCall[] }>(
    conversationId,
    `/${encodeURIComponent(runId)}`,
  );
}
export function listAgentRuns(conversationId: string) {
  return request<{ items: AgentRun[] }>(conversationId, '');
}
export async function claimAgentRunCall(
  conversationId: string,
  runId: string,
  callId: string,
  name: string,
) {
  return request<{ item: AgentRunCall; claimToken: string }>(
    conversationId,
    `/${encodeURIComponent(runId)}/calls/${encodeURIComponent(callId)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ name, ownerToken: ownerTokenFor(conversationId, runId) }),
    },
  );
}
export function recordAgentRunCall(
  conversationId: string,
  runId: string,
  callId: string,
  claimToken: string,
  status: Exclude<AgentCallStatus, 'claimed'>,
) {
  return request<{ item: AgentRunCall }>(
    conversationId,
    `/${encodeURIComponent(runId)}/calls/${encodeURIComponent(callId)}/receipt`,
    { method: 'PUT', body: JSON.stringify({ claimToken, status }) },
  );
}
export async function finishAgentRun(
  conversationId: string,
  runId: string,
  status: Exclude<AgentRunStatus, 'active'>,
) {
  return request<{ item: AgentRun }>(conversationId, `/${encodeURIComponent(runId)}/finish`, {
    method: 'PUT',
    body: JSON.stringify({ status, ownerToken: ownerTokenFor(conversationId, runId) }),
  });
}
