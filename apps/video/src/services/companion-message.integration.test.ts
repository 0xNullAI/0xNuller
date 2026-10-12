import { beforeEach, expect, it, vi } from 'vitest';
import {
  loadPrivateCompanionContext,
  type ConversationTextMessage,
  type PrivateConversationChannel,
} from '@0xnullai/auth';
import type { LlmClient, LlmImageInput } from '@dg-agent/core';
import {
  pauseForCompanionVideoMessage,
  replyToCompanionVideoMessage,
  VideoReplySaveUncertainError,
} from './companion-message.js';
import type { VideoAiDeviceRouter } from './video-ai-device-router.js';
import type { VisualSession } from './visual-session.js';

vi.mock('@0xnullai/auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadPrivateCompanionContext: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(loadPrivateCompanionContext).mockReset();
  vi.mocked(loadPrivateCompanionContext).mockResolvedValue({
    text: '[当前问题检索出的私人记忆]',
    relationshipId: 'relation-1',
  });
});

const image: LlmImageInput = {
  mediaType: 'image/jpeg',
  data: 'private-frame',
  width: 1,
  height: 1,
  byteLength: 1,
};
const user: ConversationTextMessage = {
  id: 'user-1',
  role: 'user',
  content: '窗边是什么？',
  createdAt: 1,
};

it('pauses observation and confirms device stop before a video question can continue', async () => {
  const order: string[] = [];
  let releaseStop!: () => void;
  const session = {
    getSnapshot: () => ({ status: 'running' }),
    pause: () => {
      order.push('pause');
    },
  } as unknown as VisualSession;
  const router = {
    stop: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          order.push('stop');
          releaseStop = resolve;
        }),
    ),
  } as unknown as VideoAiDeviceRouter;
  const pending = pauseForCompanionVideoMessage(session, router, new AbortController().signal).then(
    () => order.push('ready'),
  );
  expect(order).toEqual(['pause', 'stop']);
  releaseStop();
  await pending;
  expect(order).toEqual(['pause', 'stop', 'ready']);
});

it('fails closed when device stop cannot be confirmed', async () => {
  const session = {
    getSnapshot: () => ({ status: 'running' }),
    pause: vi.fn(),
  } as unknown as VisualSession;
  const router = {
    stop: vi.fn().mockRejectedValue(new Error('device disconnected')),
  } as unknown as VideoAiDeviceRouter;
  await expect(
    pauseForCompanionVideoMessage(session, router, new AbortController().signal),
  ).rejects.toThrow('无法确认设备已停止');
  expect(session.pause).toHaveBeenCalledOnce();
});

it('does not stop again or proceed after account-switch cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  const session = { getSnapshot: vi.fn(), pause: vi.fn() } as unknown as VisualSession;
  const router = { stop: vi.fn() } as unknown as VideoAiDeviceRouter;
  await expect(
    pauseForCompanionVideoMessage(session, router, controller.signal),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(session.pause).not.toHaveBeenCalled();
  expect(router.stop).not.toHaveBeenCalled();
});

