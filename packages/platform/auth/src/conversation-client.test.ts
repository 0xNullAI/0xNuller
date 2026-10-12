import { beforeEach, expect, it, vi } from 'vitest';
import {
  PrivateConversationChannel,
  formatRecentConversationContext,
  preparePrivateConversation,
  type ConversationHistory,
  type ConversationRecord,
} from './conversation-client';
import { loadPrivateCompanionContext } from './private-conversation-context';
const auth = vi.hoisted(() => ({ account: 'alice', listeners: new Set<() => void>() }));
vi.mock('./index', () => ({
  currentAuthUserId: () => auth.account,
  authRequestHeaders: () => ({}),
  subscribeAuthChanges: (listener: () => void) => {
    auth.listeners.add(listener);
    return () => auth.listeners.delete(listener);
  },
}));
vi.mock('./private-conversation-context', () => ({
  loadPrivateCompanionContext: vi.fn(async () => ({ text: '' })),
}));
let row: ConversationRecord | null;
let conflict: boolean;
const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
  if (init?.method === 'PUT' && String(_url).endsWith('/relationship')) {
    const body = JSON.parse(String(init.body)) as {
      expectedRevision: number;
      relationshipId: string;
    };
    if (!row?.session || row.revision !== body.expectedRevision)
      return Response.json({}, { status: 409 });
    row = {
      ...row,
      revision: row.revision + 1,
      session: {
        ...row.session,
        metadata: { ...row.session.metadata, relationshipId: body.relationshipId },
      },
    };
    return Response.json(row);
  }
  if (init?.method === 'POST' && String(_url).endsWith('/messages')) {
    const body = JSON.parse(String(init.body)) as {
      expectedRevision: number;
      messages: ConversationHistory['messages'];
    };
    if (conflict) {
      conflict = false;
      row = {
        ...row!,
        revision: row!.revision + 1,
        session: {
          ...row!.session!,
          messages: [
            ...row!.session!.messages,
            { id: 'remote', role: 'user', content: '另一端', createdAt: 2 },
          ],
        },
      };
      return Response.json({}, { status: 409 });
    }
    const existing = new Map(row?.session?.messages.map((item) => [item.id, item]));
    if (
      body.messages.some((item) => {
        const old = existing.get(item.id);
        return (
          old &&
          (old.content !== item.content ||
            old.role !== item.role ||
            old.createdAt !== item.createdAt)
        );
      })
    )
      return Response.json({}, { status: 409 });
    const missing = body.messages.filter((item) => !existing.has(item.id));
    if (missing.length && body.expectedRevision !== row?.revision)
      return Response.json({}, { status: 409 });
    if (missing.length)
      row = {
        ...row!,
        revision: row!.revision + 1,
        session: { ...row!.session!, messages: [...row!.session!.messages, ...missing] },
      };
    return Response.json({ revision: row!.revision, added: missing.length });
  }
  if (!init?.method && String(_url).includes('/messages?')) {
    if (!row?.session || row.deleted) return Response.json({}, { status: 404 });
    const url = new URL(String(_url), 'https://test');
    const before = Number(url.searchParams.get('before'));
    const limit = Number(url.searchParams.get('limit'));
    const eligible = row.session.messages
      .map((message, index) => ({ ...message, sequence: index + 1 }))
      .filter((message) => message.sequence < before);
    const items = eligible.slice(-limit);
    return Response.json({
      items,
      nextBefore: eligible.length > limit ? items[0]!.sequence : null,
    });
  }
  if (init?.method !== 'PUT')
    return row
      ? Response.json(
          String(_url).includes('?window=20') && row.session
            ? { ...row, session: { ...row.session, messages: row.session.messages.slice(-20) } }
            : row,
          { status: row.deleted ? 410 : 200 },
        )
      : Response.json({}, { status: 404 });
  const body = JSON.parse(String(init.body)) as {
    expectedRevision: number;
    session: ConversationHistory;
  };
  if (conflict) {
    conflict = false;
    row = {
      ...row!,
      revision: row!.revision + 1,
      session: {
        ...row!.session!,
        messages: [
          ...row!.session!.messages,
          { id: 'remote', role: 'user', content: '另一端', createdAt: 2 },
        ],
      },
    };
    return Response.json({}, { status: 409 });
  }
  if (body.expectedRevision !== (row?.revision ?? 0)) return Response.json({}, { status: 409 });
  row = {
    id: 's',
    revision: (row?.revision ?? 0) + 1,
    updatedAt: 3,
    deleted: false,
    session: {
      ...body.session,
      messages: [...(row?.session?.messages ?? []), ...body.session.messages],
    },
  };
  return Response.json(row);
});
const channel = () =>
  new PrivateConversationChannel({ accountId: 'alice', conversationId: 's', characterId: 'scene' });
