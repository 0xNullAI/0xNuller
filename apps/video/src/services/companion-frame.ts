import { createEmptyDeviceState, type LlmClient, type LlmImageInput } from '@dg-agent/core';
import { guardUnverifiedActionClaim } from '@dg-agent/runtime';
import type { VideoAiScene } from './video-ai-device-router.js';

/** Camera-only companion observation. No device target, tool schema or execution path exists here. */
export async function observeCompanionFrame(
  model: LlmClient,
  scene: VideoAiScene,
  conversationId: string,
  image: LlmImageInput,
  signal: AbortSignal,
  previousObservations: readonly string[] = [],
): Promise<string> {
  if (signal.aborted) throw new DOMException('Video observation aborted', 'AbortError');
  if (!model.capabilities?.imageInput) throw new Error('当前模型不支持图片输入');
  const prompt = '观察最新画面，以陪伴者身份自然回应。只描述看得见的内容，不猜测画面外的事实。';
  const result = await model.runTurn({
    session: {
      id: conversationId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      deviceState: createEmptyDeviceState(),
    },
    message: prompt,
    context: {
      sessionId: conversationId,
      sourceType: 'web',
      traceId: `video-companion-${crypto.randomUUID()}`,
    },
    instructions: `当前角色「${scene.name}」：\n${scene.prompt}\n\n这是纯陪伴观察，没有设备工具或设备授权。不得声称已操作设备、保存记忆或完成其他外部动作。${
      previousObservations.length
        ? `\n\n[先前画面观察，仅供衔接；画面可能已变化，不视为当前事实]\n${previousObservations
            .slice(-3)
            .map((text) => text.slice(0, 500))
            .join('\n')}`
        : ''
    }`,
    tools: [],
    image,
    abortSignal: signal,
    conversation: [{ kind: 'message', role: 'user', content: prompt }],
  });
  if (signal.aborted) throw new DOMException('Video observation aborted', 'AbortError');
  if (result.toolCalls?.length) throw new Error('纯陪伴观察不允许设备或其他工具调用');
  return guardUnverifiedActionClaim(result.assistantMessage.trim(), []) || '画面状态已更新';
}
