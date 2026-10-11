import { expect, it, vi } from 'vitest';
import { sendRoomMedia } from './send-room-media';
const room = { roomId: 'private-room', mediaToken: 'capability' };
const reply = {
  replyTo: { id: 'source', senderId: 'ai:second', senderName: '同名', text: '原话' },
  mentions: [{ peerId: 'ai:second', displayName: '同名' }],
};
it.each(['image', 'audio'] as const)(
  'publishes %s with its exact reply and existing upload capability',
  async (kind) => {
    const blob = new Blob(['data'], { type: kind === 'image' ? 'image/jpeg' : 'audio/webm' });
    const media = { id: 'media', kind, mime: blob.type, size: blob.size };
    const upload = vi.fn(async () => media);
    const send = vi.fn(() => true);
    await sendRoomMedia({ room, active: () => room, upload, send }, blob, kind, {}, reply);
    expect(upload).toHaveBeenCalledWith('private-room', 'capability', blob, kind, {});
    expect(send).toHaveBeenCalledWith('', media, reply.mentions, reply.replyTo);
  },
);
it('does not upload stale room work or publish an upload after room/capability changes', async () => {
  const send = vi.fn(() => true);
  let current = { ...room };
  const upload = vi.fn(async () => {
    current = { roomId: 'other', mediaToken: 'other-cap' };
    return { id: 'm', kind: 'image' as const, mime: 'image/jpeg', size: 1 };
  });
  await expect(
    sendRoomMedia(
      { room, active: () => current, upload, send },
      new Blob(['x']),
      'image',
      undefined,
      reply,
    ),
  ).rejects.toThrow('会话已切换');
  expect(send).not.toHaveBeenCalled();
  await expect(
    sendRoomMedia({ room, active: () => current, upload, send }, new Blob(['x']), 'image'),
  ).rejects.toThrow('会话已切换');
  expect(upload).toHaveBeenCalledOnce();
});
it('reports transport rejection instead of clearing the reply as if it was delivered', async () => {
  await expect(
    sendRoomMedia(
      {
        room,
        active: () => room,
        upload: async () => ({ id: 'm', kind: 'audio', mime: 'audio/webm', size: 1 }),
        send: () => false,
      },
      new Blob(['x']),
      'audio',
      undefined,
      reply,
    ),
  ).rejects.toThrow('连接已断开');
});
