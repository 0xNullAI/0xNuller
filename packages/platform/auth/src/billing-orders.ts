import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId } from './index';
export interface BillingOrder {
  id: string;
  packageId: string;
  amountMinor: number;
  currency: string;
  credits: number;
  priceVersion: string;
  status: string;
  version: number;
  createdAt: number;
  expiresAt: number;
  updatedAt: number;
  accountId?: string;
}
export interface BillingCatalog {
  currency: string;
  priceVersion: string;
  onlinePaymentEnabled: boolean;
  channel: string;
  message: string;
  packages: Array<{ id: string; amountMinor: number; credits: number }>;
}
export interface BillingReconciliation {
  provider: string;
  event_id: string;
  order_id: string;
  payment_id: string;
  kind: string;
  amount_minor: number;
  currency: string;
  state: string;
  reason: string | null;
  created_at: number;
}
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  const response = await fetch(`${apiBaseUrl()}/api/auth/${path}`, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'Content-Type': 'application/json',
      ...authRequestHeaders(),
      'X-Account-Id': account,
    },
  });
  const body = (await response.json()) as T & { error?: string };
  if (currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开订单');
  if (!response.ok) throw new Error(body.error ?? '订单处理失败');
  return body;
}
export const getBillingCatalog = () => request<BillingCatalog>('billing/catalog');
export const listBillingOrders = (before?: number, admin = false) =>
  request<{ items: BillingOrder[]; nextCursor: number | null }>(
    `${admin ? 'admin/' : ''}billing/orders${before ? `?before=${before}` : ''}`,
  );
export const createBillingOrder = (id: string, packageId: string, priceVersion: string) =>
  request<{ item: BillingOrder }>(`billing/orders/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ packageId, priceVersion }),
  });
export const cancelBillingOrder = (order: BillingOrder) =>
  request<{ item: BillingOrder }>(`billing/orders/${encodeURIComponent(order.id)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ version: order.version }),
  });
export const requestBillingRefund = (order: BillingOrder, reason: string) =>
  request<{ item: BillingOrder }>(`billing/orders/${encodeURIComponent(order.id)}/refund-request`, {
    method: 'POST',
    body: JSON.stringify({ version: order.version, reason }),
  });
export const listBillingReconciliation = () =>
  request<{ events: BillingReconciliation[] }>('admin/billing/reconciliation');
export const confirmBillingPayment = (
  order: BillingOrder,
  paymentId: string,
  eventId: string,
  refund = false,
) =>
  request<{ state: 'applied' | 'needs_review' | 'conflict'; reason?: string }>(
    `admin/billing/orders/${encodeURIComponent(order.id)}/${refund ? 'confirm-refund' : 'confirm-payment'}`,
    {
      method: 'POST',
      body: JSON.stringify({
        paymentId,
        eventId,
        amountMinor: order.amountMinor,
        currency: order.currency,
        confirmedExternalPayment: true,
      }),
    },
  );

export interface TextBillingReview {
  id: string;
  accountId: string;
  model: string;
  state: string;
  status: string;
  confirmedCharge: number | null;
  charged: number | null;
  reserved: number;
  reason: string | null;
  updatedAt: number;
  attempts: number;
  nextAttemptAt: number;
  promptTokens: number | null;
  completionTokens: number | null;
  notes: Array<{ eventId: string; operatorId: string; note: string; createdAt: number }>;
}
export const listTextBillingReviews = (before?: number) =>
  request<{ items: TextBillingReview[]; nextCursor: number | null }>(
    `admin/billing/text-reconciliation${before ? `?before=${before}` : ''}`,
  );
export const recordTextBillingReview = (item: TextBillingReview, eventId: string, note: string) =>
  request<{ recorded: true }>('admin/billing/text-reconciliation/notes', {
    method: 'POST',
    body: JSON.stringify({
      id: item.id,
      eventId,
      note,
      observed: {
        state: item.state,
        status: item.status,
        updatedAt: item.updatedAt,
        confirmedCharge: item.confirmedCharge,
      },
    }),
  });

export interface VoiceBillingReview {
  id: string;
  accountId: string;
  status: string;
  charged: number | null;
  updatedAt: number;
  reason: string;
  requestedAction: string;
  durationMs: number;
  requestedCredits: number;
  reserved: number;
  priceVersion: string;
  holdUpdatedAt: number;
  createdAt: number;
  notes: TextBillingReview['notes'];
}
export interface VoiceReviewFilter {
  accountId?: string;
  from?: number;
  to?: number;
}
export const listVoiceBillingReviews = (filter: VoiceReviewFilter = {}, before?: number) => {
  const query = new URLSearchParams();
  if (before !== undefined) query.set('before', String(before));
  if (filter.accountId) query.set('accountId', filter.accountId);
  if (filter.from !== undefined) query.set('from', String(filter.from));
  if (filter.to !== undefined) query.set('to', String(filter.to));
  return request<{ items: VoiceBillingReview[]; nextCursor: number | null }>(
    `admin/billing/voice-reconciliation?${query}`,
  );
};
export const recordVoiceBillingReview = (item: VoiceBillingReview, eventId: string, note: string) =>
  request<{ recorded: true }>('admin/billing/voice-reconciliation/notes', {
    method: 'POST',
    body: JSON.stringify({
      id: item.id,
      accountId: item.accountId,
      eventId,
      note,
      observed: { status: item.status, updatedAt: item.updatedAt, charged: item.charged },
    }),
  });

export interface MediaBillingReview {
  sequence: number;
  id: string;
  accountId: string;
  jobId: string;
  reason: string;
  createdAt: number;
  jobUpdatedAt: number;
  kind: 'image' | 'selfie' | 'video';
  jobState: string;
  reservedAtReview: number;
  reservationStatus: string | null;
  reservationUpdatedAt: number | null;
  reservedNow: number | null;
  chargedNow: number | null;
  ledgerCount: number;
  ledgerAmount: number | null;
  notes: TextBillingReview['notes'];
}
export const listMediaBillingReviews = (before?: number) =>
  request<{ items: MediaBillingReview[]; nextCursor: number | null }>(
    `admin/billing/media-reconciliation${before ? `?before=${before}` : ''}`,
  );
export const recordMediaBillingReview = (item: MediaBillingReview, eventId: string, note: string) =>
  request<{ recorded: true }>('admin/billing/media-reconciliation/notes', {
    method: 'POST',
    body: JSON.stringify({
      id: item.id,
      accountId: item.accountId,
      eventId,
      note,
      observed: {
        createdAt: item.createdAt,
        jobUpdatedAt: item.jobUpdatedAt,
        reservationStatus: item.reservationStatus,
        reservationUpdatedAt: item.reservationUpdatedAt,
      },
    }),
  });

export interface AsrBillingReview {
  sequence: number;
  accountId: string;
  conversationId: string;
  attachmentId: string;
  reservationKey: string;
  state: string;
  maximumCredits: number;
  expectedCharge: number | null;
  seconds: number | null;
  priceVersion: string;
  startedAt: number;
  updatedAt: number;
  reservationStatus: string | null;
  chargedNow: number | null;
  ledgerCount: number;
}
export const listAsrBillingReviews = (before?: number) =>
  request<{ items: AsrBillingReview[]; nextCursor: number | null }>(
    `admin/billing/asr-reconciliation${before ? `?before=${before}` : ''}`,
  );
