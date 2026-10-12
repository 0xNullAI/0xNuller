import { authRequestHeaders } from '@0xnullai/auth';
import { MANAGED_SERVICE_URL } from '@0xnullai/llm-providers';

export interface ManagedVisionQuote {
  maxReservationCredits: number;
  priceVersion: string;
}

/** Display-only quote. The proxy and Auth independently enforce the live price. */
export async function loadManagedVisionQuote(signal?: AbortSignal): Promise<ManagedVisionQuote> {
  const response = await fetch(`${MANAGED_SERVICE_URL}/v1/models`, {
    method: 'GET',
    credentials: 'include',
    headers: authRequestHeaders(),
    signal,
  });
  if (!response.ok) throw new Error('无法获取视觉 Credit 报价');
  const body: unknown = await response.json();
  const data = (body as { data?: unknown })?.data;
  const model = Array.isArray(data)
    ? data.find((item) => item?.id === 'vision' && item.imageInput === true)
    : undefined;
  if (
    !model ||
    !Number.isSafeInteger(model.maxReservationCredits) ||
    model.maxReservationCredits <= 0 ||
    typeof model.priceVersion !== 'string' ||
    !model.priceVersion.trim()
  )
    throw new Error('视觉 Credit 报价不可用');
  return {
    maxReservationCredits: model.maxReservationCredits,
    priceVersion: model.priceVersion,
  };
}
