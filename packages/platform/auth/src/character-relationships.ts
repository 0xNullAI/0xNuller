import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId } from './index';

export interface CharacterRelationship {
  id: string;
  characterId: string;
  aiNickname: string;
  userPreferredName: string;
  relationshipType: string;
  notes: string;
  version: number;
  createdAt: number;
  updatedAt: number;
}
export type CharacterRelationshipInput = Omit<CharacterRelationship, 'createdAt' | 'updatedAt'>;

async function request<T>(path = '', init: RequestInit = {}): Promise<T> {
  const accountId = currentAuthUserId();
  const response = await fetch(`${apiBaseUrl()}/api/auth/character-relationships${path}`, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...authRequestHeaders(),
      ...(accountId ? { 'X-Account-Id': accountId } : {}),
    },
  });
  const data = (await response.json()) as T & { error?: string };
  if (currentAuthUserId() !== accountId) throw new Error('账号已切换，请重新打开角色关系');
  if (!response.ok) throw new Error(data.error ?? '角色关系暂时不可用，请稍后重试');
  return data;
}
/** Relationships are fetched from the server; no browser persistence or public projection. */
export function listCharacterRelationships(
  characterId?: string,
): Promise<{ items: CharacterRelationship[]; limit: number }> {
  return request(
    characterId === undefined ? '' : `?characterId=${encodeURIComponent(characterId)}`,
  );
}
/** Idempotently materialize one private AI identity for the signed-in account. */
export function ensureCharacterRelationship(
  characterId: string,
): Promise<{ item: CharacterRelationship }> {
  return request('/ensure', { method: 'PUT', body: JSON.stringify({ characterId }) });
}
export function getCharacterRelationship(id: string): Promise<{ item: CharacterRelationship }> {
  return request(`/${encodeURIComponent(id)}`);
}
export function saveCharacterRelationship(
  input: CharacterRelationshipInput,
): Promise<{ item: CharacterRelationship }> {
  const { id, ...body } = input;
  return request(`/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(body) });
}
export function deleteCharacterRelationship(id: string, version: number): Promise<{ ok: boolean }> {
  return request(`/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ version }),
  });
}
