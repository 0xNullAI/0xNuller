import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId } from './index';
export interface AgentTaskStep {
  id: string;
  title: string;
  status: 'pending' | 'done' | 'skipped';
}
export interface AgentTask {
  id: string;
  conversationId: string;
  title: string;
  steps: AgentTaskStep[];
  status: 'planned' | 'active' | 'paused' | 'completed';
  version: number;
  createdAt: number;
  updatedAt: number;
}
export interface ConversationTextFile {
  id: string;
  conversationId: string;
  name: string;
  mime: string;
  byteLength: number;
  version: number;
  createdAt: number;
  content?: string;
}
async function request<T>(
  resource: 'agent-tasks' | 'conversation-files',
  conversationId: string,
  id?: string,
  init: RequestInit = {},
): Promise<T> {
  const accountId = currentAuthUserId();
  const response = await fetch(
    `${apiBaseUrl()}/api/auth/${resource}${id ? `/${encodeURIComponent(id)}` : ''}?conversationId=${encodeURIComponent(conversationId)}`,
    {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...authRequestHeaders(),
        ...(accountId ? { 'X-Account-Id': accountId } : {}),
      },
    },
  );
  const data = (await response.json()) as T & { error?: string };
  if (currentAuthUserId() !== accountId) throw new Error('账号已切换，请重新打开工作区');
  if (!response.ok) throw new Error(data.error ?? '工作区暂不可用');
  return data;
}
export function listAgentTasks(conversationId: string): Promise<{ items: AgentTask[] }> {
  return request('agent-tasks', conversationId);
}
export function saveAgentTask(
  conversationId: string,
  input: Pick<AgentTask, 'id' | 'title' | 'steps' | 'status' | 'version'>,
): Promise<{ item: AgentTask }> {
  const { id, ...body } = input;
  return request('agent-tasks', conversationId, id, { method: 'PUT', body: JSON.stringify(body) });
}
export function deleteAgentTask(
  conversationId: string,
  id: string,
  version: number,
): Promise<{ ok: boolean }> {
  return request('agent-tasks', conversationId, id, {
    method: 'DELETE',
    body: JSON.stringify({ version }),
  });
}
export function listConversationFiles(
  conversationId: string,
): Promise<{ items: ConversationTextFile[] }> {
  return request('conversation-files', conversationId);
}
export function readConversationFile(
  conversationId: string,
  id: string,
): Promise<{ item: ConversationTextFile & { content: string } }> {
  return request('conversation-files', conversationId, id);
}
export function uploadConversationFile(
  conversationId: string,
  input: { id: string; name: string; mime: string; content: string },
): Promise<{ item: ConversationTextFile }> {
  const { id, ...body } = input;
  return request('conversation-files', conversationId, id, {
    method: 'PUT',
    body: JSON.stringify({ ...body, version: 0 }),
  });
}
export function deleteConversationFile(
  conversationId: string,
  id: string,
  version: number,
): Promise<{ ok: boolean }> {
  return request('conversation-files', conversationId, id, {
    method: 'DELETE',
    body: JSON.stringify({ version }),
  });
}
