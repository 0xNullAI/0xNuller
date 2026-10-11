import { synthesisCredits } from '@0xnullai/ai-pricing';
import { authRequestHeaders, currentAuthUserId } from '@0xnullai/auth';
import { apiBaseUrl } from '@0xnullai/settings';

/** The server's quote; Credits per 10,000 billed characters, from its price table. */
export interface ManagedTtsOffer {
  perTenThousandChars: number;
  maxTextCharacters: number;
  priceVersion: string;
}
export interface ManagedTtsJob {
  id: string;
  state: 'running' | 'settlement_pending' | 'succeeded' | 'failed' | 'needs_review';
  credits: number | null;
  audioAvailable: boolean;
}

async function request(account: string, path: string, init: RequestInit = {}): Promise<Response> {
  if (currentAuthUserId() !== account) throw new Error('账户已切换，朗读已停止');
  const response = await fetch(`${apiBaseUrl()}/api/auth/managed-tts${path}`, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers: { ...authRequestHeaders(), 'X-Account-Id': account, ...init.headers },
  });
  if (currentAuthUserId() !== account) throw new Error('账户已切换，朗读已停止');
  return response;
}

export async function managedTtsOffer(
  account: string,
  signal?: AbortSignal,
): Promise<ManagedTtsOffer> {
  const response = await request(account, '', { signal });
  if (!response.ok) throw new Error('无法获取朗读 Credit 报价');
  const value = (await response.json()) as { enabled?: unknown; offer?: Partial<ManagedTtsOffer> };
  const offer = value.offer;
  if (
    value.enabled !== true ||
    !offer ||
    typeof offer.perTenThousandChars !== 'number' ||
    !Number.isFinite(offer.perTenThousandChars) ||
    offer.perTenThousandChars < 0 ||
    !Number.isSafeInteger(offer.maxTextCharacters) ||
    Number(offer.maxTextCharacters) <= 0 ||
    typeof offer.priceVersion !== 'string' ||
    !offer.priceVersion
  )
    throw new Error('托管朗读尚未配置');
  return offer as ManagedTtsOffer;
}

export function managedTtsMaxCredits(text: string, offer: ManagedTtsOffer): number {
  const length = Array.from(text).length;
  if (!text.trim() || !length || length > offer.maxTextCharacters)
    throw new Error('朗读内容为空或过长');
  // Same bound as the server: twice the code points, priced with the shared arithmetic.
  return synthesisCredits(offer, length * 2);
}

export async function createManagedTts(
  account: string,
  id: string,
  text: string,
  offer: ManagedTtsOffer,
  signal?: AbortSignal,
): Promise<ManagedTtsJob> {
  const response = await request(account, '', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      text,
      consent: true,
      acceptedMaxCredits: managedTtsMaxCredits(text, offer),
      priceVersion: offer.priceVersion,
    }),
  });
  if (!response.ok) throw new Error('托管朗读未完成，请查看 Credit 记录后重试');
  const value = (await response.json()) as { job?: ManagedTtsJob };
  if (!value.job || value.job.id !== id) throw new Error('朗读任务回执无效');
  return value.job;
}

export async function loadManagedTtsAudio(
  account: string,
  id: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const response = await request(account, `/${encodeURIComponent(id)}/audio`, { signal });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/mpeg'))
    throw new Error('朗读音频不可用，请稍后重试');
  const blob = await response.blob();
  if (!blob.size || blob.size > 4_000_000) throw new Error('朗读音频无效');
  return blob;
}

export async function loadManagedTtsJob(
  account: string,
  id: string,
  signal?: AbortSignal,
): Promise<ManagedTtsJob> {
  const response = await request(account, `/${encodeURIComponent(id)}`, { signal });
  if (!response.ok) throw new Error('朗读任务不可用');
  const value = (await response.json()) as { job?: ManagedTtsJob };
  if (!value.job || value.job.id !== id) throw new Error('朗读任务回执无效');
  return value.job;
}