it('does not resume a question if account switching aborts during device stop', async () => {
  const controller = new AbortController();
  let releaseStop!: () => void;
  const session = {
    getSnapshot: () => ({ status: 'running' }),
    pause: vi.fn(),
  } as unknown as VisualSession;
  const router = {
    stop: () =>
      new Promise<void>((resolve) => {
        releaseStop = resolve;
      }),
  } as unknown as VideoAiDeviceRouter;
  const pending = pauseForCompanionVideoMessage(session, router, controller.signal);
  controller.abort();
  releaseStop();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
function channel(saved = true) {
  const append = vi.fn(async () => ({}));
  const stageVideoReply = vi.fn(async () => undefined);
  const confirmVideoReply = vi.fn(async () => ({}));
  const cancelVideoReply = vi.fn(async () => undefined);
  return {
    selection: { conversationId: 'owned-chat', characterId: 'character-1' },
    assertCurrent: vi.fn(),
    read: vi.fn(async () => ({
      session: {
        createdAt: 1,
        updatedAt: 2,
        metadata: { relationshipId: 'relation-1' },
        messages: saved ? [user] : [],
      },
    })),
    append,
    stageVideoReply,
    confirmVideoReply,
    cancelVideoReply,
  } as unknown as PrivateConversationChannel;
}

it('answers from the current frame and server history, then saves an ordinary assistant message', async () => {
  const saved = channel();
  const runTurn = vi.fn(async (_input: unknown) => ({
    assistantMessage: '窗边有一只猫。',
    toolCalls: [],
  }));
  const model = { capabilities: { imageInput: true }, runTurn } as unknown as LlmClient;
  const reply = await replyToCompanionVideoMessage(
    saved,
    model,
    { name: '朋友', prompt: '温柔陪伴' },
    image,
    user,
    new AbortController().signal,
  );
  expect(reply).toMatchObject({ role: 'assistant', content: '窗边有一只猫。' });
  expect(saved.stageVideoReply).toHaveBeenCalledWith(reply.id, user.id, reply.content);
  expect(saved.confirmVideoReply).toHaveBeenCalledWith(reply.id);
  expect(runTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      image,
      tools: [],
      session: expect.objectContaining({ id: 'owned-chat' }),
    }),
  );
  expect(loadPrivateCompanionContext).toHaveBeenCalledWith({
    conversationId: 'owned-chat',
    characterId: 'character-1',
    relationshipId: 'relation-1',
    query: user.content,
  });
  expect((runTurn.mock.calls[0]?.[0] as { instructions: string }).instructions).toContain(
    '[当前问题检索出的私人记忆]',
  );
});

it('fails closed when the bound relationship no longer matches the server memory scope', async () => {
  vi.mocked(loadPrivateCompanionContext).mockResolvedValueOnce({ text: '' });
  const saved = channel();
  const runTurn = vi.fn();
  await expect(
    replyToCompanionVideoMessage(
      saved,
      { capabilities: { imageInput: true }, runTurn } as unknown as LlmClient,
      { name: '朋友', prompt: '温柔陪伴' },
      image,
      user,
      new AbortController().signal,
    ),
  ).rejects.toThrow('私人关系暂不可用');
  expect(runTurn).not.toHaveBeenCalled();
});

it('refuses to answer before the user message is saved', async () => {
  const saved = channel(false);
  const runTurn = vi.fn();
  await expect(
    replyToCompanionVideoMessage(
      saved,
      { capabilities: { imageInput: true }, runTurn } as unknown as LlmClient,
      { name: '朋友', prompt: '温柔陪伴' },
      image,
      user,
      new AbortController().signal,
    ),
  ).rejects.toThrow('尚未保存');
  expect(runTurn).not.toHaveBeenCalled();
});

