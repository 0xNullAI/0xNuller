import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId } from './index';
export interface CompanionScheduleInput {
  id: string;
  version: number;
  relationshipId: string;
  conversationId: string;
  kind: 'once' | 'weekly';
  localDate?: string;
  localTime: string;
  timeZone: string;
  weekdays: number[];
  quietStart: string;
  quietEnd: string;
  dailyLimit: number;
  template: string;
  mode?: 'template' | 'model';
  acceptedCredits?: number;
  generationPriceVersion?: string;
  contextConsent?: boolean;
  paused: boolean;
}
export interface ProactiveCapability {
  enabled: boolean;
  credits: number | null;
  priceVersion: string;
  model: string;
  reason: string | null;
}
export interface CompanionSchedule extends CompanionScheduleInput {
  nextRunAt: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface CompanionNotification {
  id: string;
  conversationId: string;
  messageId: string;
  createdAt: number;
  readAt: number | null;
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const accountId = currentAuthUserId();
  if (!accountId) throw new Error('请先登录');
  const response = await fetch(`${apiBaseUrl()}/api/auth/${path}`, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...authRequestHeaders(),
      'X-Account-Id': accountId,
    },
  });
  const data = (await response.json()) as T & { error?: string };
  if (currentAuthUserId() !== accountId) throw new Error('账号已切换，请重新打开定时消息');
  if (!response.ok) throw new Error(data.error ?? '定时消息暂不可用');
  return data;
}
export function listCompanionSchedules(
  relationshipId: string,
): Promise<{ items: CompanionSchedule[]; capability?: ProactiveCapability }> {
  return request(`companion-schedules?relationshipId=${encodeURIComponent(relationshipId)}`);
}
export function saveCompanionSchedule(
  input: CompanionScheduleInput,
): Promise<{ item: CompanionSchedule }> {
  const { id, ...body } = input;
  return request(`companion-schedules/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}
export function deleteCompanionSchedule(id: string, version: number): Promise<{ ok: boolean }> {
  return request(`companion-schedules/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ version }),
  });
}
export function listCompanionNotifications(): Promise<{ items: CompanionNotification[] }> {
  return request('companion-notifications');
}
export function readCompanionNotification(id: string): Promise<{ ok: boolean }> {
  return request(`companion-notifications/${encodeURIComponent(id)}/read`, { method: 'PUT' });
}