const message = { id: 'voice-m1', role: 'assistant' as const, content: '最终字幕', createdAt: 1 };
beforeEach(() => {
  auth.account = 'alice';
  auth.listeners.clear();
  row = null;
  conflict = false;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
it('retries CAS by adding only the same new immutable IDs and preserves concurrent remote messages', async () => {
  const client = channel();
  await client.ensure();
  conflict = true;
  await client.append([message]);
  expect(row?.session?.messages.map((m) => m.id)).toEqual(['remote', 'voice-m1']);
  const writes = fetchMock.mock.calls.filter(
    ([url, init]) => init?.method === 'POST' && String(url).endsWith('/messages'),
  );
  expect(JSON.parse(String(writes.at(-1)?.[1]?.body)).messages).toEqual([message]);
  expect(writes.at(-1)?.[1]?.headers).toMatchObject({ 'X-Account-Id': 'alice' });
  client.dispose();
});
it('sends observation retraction without waiting for an in-flight append', async () => {
  let acknowledge!: () => void;
  const pendingServer = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(init?.method ?? 'GET');
      if (init?.method === 'POST') {
        await pendingServer;
        return Response.json({
          id: 's',
          revision: 2,
          updatedAt: 2,
          deleted: false,
          session: {
            id: 's',
            createdAt: 1,
            updatedAt: 2,
            metadata: { promptPresetId: 'scene' },
            messages: [],
          },
        });
      }
      return Response.json({ cancelled: true });
    }),
  );
  const client = channel();
  const append = client.appendCameraObservation('camera-1', '画面');
  await vi.waitFor(() => expect(requests).toEqual(['POST']));
  await client.cancelCameraObservation('camera-1');
  expect(requests).toEqual(['POST', 'DELETE']);
  acknowledge();
  await append;
  client.dispose();
});
it('sends Video cancellation without waiting for staging and never confirms after account switch', async () => {
  let acknowledge!: () => void;
  const pendingServer = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(init?.method ?? 'GET');
      if (init?.method === 'POST') {
        await pendingServer;
        return Response.json({ staged: true });
      }
      return Response.json({ cancelled: true });
    }),
  );
  const client = channel();
  const stage = client.stageVideoReply(
    'video-reply-00000000-0000-4000-8000-000000000001',
    'user-1',
    '回复',
  );
  await vi.waitFor(() => expect(requests).toEqual(['POST']));
  await client.cancelVideoReply('video-reply-00000000-0000-4000-8000-000000000001');
  expect(requests).toEqual(['POST', 'DELETE']);
  acknowledge();
  await stage;
  auth.account = 'bob';
  for (const listener of auth.listeners) listener();
  await expect(
    client.confirmVideoReply('video-reply-00000000-0000-4000-8000-000000000001'),
  ).rejects.toMatchObject({ status: 403 });
  expect(requests).toEqual(['POST', 'DELETE']);
  client.dispose();
});
it('keeps typed camera observations out of the ordinary recent dialogue prompt', () => {
  const context = formatRecentConversationContext({
    id: 's',
    createdAt: 1,
    updatedAt: 3,
    metadata: {},
    messages: [
      { id: 'u', role: 'user', content: '你好', createdAt: 1 },
      {
        id: 'c',
        role: 'assistant',
        content: '有一张桌子',
        createdAt: 2,
        kind: 'camera_observation',
      },
    ],
  });
  expect(context).toContain('你好');
  expect(context).not.toContain('有一张桌子');
});
it('keeps the newest complete turns inside the bounded media context', () => {
  const context = formatRecentConversationContext({
    id: 's',
    createdAt: 1,
    updatedAt: 30,
    metadata: {},
    messages: Array.from({ length: 20 }, (_, index) => ({
      id: `m${index}`,
      role: index % 2 ? ('assistant' as const) : ('user' as const),
      content: `${index}:` + '长'.repeat(950),
      createdAt: index,
    })),
  });
  const selected = JSON.parse(context.split('\n').at(-1)!) as Array<{
    role: string;
    content: string;
  }>;
  expect(context.length).toBeLessThan(8_100);
  expect(selected.at(-1)?.content).toContain('19:');
  expect(selected[0]?.content).not.toContain('0:');
  expect(selected.every((item) => item.content.length <= 1_000)).toBe(true);
  expect(
    formatRecentConversationContext(
      {
        id: 's',
        createdAt: 1,
        updatedAt: 1,
        metadata: {},
        messages: [{ id: 'last', role: 'user', content: '最后一句', createdAt: 1 }],
      },
      10,
    ),
  ).toBe('');
});
it('reserves the total media prompt budget for relationship memory', async () => {
  vi.mocked(loadPrivateCompanionContext).mockResolvedValueOnce({ text: '记'.repeat(22_800) });
  row = {
    id: 's',
    revision: 1,
    updatedAt: 1,
    deleted: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      metadata: { promptPresetId: 'scene' },
      messages: Array.from({ length: 20 }, (_, index) => ({
        id: `m${index}`,
        role: 'user' as const,
        content: `${index}:` + '长'.repeat(950),
        createdAt: index,
      })),
    },
  };
  const prepared = await preparePrivateConversation('scene');
  expect(prepared.context.length).toBeLessThanOrEqual(24_000);
  expect(prepared.context).toContain('19:');
  expect(prepared.context).not.toContain('0:长');
  prepared.channel.dispose();
});
it('returns only recent ordinary chat messages for a resumed media conversation', async () => {
  row = {
    id: 's',
    revision: 1,
    updatedAt: 1,
    deleted: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      metadata: { promptPresetId: 'scene' },
      messages: [
        ...Array.from({ length: 15 }, (_, index) => ({
          id: `m${index}`,
          role: 'user' as const,
          content: `${index}`,
          createdAt: index,
        })),
        {
          id: 'camera',
          role: 'assistant',
          content: '画面观察',
          createdAt: 15,
          kind: 'camera_observation',
        },
        { id: 'reply', role: 'assistant', content: '接着聊', createdAt: 16 },
      ],
    },
  };
  const prepared = await preparePrivateConversation('scene');
  expect(prepared.recentMessages.map((item) => item.id)).toEqual([
    ...Array.from({ length: 11 }, (_, index) => `m${index + 4}`),
    'reply',
  ]);
  prepared.channel.dispose();
});
it('recovers prior text for Voice and Video when attachment-only messages fill the short window', async () => {
  row = {
    id: 's',
    revision: 1,
    lastSequence: 26,
    updatedAt: 1,
    deleted: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      metadata: { promptPresetId: 'scene' },
      messages: [
        { id: 'earlier', role: 'user', content: '我明天要看牙医，有点紧张', createdAt: 1 },
        ...Array.from({ length: 25 }, (_, index) => ({
          id: `attachment-${index}`,
          role: 'user' as const,
          content: '',
          createdAt: index + 2,
        })),
      ],
    },
  };
  const prepared = await preparePrivateConversation('scene');
  expect(prepared.context).toContain('我明天要看牙医');
  expect(prepared.context).not.toContain('"content":""');
  expect(prepared.recentMessages.map((item) => item.id)).toEqual(['earlier']);
  expect(loadPrivateCompanionContext).toHaveBeenCalledWith(
    expect.objectContaining({
      query: '我明天要看牙医，有点紧张',
    }),
  );
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/messages?'))).toHaveLength(
    2,
  );
  expect(
    fetchMock.mock.calls.some(
      ([url, init]) =>
        !init?.method &&
        String(url).includes('/conversations/') &&
        !String(url).includes('?window=20') &&
        !String(url).includes('/messages?'),
    ),
  ).toBe(false);
  prepared.channel.dispose();
});
it('caps backward scans when a long conversation has no recent text', async () => {
  row = {
    id: 's',
    revision: 1,
    lastSequence: 301,
    updatedAt: 1,
    deleted: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      metadata: { promptPresetId: 'scene' },
      messages: [
        { id: 'far-away', role: 'user', content: '很久以前', createdAt: 1 },
        ...Array.from({ length: 300 }, (_, index) => ({
          id: `attachment-${index}`,
          role: 'user' as const,
          content: '',
          createdAt: index + 2,
        })),
      ],
    },
  };
  const prepared = await preparePrivateConversation('scene');
  expect(prepared.context).not.toContain('很久以前');
  expect(prepared.recentMessages).toEqual([]);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/messages?'))).toHaveLength(
    6,
  );
  prepared.channel.dispose();
});
it('fails closed when the conversation changes during bounded media preparation', async () => {
  row = {
    id: 's',
    revision: 1,
    lastSequence: 26,
    updatedAt: 1,
    deleted: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      metadata: { promptPresetId: 'scene' },
      messages: Array.from({ length: 26 }, (_, index) => ({
        id: `attachment-${index}`,
        role: 'user' as const,
        content: '',
        createdAt: index + 1,
      })),
    },
  };
  const original = fetchMock.getMockImplementation()!;
  let changed = false;
  fetchMock.mockImplementation(async (...args) => {
    const response = await original(...args);
    if (!changed && String(args[0]).includes('/messages?')) {
      changed = true;
      row = { ...row!, revision: row!.revision + 1 };
    }
    return response;
  });
  try {
    await expect(preparePrivateConversation('scene')).rejects.toThrow('会话已变更');
  } finally {
    fetchMock.mockImplementation(original);
  }
});
it('rejects an A→B→A account switch during an older-message page', async () => {
  row = {
    id: 's',
    revision: 1,
    lastSequence: 26,
    updatedAt: 1,
    deleted: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      metadata: { promptPresetId: 'scene' },
      messages: Array.from({ length: 26 }, (_, index) => ({
        id: `attachment-${index}`,
        role: 'user' as const,
        content: '',
        createdAt: index + 1,
      })),
    },
  };
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (...args) => {
    const response = await original(...args);
    if (String(args[0]).includes('/messages?')) {
      auth.account = 'bob';
      for (const listener of auth.listeners) listener();
      auth.account = 'alice';
    }
    return response;
  });
  try {
    await expect(preparePrivateConversation('scene')).rejects.toThrow('账户已切换');
  } finally {
    fetchMock.mockImplementation(original);
  }
});
it('stops preparation when the server conversation is deleted between pages', async () => {
  row = {
    id: 's',
    revision: 1,
    lastSequence: 46,
    updatedAt: 1,
    deleted: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      metadata: { promptPresetId: 'scene' },
      messages: Array.from({ length: 46 }, (_, index) => ({
        id: `attachment-${index}`,
        role: 'user' as const,
        content: '',
        createdAt: index + 1,
      })),
    },
  };
  const original = fetchMock.getMockImplementation()!;
  let deleted = false;
  fetchMock.mockImplementation(async (...args) => {
    const response = await original(...args);
    if (!deleted && String(args[0]).includes('/messages?')) {
      deleted = true;
      row = { ...row!, deleted: true, session: null };
    }
    return response;
  });
  try {
    await expect(preparePrivateConversation('scene')).rejects.toThrow('会话不存在或已删除');
  } finally {
    fetchMock.mockImplementation(original);
  }
});
it('deduplicates final message retries and refuses changed final text', async () => {
  const client = channel();
  await client.append([message]);
  const revision = row?.revision;
  await client.append([message]);
  expect(row?.revision).toBe(revision);
  await expect(client.append([{ ...message, content: '替换原文' }])).rejects.toThrow(
    '字幕编号冲突',
  );
  expect(row?.session?.messages[0]?.content).toBe('最终字幕');
  client.dispose();
});
it('deduplicates a retry older than the recent window through the server append endpoint', async () => {
  row = {
    id: 's',
    revision: 1,
    updatedAt: 1,
    deleted: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      metadata: { promptPresetId: 'scene' },
      messages: [
        message,
        ...Array.from({ length: 25 }, (_, index) => ({
          id: `later-${index}`,
          role: 'user' as const,
          content: `later ${index}`,
          createdAt: index + 2,
        })),
      ],
    },
  };
  const client = channel();
  const saved = await client.append([message]);
  expect(saved.revision).toBe(1);
  expect(saved.session?.messages).toHaveLength(20);
  expect(row.session?.messages).toHaveLength(26);
  expect(fetchMock.mock.calls.some(([url]) => String(url).includes('?window=20'))).toBe(true);
  client.dispose();
});
it('keeps the server-selected scene when media appends a message to the same character chat', async () => {
  row = {
    id: 's',
    revision: 1,
    updatedAt: 1,
    deleted: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      metadata: { promptPresetId: 'scene', relationshipId: 'r', sceneId: 'market-cafe' },
      messages: [],
    },
  };
  const client = channel();
  await client.append([message]);
  expect(row?.session?.metadata).toEqual({
    promptPresetId: 'scene',
    relationshipId: 'r',
    sceneId: 'market-cafe',
  });
  client.dispose();
});
it('binds a relationship through metadata only, without reposting historical messages', async () => {
  row = {
    id: 's',
    revision: 1,
    updatedAt: 1,
    deleted: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      metadata: { promptPresetId: 'scene', sceneId: 'market-cafe' },
      messages: Array.from({ length: 30 }, (_, index) => ({
        id: `m${index}`,
        role: 'user' as const,
        content: `消息 ${index}`,
        createdAt: index,
      })),
    },
  };
  const client = channel();
  await client.bindRelationship('r');
  expect(row.session?.metadata).toMatchObject({ relationshipId: 'r', sceneId: 'market-cafe' });
  const write = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/relationship'));
  expect(JSON.parse(String(write?.[1]?.body))).toEqual({
    expectedRevision: 1,
    relationshipId: 'r',
  });
  expect(
    fetchMock.mock.calls.filter(
      ([url, init]) => init?.method === 'PUT' && !String(url).endsWith('/relationship'),
    ),
  ).toHaveLength(0);
  client.dispose();
});
it('prepares media from the server conversation scene instead of global selection', async () => {
  row = {
    id: 's',
    revision: 1,
    updatedAt: 1,
    deleted: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      metadata: { promptPresetId: 'scene', sceneId: 'market-cafe' },
      messages: [],
    },
  };
  const prepared = await preparePrivateConversation('scene');
  expect(prepared.sceneId).toBe('market-cafe');
  prepared.channel.dispose();
});
it('does not recreate deleted conversations or rebind another character', async () => {
  const client = channel();
  await client.ensure();
  row = { ...row!, deleted: true, session: null };
  await expect(client.append([message])).rejects.toMatchObject({ status: 410 });
  row = {
    id: 's',
    revision: 1,
    updatedAt: 1,
    deleted: false,
    session: {
      id: 's',
      createdAt: 1,
      updatedAt: 1,
      metadata: { promptPresetId: 'other' },
      messages: [],
    },
  };
  await expect(client.read()).rejects.toThrow('角色已变化');
  client.dispose();
});
it('invalidates pending channels on A to B to A switches without local fallback', async () => {
  const client = channel();
  auth.account = 'bob';
  for (const listener of auth.listeners) listener();
  auth.account = 'alice';
  for (const listener of auth.listeners) listener();
  await expect(client.append([message])).rejects.toMatchObject({ status: 403 });
  expect(fetchMock).not.toHaveBeenCalled();
  client.dispose();
});
