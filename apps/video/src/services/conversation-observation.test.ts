import { expect, it, vi } from 'vitest';
import type { PrivateConversationChannel } from '@0xnullai/auth';
import type { LlmImageInput } from '@dg-agent/core';
import { observeWithPrivateHistory } from './conversation-observation';
const image: LlmImageInput = {
  mediaType: 'image/jpeg',
  data: 'raw-frame-private',
  width: 1,
  height: 1,
  byteLength: 1,
};
it('does not start billable inference for a frame cancelled before observation begins', async () => {
  const controller = new AbortController();
  controller.abort();
  const observe = vi.fn();
  const stop = vi.fn().mockResolvedValue(undefined);
  const channel = {
    assertCurrent: vi.fn(),
    appendCameraObservation: vi.fn(),
  } as unknown as PrivateConversationChannel;
  await expect(
    observeWithPrivateHistory(channel, image, controller.signal, observe, stop),
  ).resolves.toBe('');
  expect(observe).not.toHaveBeenCalled();
  expect(channel.appendCameraObservation).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledOnce();
});
it('persists only final textual observations and never camera frames', async () => {
  const appendCameraObservation = vi.fn().mockResolvedValue({});
  const stop = vi.fn();
  const channel = {
    assertCurrent: vi.fn(),
    appendCameraObservation,
  } as unknown as PrivateConversationChannel;
  await expect(
    observeWithPrivateHistory(
      channel,
      image,
      new AbortController().signal,
      async () => '画面中有一张桌子',
      stop,
    ),
  ).resolves.toBe('画面中有一张桌子');
  expect(appendCameraObservation).toHaveBeenCalledWith(
    expect.stringMatching(/^camera-/),
    '画面中有一张桌子',
  );
  expect(JSON.stringify(appendCameraObservation.mock.calls)).not.toContain('raw-frame-private');
  expect(stop).not.toHaveBeenCalled();
});
it('stops control if server history fails instead of silently falling back to local storage', async () => {
  const stop = vi.fn().mockResolvedValue(undefined);
  const channel = {
    assertCurrent: vi.fn(),
    appendCameraObservation: vi.fn().mockRejectedValue(new Error('offline')),
  } as unknown as PrivateConversationChannel;
  await expect(
    observeWithPrivateHistory(
      channel,
      image,
      new AbortController().signal,
      async () => '结果',
      stop,
    ),
  ).rejects.toThrow('offline');
  expect(stop).toHaveBeenCalledOnce();
});
it('stops control and saves no observation when the camera request is cancelled', async () => {
  const controller = new AbortController();
  const appendCameraObservation = vi.fn();
  const stop = vi.fn().mockResolvedValue(undefined);
  const channel = {
    assertCurrent: vi.fn(),
    appendCameraObservation,
  } as unknown as PrivateConversationChannel;
  await expect(
    observeWithPrivateHistory(
      channel,
      image,
      controller.signal,
      async () => {
        controller.abort();
        return 'stale observation';
      },
      stop,
    ),
  ).resolves.toBe('');
  expect(appendCameraObservation).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledOnce();
});
it('stops and discards account changes that occur while the frame is being processed', async () => {
  const assertCurrent = vi
    .fn()
    .mockImplementationOnce(() => {})
    .mockImplementationOnce(() => {
      throw new Error('account changed');
    });
  const appendCameraObservation = vi.fn();
  const stop = vi.fn().mockResolvedValue(undefined);
  const channel = {
    assertCurrent,
    appendCameraObservation,
  } as unknown as PrivateConversationChannel;
  await expect(
    observeWithPrivateHistory(
      channel,
      image,
      new AbortController().signal,
      async () => 'private',
      stop,
    ),
  ).rejects.toThrow('account changed');
  expect(appendCameraObservation).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledOnce();
});

it('discards an observation cancelled during final account validation', async () => {
  const controller = new AbortController();
  const appendCameraObservation = vi.fn();
  const stop = vi.fn().mockResolvedValue(undefined);
  const channel = {
    assertCurrent: vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => controller.abort()),
    appendCameraObservation,
  } as unknown as PrivateConversationChannel;
  await expect(
    observeWithPrivateHistory(channel, image, controller.signal, async () => '旧观察', stop),
  ).resolves.toBe('');
  expect(appendCameraObservation).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledOnce();
});

it('does not report an observation as completed when cancelled during server acknowledgement', async () => {
  const controller = new AbortController();
  const stop = vi.fn().mockResolvedValue(undefined);
  const cancelCameraObservation = vi.fn().mockResolvedValue(undefined);
  const appendCameraObservation = vi.fn(async (_id: string, _content: string) => {
    controller.abort();
    return {};
  });
  const channel = {
    assertCurrent: vi.fn(),
    appendCameraObservation,
    cancelCameraObservation,
  } as unknown as PrivateConversationChannel;
  await expect(
    observeWithPrivateHistory(channel, image, controller.signal, async () => '旧观察', stop),
  ).resolves.toBe('');
  expect(appendCameraObservation).toHaveBeenCalledOnce();
  expect(cancelCameraObservation).toHaveBeenCalledWith(appendCameraObservation.mock.calls[0]?.[0]);
  expect(stop).toHaveBeenCalledOnce();
});

it('revokes a submitted observation when cancellation overtakes its server acknowledgement', async () => {
  const controller = new AbortController();
  let finishAppend!: () => void;
  const appendCameraObservation = vi.fn(
    (_id: string, _content: string) =>
      new Promise<never>((resolve) => {
        finishAppend = () => resolve({} as never);
      }),
  );
  const cancelCameraObservation = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  const channel = {
    assertCurrent: vi.fn(),
    appendCameraObservation,
    cancelCameraObservation,
  } as unknown as PrivateConversationChannel;
  const pending = observeWithPrivateHistory(
    channel,
    image,
    controller.signal,
    async () => '旧观察',
    stop,
  );
  await vi.waitFor(() => expect(appendCameraObservation).toHaveBeenCalledOnce());
  controller.abort();
  await vi.waitFor(() => expect(cancelCameraObservation).toHaveBeenCalledOnce());
  finishAppend();
  await expect(pending).resolves.toBe('');
  expect(cancelCameraObservation).toHaveBeenCalledWith(appendCameraObservation.mock.calls[0]?.[0]);
});

it('does not silently claim cancellation when server revocation fails', async () => {
  const controller = new AbortController();
  const stop = vi.fn().mockResolvedValue(undefined);
  const channel = {
    assertCurrent: vi.fn(),
    appendCameraObservation: vi.fn(async () => {
      controller.abort();
      return {};
    }),
    cancelCameraObservation: vi.fn().mockRejectedValue(new Error('offline')),
  } as unknown as PrivateConversationChannel;
  await expect(
    observeWithPrivateHistory(channel, image, controller.signal, async () => '旧观察', stop),
  ).rejects.toThrow('服务器观察撤销未确认');
  expect(stop).toHaveBeenCalledOnce();
});
