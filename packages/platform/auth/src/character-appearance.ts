import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';

export interface CharacterAppearance {
  photoId: string | null;
  scale: number;
  position: 'left' | 'center' | 'right';
  version: number;
}
export const DEFAULT_CHARACTER_APPEARANCE: CharacterAppearance = {
  photoId: null,
  scale: 35,
  position: 'right',
  version: 0,
};
async function request(
  relationshipId: string,
  appearance?: CharacterAppearance,
): Promise<CharacterAppearance> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  let changed = false;
  const unsubscribe = subscribeAuthChanges(() => {
    if (changed || currentAuthUserId() !== account) changed = true;
  });
  try {
    const response = await fetch(
      `${apiBaseUrl()}/api/auth/character-appearance/${encodeURIComponent(relationshipId)}`,
      {
        method: appearance ? 'PUT' : 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: {
          ...authRequestHeaders(),
          'X-Account-Id': account,
          'content-type': 'application/json',
        },
        ...(appearance ? { body: JSON.stringify(appearance) } : {}),
      },
    );
    const result = (await response.json()) as { item: CharacterAppearance; error?: string };
    if (changed || currentAuthUserId() !== account) throw new Error('账户已切换');
    if (!response.ok) throw new Error(result.error ?? '角色外观暂不可用');
    return result.item;
  } finally {
    unsubscribe();
  }
}
export function getCharacterAppearance(relationshipId: string): Promise<CharacterAppearance> {
  return request(relationshipId);
}
export async function saveCharacterAppearance(
  relationshipId: string,
  appearance: CharacterAppearance,
): Promise<CharacterAppearance> {
  const item = await request(relationshipId, appearance);
  window.dispatchEvent(new Event('0xnullai:appearance-changed'));
  return item;
}
/** Only platform photo IDs resolve to URLs. No arbitrary URL/data/SVG sources. */
export function characterPhotoPath(photoId: string): string {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(photoId)) throw new Error('图片编号无效');
  return `/api/auth/photos/${photoId}/content`;
}
