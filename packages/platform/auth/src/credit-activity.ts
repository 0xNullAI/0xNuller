import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId } from './index';
export interface CreditActivityEntry {
  id: string;
  kind: string;
  amountCredits: number | null;
  referenceId: string;
  priceVersion: string | null;
  createdAt: number;
  usageType: string | null;
  model: string | null;
  durationMs: number | null;
  status: string;
  reservedCredits: number | null;
  chargedCredits: number | null;
  holdActive: boolean;
  conversationId: string | null;
  runId?: string | null;
  relationshipId: string | null;
  taskId: string | null;
  scheduleId: string | null;
  roomId: string | null;
  triggerId: string | null;
  roleId: string | null;
  taskState: string | null;
  recoveryState: string | null;
  anomaly: string | null;
}
export interface CreditActivity {
  view: 'timeline';
  entries: CreditActivityEntry[];
  nextCursor: string | null;
}
export async function getCreditActivity(cursor?: string): Promise<CreditActivity> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  const response = await fetch(
    `${apiBaseUrl()}/api/auth/credits/activity?view=timeline${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    {
      credentials: 'include',
      cache: 'no-store',
      headers: { ...authRequestHeaders(), 'X-Account-Id': account },
    },
  );
  const data = (await response.json()) as CreditActivity & { error?: string };
  if (currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开账本');
  if (!response.ok) throw new Error(data.error ?? '账本暂不可用');
  if (data.view !== 'timeline') throw new Error('服务器暂未提供统一流水，请稍后重试');
  return data;
}
