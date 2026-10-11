import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';
export type MediaKind = 'image' | 'selfie' | 'video';
export interface MediaCapability {
  kind: MediaKind;
  model: string;
  credits: number | null;
  priceVersion: string;
  enabled: boolean;
  reason: string | null;
}
export interface MediaJob {
  id: string;
  kind: MediaKind;
  conversationId: string;
  relationshipId: string;
  prompt: string;
  state: string;
  credits: number;
  priceVersion: string;
  photoId: string | null;
  contentUrl: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface MediaJobInput {
  id: string;
  kind: MediaKind;
  conversationId: string;
  relationshipId: string;
  prompt: string;
  useConversationContext: boolean;
  useCharacterContext: boolean;
  acceptedCredits: number;
  priceVersion: string;
}
async function request<T>(
  path: string,
  parse: (response: Response) => Promise<T>,
  init: RequestInit = {},
): Promise<T> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  let valid = true;
  const unsubscribe = subscribeAuthChanges(() => {
    if (currentAuthUserId() !== account) valid = false;
  });
  const assertAccount = () => {
    if (!valid || currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开媒体');
  };
  try {
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
    assertAccount();
    if (!response.ok) {
      const data = (await response.json()) as { error?: string };
      assertAccount();
      throw new Error(data.error ?? '媒体服务暂不可用');
    }
    const result = await parse(response);
    assertAccount();
    return result;
  } finally {
    unsubscribe();
  }
}
export async function listMediaCapabilities(): Promise<{ items: MediaCapability[] }> {
  return request('media-capabilities', (response) => response.json());
}
export async function listMediaJobs(conversationId: string): Promise<{ items: MediaJob[] }> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  let valid = true;
  const unsubscribe = subscribeAuthChanges(() => {
    if (currentAuthUserId() !== account) valid = false;
  });
  const items: MediaJob[] = [];
  const seenCursors = new Set<string>();
  let before: string | null = null;
  try {
    do {
      const page: { items: MediaJob[]; nextBefore?: string | null } = await request(
        `media-jobs?conversationId=${encodeURIComponent(conversationId)}${before ? `&before=${encodeURIComponent(before)}` : ''}`,
        (response) => response.json(),
      );
      if (!valid || currentAuthUserId() !== account) throw new Error('账号已切换，请重新打开媒体');
      items.push(...page.items);
      before = page.nextBefore ?? null;
      if (before && seenCursors.has(before)) throw new Error('媒体分页位置重复，请重试');
      if (before) seenCursors.add(before);
    } while (before);
    return { items };
  } finally {
    unsubscribe();
  }
}
export async function createMediaJob(input: MediaJobInput): Promise<{ item: MediaJob }> {
  const { id, ...body } = input;
  return request(`media-jobs/${encodeURIComponent(id)}`, (response) => response.json(), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}
export async function deleteMediaJob(id: string): Promise<void> {
  await request(`media-jobs/${encodeURIComponent(id)}`, async () => undefined, {
    method: 'DELETE',
  });
}
export async function mediaJobBlob(id: string): Promise<Blob> {
  return request(`media-jobs/${encodeURIComponent(id)}/content`, (response) => response.blob());
}
