import type { ActionContext, SessionSnapshot } from '@dg-agent/core';
import { loadPrivateCompanionContext } from '@0xnullai/auth';

interface PrivateContextInput {
  enabled: boolean;
  characterId: string;
  context: ActionContext;
  session: Pick<SessionSnapshot, 'metadata'> & Partial<Pick<SessionSnapshot, 'messages'>>;
}

/** Explicitly opt-in for the account holder's own web conversation; never bridge/group execution. */
export async function loadPrivateConversationContext(input: PrivateContextInput): Promise<string> {
  const metadata = input.session.metadata;
  if (
    !input.enabled ||
    input.context.sourceType !== 'web' ||
    input.context.sourceChannelId ||
    metadata?.bridgeOrigin ||
    metadata?.groupId ||
    metadata?.roomId ||
    metadata?.conversationType === 'group' ||
    metadata?.conversationType === 'dm'
  )
    return '';
  const result = await loadPrivateCompanionContext({
    conversationId: input.context.sessionId,
    characterId: input.characterId,
    query: input.session.messages
      ?.slice()
      .reverse()
      .find((message) => message.role === 'user')
      ?.content.slice(0, 1000),
    relationshipId:
      typeof metadata?.relationshipId === 'string' ? metadata.relationshipId : undefined,
  });
  if (result.relationshipId && !metadata?.relationshipId) {
    input.session.metadata = { ...input.session.metadata, relationshipId: result.relationshipId };
  }
  return result.text;
}
