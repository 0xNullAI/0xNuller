import { beforeEach, expect, it, vi } from 'vitest';
import { PrivateConversationAttachmentChannel } from './conversation-attachments';

const auth = vi.hoisted(() => ({ account: 'alice', listeners: new Set<() => void>() }));
vi.mock('./index', () => ({
  currentAuthUserId: () => auth.account,
  authRequestHeaders: () => ({}),
  subscribeAuthChanges: (listener: () => void) => {
    auth.listeners.add(listener);
    return () => auth.listeners.delete(listener);
  },
}));

beforeEach(() => {
  auth.account = 'alice';
  auth.listeners.clear();
  vi.unstubAllGlobals();
});

it('binds uploads and reads to one account and conversation', async () => {
  const updated = vi.fn();
  window.addEventListener('0xnullai:conversation-updated', updated);
  const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
    Response.json(
      init?.method === 'POST'
        ? { attachment: { id: 'a', messageId: String(_url).endsWith('/commit') ? 'm' : null } }
        : { items: [] },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const channel = new PrivateConversationAttachmentChannel('alice', 's');
  await channel.upload(new Blob(['OggSxxxx'], { type: 'audio/ogg' }));
  expect(String(fetcher.mock.calls[0]?.[0])).toContain('/conversations/s/attachments');
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: 'POST',
    headers: {
      'X-Account-Id': 'alice',
      'content-type': 'audio/ogg',
    },
  });
  expect(String(fetcher.mock.calls[1]?.[0])).toContain('/attachments/a/commit');
  expect(updated).toHaveBeenCalledOnce();
  window.removeEventListener('0xnullai:conversation-updated', updated);
  channel.dispose();
});

it('rejects a late A→B→A upload result', async () => {
  const updated = vi.fn();
  window.addEventListener('0xnullai:conversation-updated', updated);
  const fetcher = vi.fn<typeof fetch>(async () => {
    auth.account = 'bob';
    for (const listener of auth.listeners) listener();
    auth.account = 'alice';
    return Response.json({ attachment: { id: 'a' } });
  });
  vi.stubGlobal('fetch', fetcher);
  const channel = new PrivateConversationAttachmentChannel('alice', 's');
  await expect(channel.upload(new Blob(['OggSxxxx'], { type: 'audio/ogg' }))).rejects.toThrow(
    '账号已切换',
  );
  expect(fetcher).toHaveBeenCalledOnce();
  expect(updated).not.toHaveBeenCalled();
  window.removeEventListener('0xnullai:conversation-updated', updated);
  channel.dispose();
});

it('sends voice text only in the account-bound commit request', async () => {
  const fetcher = vi.fn<typeof fetch>(async (_url) =>
    Response.json({
      attachment: { id: 'a', messageId: String(_url).endsWith('/commit') ? 'm' : null },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  const channel = new PrivateConversationAttachmentChannel('alice', 's');
  await channel.upload(new Blob(['OggSxxxx'], { type: 'audio/ogg' }), '  今天聊小猫  ');
  expect(fetcher.mock.calls[0]?.[1]?.body).toBeInstanceOf(Blob);
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
    method: 'POST',
    body: JSON.stringify({ caption: '今天聊小猫' }),
    headers: { 'X-Account-Id': 'alice', 'content-type': 'application/json' },
  });
  channel.dispose();
});

it('quotes saved voice transcription before explicit price acceptance', async () => {
  const offer = { rate: 2, maxCredits: 600, priceVersion: 'qwen3-asr-flash-v1:2' };
  const fetcher = vi.fn<typeof fetch>(async (_url, init) =>
    Response.json(
      init?.method === 'POST'
        ? { job: { state: 'running', transcript: null } }
        : { enabled: true, offer, job: null },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  const channel = new PrivateConversationAttachmentChannel('alice', 's');
  expect((await channel.transcription('clip')).offer).toEqual(offer);
  expect(fetcher.mock.calls[0]?.[1]?.method).toBeUndefined();
  await channel.transcribe('clip', offer);
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
    method: 'POST',
    headers: { 'X-Account-Id': 'alice', 'content-type': 'application/json' },
    body: JSON.stringify({
      consent: true,
      acceptedMaxCredits: 600,
      priceVersion: offer.priceVersion,
    }),
  });
  channel.dispose();
});
