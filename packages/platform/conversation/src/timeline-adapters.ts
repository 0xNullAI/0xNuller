import type { TimelineAttachment, TimelineItem } from './timeline-contract';

interface PrivateMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
  kind?: 'camera_observation';
  sequence?: number;
  /** False only for an optimistic display row; server reads may omit this legacy hint. */
  serverConfirmed?: boolean;
}

interface PrivateAttachment {
  id: string;
  messageId: string;
  kind: 'image' | 'voice';
  mime: string;
  contentUrl: string;
}

/** Input must come from an authenticated, account-bound server read. */
export function adaptPrivateAiTimeline(input: {
  conversationId: string;
  accountId: string;
  agentId: string;
  agentName: string;
  messages: readonly PrivateMessage[];
  attachments?: readonly PrivateAttachment[];
}): TimelineItem[] {
  const byMessage = new Map<string, TimelineAttachment[]>();
  for (const attachment of input.attachments ?? []) {
    const list = byMessage.get(attachment.messageId) ?? [];
    list.push({
      kind: attachment.kind,
      objectId: attachment.id,
      mime: attachment.mime,
      access: 'account_request',
      path: attachment.contentUrl,
      availability: 'ready',
    });
    byMessage.set(attachment.messageId, list);
  }
  return input.messages.map((message, sourceIndex) => ({
    conversationId: input.conversationId,
    itemId: message.id,
    kind:
      message.kind === 'camera_observation'
        ? 'camera_observation'
        : message.role === 'system'
          ? 'system_event'
          : 'ai_message',
    author:
      message.role === 'user'
        ? { id: input.accountId, label: '我', source: 'account' as const }
        : message.role === 'system' || message.kind === 'camera_observation'
          ? { id: 'system', label: '系统', source: 'system' as const }
          : { id: input.agentId, label: input.agentName, source: 'agent' as const },
    createdAt: message.createdAt,
    status: message.serverConfirmed === false ? 'pending' : 'saved',
    body: message.content,
    attachments: byMessage.get(message.id) ?? [],
    ...(Number.isSafeInteger(message.sequence) && message.sequence! > 0
      ? { serverSequence: message.sequence }
      : {}),
    sourceIndex,
  }));
}

interface HumanMessage {
  id: string;
  serverConfirmed?: boolean;
  sendFailed?: boolean;
  fromSelf: boolean;
  senderId: string;
  senderName: string;
  text: string;
  timestamp: number;
  media?: {
    kind: 'image' | 'audio';
    objectId?: string;
    url: string;
    mime: string;
    durationMs?: number;
  };
}

/** Chat's DO-confirmed list order is retained; local optimistic rows remain pending. */
export function adaptHumanChatTimeline(input: {
  conversationId: string;
  messages: readonly HumanMessage[];
  mediaAccess: 'socket_capability' | 'room_authorized_url';
  mediaConnected?: boolean;
}): TimelineItem[] {
  return input.messages.map((message, sourceIndex) => ({
    conversationId: input.conversationId,
    itemId: message.id,
    kind:
      message.senderId === 'system'
        ? 'system_event'
        : message.senderId.startsWith('ai:')
          ? 'ai_message'
          : 'human_message',
    author: {
      id: message.senderId,
      label: message.senderName,
      source:
        message.senderId === 'system'
          ? ('system' as const)
          : message.senderId.startsWith('ai:')
            ? ('agent' as const)
            : message.fromSelf
              ? ('account' as const)
              : ('person' as const),
    },
    createdAt: message.timestamp,
    status: message.serverConfirmed === true ? 'saved' : message.sendFailed ? 'failed' : 'pending',
    body: message.text,
    attachments: message.media
      ? [
          {
            kind: message.media.kind === 'audio' ? ('voice' as const) : ('image' as const),
            objectId: message.media.objectId ?? null,
            mime: message.media.mime,
            access: input.mediaAccess,
            path: message.media.url.split(/[?#]/, 1)[0] ?? '',
            availability:
              input.mediaAccess === 'socket_capability' && !input.mediaConnected
                ? ('requires_connection' as const)
                : ('ready' as const),
            ...(message.media.durationMs == null ? {} : { durationMs: message.media.durationMs }),
          },
        ]
      : [],
    sourceIndex,
  }));
}

/** Use server sequence when present; never reorder legacy messages by device clock. */
export function orderTimelineItems(items: readonly TimelineItem[]): TimelineItem[] {
  const hasCompleteServerOrder = items.every(
    (item) => item.serverSequence != null || item.afterSequence != null,
  );
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (!hasCompleteServerOrder)
        return a.item.sourceIndex - b.item.sourceIndex || a.index - b.index;
      const aSequence = a.item.serverSequence ?? a.item.afterSequence;
      const bSequence = b.item.serverSequence ?? b.item.afterSequence;
      if (aSequence !== bSequence) return aSequence! - bSequence!;
      const aAfter = a.item.afterSequence != null ? 1 : 0;
      const bAfter = b.item.afterSequence != null ? 1 : 0;
      if (aAfter !== bAfter) return aAfter - bAfter;
      if (aAfter && bAfter) return a.item.itemId.localeCompare(b.item.itemId);
      return a.item.sourceIndex - b.item.sourceIndex || a.index - b.index;
    })
    .map(({ item }) => item);
}
