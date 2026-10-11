// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { canUsePrivateImageInput, readPrivateImageForModel } from './private-image-input.js';

const auth = vi.hoisted(() => ({ read: vi.fn(), dispose: vi.fn() }));
vi.mock('@0xnullai/auth', () => ({
  PrivateConversationAttachmentChannel: class {
    constructor(
      readonly accountId: string,
      readonly conversationId: string,
    ) {}
    read = auth.read;
    dispose = auth.dispose;
  },
}));

const attachment = {
  id: 'image-1',
  messageId: 'message-1',
  kind: 'image' as const,
  mime: 'image/png',
  size: 3,
  createdAt: 1,
  contentUrl: '/private/image-1',
};

beforeEach(() => {
  auth.read.mockReset();
  auth.dispose.mockReset();
});

it('withholds ordinary chat vision from text-only and managed observation providers', () => {
  expect(canUsePrivateImageInput(false, 'openai')).toBe(false);
  expect(canUsePrivateImageInput(true, 'managed')).toBe(false);
  expect(canUsePrivateImageInput(true, 'openai')).toBe(true);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('reads an authorized image and sends a bounded transient JPEG to the model', async () => {
  auth.read.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
  const close = vi.fn();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn().mockResolvedValue({ width: 1200, height: 600, close }),
  );
  const originalCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag, options) => {
    if (tag !== 'canvas') return originalCreate(tag, options);
    return {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) =>
        callback(new Blob(['jpeg'], { type: 'image/jpeg' })),
    } as unknown as HTMLCanvasElement;
  });
  expect(await readPrivateImageForModel('alice', 'chat-1', attachment)).toEqual({
    mediaType: 'image/jpeg',
    data: 'anBlZw==',
    width: 768,
    height: 384,
    byteLength: 4,
  });
  expect(auth.read).toHaveBeenCalledWith(attachment);
  expect(auth.dispose).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it('rejects unsupported or oversized attachments before fetching pixels', async () => {
  await expect(
    readPrivateImageForModel('alice', 'chat-1', { ...attachment, kind: 'voice' }),
  ).rejects.toThrow('不能用于图片理解');
  await expect(
    readPrivateImageForModel('alice', 'chat-1', { ...attachment, size: 8_000_001 }),
  ).rejects.toThrow('不能用于图片理解');
  expect(auth.read).not.toHaveBeenCalled();
});

it('rejects unexpected content returned by the private attachment endpoint', async () => {
  auth.read.mockResolvedValue(new Blob(['bad'], { type: 'text/plain' }));
  await expect(readPrivateImageForModel('alice', 'chat-1', attachment)).rejects.toThrow(
    '图片内容与附件记录不一致',
  );
  expect(auth.dispose).toHaveBeenCalledOnce();
});