it('does not invoke the model when video is cancelled during private memory loading', async () => {
  const controller = new AbortController();
  vi.mocked(loadPrivateCompanionContext).mockImplementationOnce(async () => {
    controller.abort();
    return { text: '[旧记忆]', relationshipId: 'relation-1' };
  });
  const saved = channel();
  const runTurn = vi.fn();
  await expect(
    replyToCompanionVideoMessage(
      saved,
      { capabilities: { imageInput: true }, runTurn } as unknown as LlmClient,
      { name: '朋友', prompt: '温柔陪伴' },
      image,
      user,
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(runTurn).not.toHaveBeenCalled();
  expect(saved.stageVideoReply).not.toHaveBeenCalled();
});

it('never saves a claimed tool action without an actual allowed tool', async () => {
  const saved = channel();
  const model = {
    capabilities: { imageInput: true },
    runTurn: vi.fn(async () => ({
      assistantMessage: '已调整设备',
      toolCalls: [{ name: 'video_device_control' }],
    })),
  } as unknown as LlmClient;
  await expect(
    replyToCompanionVideoMessage(
      saved,
      model,
      { name: '朋友', prompt: '温柔陪伴' },
      image,
      user,
      new AbortController().signal,
    ),
  ).rejects.toThrow('不允许设备');
  expect(saved.stageVideoReply).not.toHaveBeenCalled();
});

it('replaces an unverified device claim even when the provider returns no tool call', async () => {
  const saved = channel();
  const model = {
    capabilities: { imageInput: true },
    runTurn: vi.fn(async () => ({ assistantMessage: '已经启动设备。', toolCalls: [] })),
  } as unknown as LlmClient;
  const reply = await replyToCompanionVideoMessage(
    saved,
    model,
    { name: '朋友', prompt: '温柔陪伴' },
    image,
    user,
    new AbortController().signal,
  );
  expect(reply.content).toContain('没有可核实的工具执行结果');
  expect(reply.content).not.toContain('已经启动设备');
  expect(saved.stageVideoReply).toHaveBeenCalledWith(reply.id, user.id, reply.content);
  expect(saved.confirmVideoReply).toHaveBeenCalledWith(reply.id);
});

it('does not report a reply as completed when cancelled during server acknowledgement', async () => {
  const controller = new AbortController();
  const saved = channel();
  vi.mocked(saved.stageVideoReply).mockImplementationOnce(async () => {
    controller.abort();
  });
  const model = {
    capabilities: { imageInput: true },
    runTurn: vi.fn(async () => ({ assistantMessage: '旧回复', toolCalls: [] })),
  } as unknown as LlmClient;
  await expect(
    replyToCompanionVideoMessage(
      saved,
      model,
      { name: '朋友', prompt: '温柔陪伴' },
      image,
      user,
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(saved.stageVideoReply).toHaveBeenCalledOnce();
  expect(saved.cancelVideoReply).toHaveBeenCalledOnce();
  expect(saved.confirmVideoReply).not.toHaveBeenCalled();
});

it('lets cancellation overtake an in-flight stage and never confirms it', async () => {
  const controller = new AbortController();
  const saved = channel();
  let releaseStage!: () => void;
  vi.mocked(saved.stageVideoReply).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        releaseStage = resolve;
      }),
  );
  const model = {
    capabilities: { imageInput: true },
    runTurn: vi.fn(async () => ({ assistantMessage: '迟到回复', toolCalls: [] })),
  } as unknown as LlmClient;
  const pending = replyToCompanionVideoMessage(
    saved,
    model,
    { name: '朋友', prompt: '温柔陪伴' },
    image,
    user,
    controller.signal,
  );
  await vi.waitFor(() => expect(saved.stageVideoReply).toHaveBeenCalledOnce());
  controller.abort();
  await vi.waitFor(() => expect(saved.cancelVideoReply).toHaveBeenCalledOnce());
  releaseStage();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(saved.confirmVideoReply).not.toHaveBeenCalled();
});

it('cannot commit a staged reply after account switching invalidates the channel', async () => {
  const controller = new AbortController();
  const saved = channel();
  vi.mocked(saved.stageVideoReply).mockImplementationOnce(async () => {
    controller.abort();
    throw new Error('account changed');
  });
  vi.mocked(saved.cancelVideoReply).mockRejectedValueOnce(new Error('account changed'));
  const model = {
    capabilities: { imageInput: true },
    runTurn: vi.fn(async () => ({ assistantMessage: '暂存回复', toolCalls: [] })),
  } as unknown as LlmClient;
  await expect(
    replyToCompanionVideoMessage(
      saved,
      model,
      { name: '朋友', prompt: '温柔陪伴' },
      image,
      user,
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(saved.confirmVideoReply).not.toHaveBeenCalled();
});

it('reports an uncertain save when cancellation races confirmation', async () => {
  const controller = new AbortController();
  const saved = channel();
  vi.mocked(saved.confirmVideoReply).mockImplementationOnce(async () => {
    controller.abort();
    return {} as Awaited<ReturnType<PrivateConversationChannel['confirmVideoReply']>>;
  });
  vi.mocked(saved.cancelVideoReply).mockRejectedValueOnce(new Error('already committed'));
  const model = {
    capabilities: { imageInput: true },
    runTurn: vi.fn(async () => ({ assistantMessage: '可能已保存', toolCalls: [] })),
  } as unknown as LlmClient;
  await expect(
    replyToCompanionVideoMessage(
      saved,
      model,
      { name: '朋友', prompt: '温柔陪伴' },
      image,
      user,
      controller.signal,
    ),
  ).rejects.toBeInstanceOf(VideoReplySaveUncertainError);
  expect(saved.cancelVideoReply).toHaveBeenCalledOnce();
});
