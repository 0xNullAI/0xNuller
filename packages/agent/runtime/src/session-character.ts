import type { ActionContext, SessionSnapshot } from '@dg-agent/core';

/** A personal conversation keeps its first character identity when global selection changes. */
export function bindSessionCharacter(
  session: SessionSnapshot,
  context: ActionContext,
  characterId?: string,
  relationshipId?: string,
): void {
  const metadata = session.metadata;
  if (
    context.sourceType !== 'web' ||
    context.sourceChannelId ||
    metadata?.bridgeOrigin ||
    metadata?.groupId ||
    metadata?.roomId ||
    metadata?.conversationType === 'group' ||
    metadata?.conversationType === 'dm'
  )
    return;
  if (
    !characterId ||
    characterId.length > 200 ||
    characterId.trim() !== characterId ||
    [...characterId].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return;
  const bound = metadata?.promptPresetId;
  if (typeof bound === 'string' && bound && bound !== characterId) return;
  const next: Record<string, unknown> = { ...metadata, promptPresetId: characterId };
  if (!next.relationshipId && relationshipId && /^[A-Za-z0-9_-]{1,80}$/.test(relationshipId)) {
    next.relationshipId = relationshipId;
  }
  session.metadata = next;
}
