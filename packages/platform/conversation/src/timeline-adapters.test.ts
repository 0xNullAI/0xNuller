import { expect, it } from 'vitest';
import {
  adaptHumanChatTimeline,
  adaptPrivateAiTimeline,
  orderTimelineItems,
} from './timeline-adapters';
import type { TimelineItem } from './timeline-contract';

it('projects server-owned AI messages and attachments without treating camera observation as speech', () => {
  const items = adaptPrivateAiTimeline({
    accountId: 'alice',
    conversationId: 'conversation-1',
    agentId: 'character-1',
    agentName: '小雨',
    messages: [
      { id: 'image-message', role: 'user', content: '', createdAt: 9000, sequence: 5 },
      {
        id: 'observation',
        role: 'assistant',
        kind: 'camera_observation',
        content: '看到一棵树',
        createdAt: 1,
        sequence: 6,
      },
      { id: 'reply', role: 'assistant', content: '你好', createdAt: 2, sequence: 7 },
    ],
    attachments: [
      {
        id: 'object-1',
        messageId: 'image-message',
        kind: 'image',
        mime: 'image/png',
        contentUrl: '/private/objects/object-1',
      },
    ],
  });
  expect(items.map((item) => item.kind)).toEqual([
    'ai_message',
    'camera_observation',
    'ai_message',
  ]);
  expect(items[0]).toMatchObject({
    conversationId: 'conversation-1',
    itemId: 'image-message',
    status: 'saved',
    serverSequence: 5,
    author: { source: 'account' },
  });
  expect(items[0]?.attachments).toEqual([
    {
      kind: 'image',
      objectId: 'object-1',
      mime: 'image/png',
      access: 'account_request',
      path: '/private/objects/object-1',
      availability: 'ready',
    },
  ]);
  expect(items[1]?.author.source).toBe('system');
  expect(orderTimelineItems([...items].reverse()).map((item) => item.itemId)).toEqual([
    'image-message',
    'observation',
    'reply',
  ]);
});

it('does not classify a locally accepted AI user row as saved', () => {
  const [item] = adaptPrivateAiTimeline({
    accountId: 'alice',
    conversationId: 'conversation-1',
    agentId: 'character-1',
    agentName: '小雨',
    messages: [
      { id: 'optimistic', role: 'user', content: '刚发送', createdAt: 1, serverConfirmed: false },
    ],
  });
  expect(item?.status).toBe('pending');
});

it('keeps Chat optimistic messages pending and does not invent an object ID from a media URL', () => {
  const [confirmed, pending] = adaptHumanChatTimeline({
    conversationId: 'dm:alice:bob',
    mediaAccess: 'socket_capability',
    mediaConnected: false,
    messages: [
      {
        id: 'saved',
        serverConfirmed: true,
        fromSelf: false,
        senderId: 'bob',
        senderName: 'Bob',
        text: '',
        timestamp: 100,
        media: {
          kind: 'audio',
          url: '/api/media/dm/file?token=secret',
          mime: 'audio/webm',
          durationMs: 3000,
        },
      },
      {
        id: 'draft',
        fromSelf: true,
        senderId: 'alice',
        senderName: 'Alice',
        text: '稍等',
        timestamp: 1,
      },
    ],
  });
  expect(confirmed).toMatchObject({
    kind: 'human_message',
    status: 'saved',
    author: { source: 'person' },
  });
  expect(confirmed?.attachments).toEqual([
    {
      kind: 'voice',
      objectId: null,
      mime: 'audio/webm',
      access: 'socket_capability',
      path: '/api/media/dm/file',
      availability: 'requires_connection',
      durationMs: 3000,
    },
  ]);
  expect(pending).toMatchObject({ status: 'pending', author: { source: 'account' } });
});

it('retains the exact Chat media object ID carried by the server wire record', () => {
  const [item] = adaptHumanChatTimeline({
    conversationId: 'group-1',
    mediaAccess: 'room_authorized_url',
    messages: [
      {
        id: 'message-1',
        serverConfirmed: true,
        fromSelf: false,
        senderId: 'peer',
        senderName: 'Peer',
        text: '',
        timestamp: 1,
        media: {
          kind: 'image',
          objectId: 'r2-object-1',
          url: '/api/media/group-1/r2-object-1',
          mime: 'image/png',
        },
      },
    ],
  });
  expect(item?.attachments[0]).toMatchObject({
    objectId: 'r2-object-1',
    access: 'room_authorized_url',
    availability: 'ready',
  });
});

it('places task cards after their server anchor and retains legacy Chat source order', () => {
  const [first, second] = adaptPrivateAiTimeline({
    accountId: 'a',
    conversationId: 'c',
    agentId: 'ai',
    agentName: 'AI',
    messages: [
      { id: 'first', role: 'user', content: 'one', createdAt: 100, sequence: 1 },
      { id: 'second', role: 'assistant', content: 'two', createdAt: 1, sequence: 2 },
    ],
  });
  const job: TimelineItem = {
    ...first!,
    itemId: 'media:job',
    kind: 'media_job',
    serverSequence: undefined,
    afterSequence: 1,
    status: 'needs_review',
    sourceIndex: 10,
  };
  expect(orderTimelineItems([second!, job, first!]).map((item) => item.itemId)).toEqual([
    'first',
    'media:job',
    'second',
  ]);

  const legacy = adaptHumanChatTimeline({
    conversationId: 'room',
    mediaAccess: 'room_authorized_url',
    messages: [
      {
        id: 'older',
        fromSelf: false,
        senderId: 'bob',
        senderName: 'Bob',
        text: 'one',
        timestamp: 900,
      },
      {
        id: 'newer',
        fromSelf: false,
        senderId: 'bob',
        senderName: 'Bob',
        text: 'two',
        timestamp: 1,
      },
    ],
  });
  expect(orderTimelineItems([...legacy].reverse()).map((item) => item.itemId)).toEqual([
    'older',
    'newer',
  ]);
});
