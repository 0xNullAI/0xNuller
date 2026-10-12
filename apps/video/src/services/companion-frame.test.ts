import { expect, it, vi } from 'vitest';
import type { LlmClient, LlmImageInput } from '@dg-agent/core';
import { observeCompanionFrame } from './companion-frame.js';

const frame: LlmImageInput = {
  mediaType: 'image/jpeg',
  data: 'private-frame',
  width: 1,
  height: 1,
  byteLength: 1,
};
it('does not call the provider when a companion frame was already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  const runTurn = vi.fn();
  const model = { capabilities: { imageInput: true }, runTurn } as unknown as LlmClient;
  await expect(
    observeCompanionFrame(
      model,
      { name: '朋友', prompt: '温柔陪伴' },
      'owned-conversation',
      frame,
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(runTurn).not.toHaveBeenCalled();
});

it('observes a camera frame as a private companion without any device tool', async () => {
  const runTurn = vi.fn(async () => ({ assistantMessage: '我看到窗边的猫。', toolCalls: [] }));
  const model = { capabilities: { imageInput: true }, runTurn } as unknown as LlmClient;
  expect(
    await observeCompanionFrame(
      model,
      { name: '朋友', prompt: '温柔陪伴' },
      'owned-conversation',
      frame,
      new AbortController().signal,
    ),
  ).toBe('我看到窗边的猫。');
  expect(runTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      tools: [],
      image: frame,
      session: expect.objectContaining({ id: 'owned-conversation' }),
    }),
  );
});

it('rejects a provider tool call when no device authorization exists', async () => {
  const model = {
    capabilities: { imageInput: true },
    runTurn: vi.fn(async () => ({
      assistantMessage: '已调整设备',
      toolCalls: [{ name: 'video_device_control' }],
    })),
  } as unknown as LlmClient;
  await expect(
    observeCompanionFrame(
      model,
      { name: '朋友', prompt: '温柔陪伴' },
      'owned-conversation',
      frame,
      new AbortController().signal,
    ),
  ).rejects.toThrow('不允许设备');
});

it('carries only a bounded, explicitly provisional summary of earlier observations', async () => {
  const runTurn = vi.fn(async (_input: unknown) => ({
    assistantMessage: '现在是另一幅画面',
    toolCalls: [],
  }));
  const model = { capabilities: { imageInput: true }, runTurn } as unknown as LlmClient;
  await observeCompanionFrame(
    model,
    { name: '朋友', prompt: '温柔陪伴' },
    'owned-conversation',
    frame,
    new AbortController().signal,
    ['很久以前的画面', '上一帧看到窗户'],
  );
  const instructions = (runTurn.mock.calls[0]?.[0] as { instructions: string }).instructions;
  expect(instructions).toContain('上一帧看到窗户');
  expect(instructions).toContain('不视为当前事实');
});

it('does not present a prose-only device action as completed', async () => {
  const model = {
    capabilities: { imageInput: true },
    runTurn: vi.fn(async () => ({ assistantMessage: '已经启动设备。', toolCalls: [] })),
  } as unknown as LlmClient;
  const reply = await observeCompanionFrame(
    model,
    { name: '朋友', prompt: '温柔陪伴' },
    'owned-conversation',
    frame,
    new AbortController().signal,
  );
  expect(reply).toContain('没有可核实的工具执行结果');
  expect(reply).not.toContain('已经启动设备');
});
