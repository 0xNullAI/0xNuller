import { apiBaseUrl } from '@0xnullai/settings';
import { authRequestHeaders, currentAuthUserId, subscribeAuthChanges } from './index';
import type { PersonalMemory } from './personal-memory';

export interface MemoryPerson {
  id: string;
  relationshipId: string;
  displayName: string;
  aliases: string[];
  version: number;
  createdAt: number;
  updatedAt: number;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const account = currentAuthUserId();
  if (!account) throw new Error('请先登录');
  let changed = false;
  const unsubscribe = subscribeAuthChanges(() => {
    changed = true;
  });
  try {
    const response = await fetch(`${apiBaseUrl()}/api/auth/${path}`, {
      ...init,
      credentials: 'include',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        ...authRequestHeaders(),
        'X-Account-Id': account,
      },
    });
    const data = (await response.json().catch(() => ({}))) as T & { error?: string };
    if (changed || currentAuthUserId() !== account)
      throw new Error('账号已切换，请重新打开关系记忆');
    if (!response.ok) throw new Error(data.error ?? '关系记忆暂时不可用，请稍后重试');
    return data;
  } finally {
    unsubscribe();
  }
}

/** Person aliases are private to one relationship; they only help rank its authorized facts. */
export function listMemoryPeople(
  relationshipId: string,
): Promise<{ items: MemoryPerson[]; limit: number }> {
  return request(`memory-people?relationshipId=${encodeURIComponent(relationshipId)}`);
}

export function saveMemoryPerson(
  person: Pick<MemoryPerson, 'id' | 'relationshipId' | 'displayName' | 'aliases' | 'version'>,
): Promise<{ item: MemoryPerson }> {
  const { id, ...body } = person;
  return request(`memory-people/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export function deleteMemoryPerson(id: string, version: number): Promise<{ ok: true }> {
  return request(`memory-people/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    body: JSON.stringify({ version }),
  });
}

export function linkMemoryPerson(
  person: Pick<MemoryPerson, 'id' | 'version'>,
  memory: Pick<PersonalMemory, 'id' | 'version'>,
): Promise<{ item: PersonalMemory }> {
  return request(`memory-people/${encodeURIComponent(person.id)}/link`, {
    method: 'PUT',
    body: JSON.stringify({
      personVersion: person.version,
      memoryId: memory.id,
      memoryVersion: memory.version,
    }),
  });
}

export function unlinkMemoryPerson(
  memory: Pick<PersonalMemory, 'id' | 'version'>,
): Promise<{ item: PersonalMemory }> {
  return request(`memory-facts/${encodeURIComponent(memory.id)}/person`, {
    method: 'DELETE',
    body: JSON.stringify({ version: memory.version }),
  });
}

/** Retire an old fact after its replacement has been saved in the same scope. */
export function supersedeMemoryFact(
  oldMemory: Pick<PersonalMemory, 'id' | 'version'>,
  replacement: Pick<PersonalMemory, 'id' | 'version'>,
): Promise<{ item: PersonalMemory }> {
  return request(`memory-facts/${encodeURIComponent(oldMemory.id)}/supersede`, {
    method: 'POST',
    body: JSON.stringify({
      version: oldMemory.version,
      replacementId: replacement.id,
      replacementVersion: replacement.version,
    }),
  });
}

/** Save a user's correction and retire the old fact in one server transaction. */
export function correctMemoryFact(
  oldMemory: Pick<PersonalMemory, 'id' | 'version'>,
  correction: Pick<PersonalMemory, 'kind' | 'title' | 'content'>,
): Promise<{ item: PersonalMemory; replacesId: string }> {
  return request(`memory-facts/${encodeURIComponent(oldMemory.id)}/correct`, {
    method: 'POST',
    body: JSON.stringify({ version: oldMemory.version, ...correction }),
  });
}
