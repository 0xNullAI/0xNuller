import {
  formatRecentConversationContext,
  loadPrivateCompanionContext,
  type ConversationTextMessage,
  type PrivateConversationChannel,
} from '@0xnullai/auth';
import { createEmptyDeviceState, type LlmClient, type LlmImageInput } from '@dg-agent/core';
import { guardUnverifiedActionClaim } from '@dg-agent/runtime';
import type { VideoAiScene } from './video-ai-device-router.js';
import type { VideoAiDeviceRouter } from './video-ai-device-router.js';
import type { VisualSession } from './visual-session.js';

export class VideoReplySaveUncertainError extends Error {
  constructor() {
    super('视频回复的服务器保存状态未确认。请重新打开原对话核对记录，避免重复发送。');
    this.name = 'VideoReplySaveUncertainError';
  }
}

function videoMessageAbort(): DOMException {
  return new DOMException('Video message aborted', 'AbortError');
}

/** A question has no device tools, so all previous output must be confirmed stopped first. */
export async function pauseForCompanionVideoMessage(
  session: Pick<VisualSession, 'getSnapshot' | 'pause'>,
  router: Pick<VideoAiDeviceRouter, 'stop'>,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new DOMException('Video message aborted', 'AbortError');
  if (session.getSnapshot().status === 'running') session.pause();
  try {
    // Also wait for a stop already started by pause or another safety path.
    await router.stop();
  } catch (error) {
    throw new Error('无法确认设备已停止，请立即断开设备或取下电极；本次问题未发送。', {
      cause: error,
    });
  }
  if (signal.aborted) throw new DOMException('Video message aborted', 'AbortError');
}

/** Answer a user's video question in the same server chat, without exposing device tools. */
export async function replyToCompanionVideoMessage(
  channel: PrivateConversationChannel,
  model: LlmClient,
  scene: VideoAiScene,
  image: LlmImageInput,
  message: ConversationTextMessage,
  signal: AbortSignal,
): Promise<ConversationTextMessage> {
  if (signal.aborted) throw new DOMException('Video message aborted', 'AbortError');
  channel.assertCurrent();
  if (!model.capabilities?.imageInput) throw new Error('当前模型不支持图片输入');
  const record = await channel.read();
  channel.assertCurrent();
  if (signal.aborted) throw new DOMException('Video message aborted', 'AbortError');
  if (
    !record?.session?.messages.some(
      (item) => item.id === message.id && item.role === 'user' && item.content === message.content,
    )
  )
    throw new Error('用户消息尚未保存到服务器');
  const recent = formatRecentConversationContext(record.session, 6_000);
  const boundRelationshipId = record.session.metadata.relationshipId;
  const privateContext = await loadPrivateCompanionContext({
    conversationId: channel.selection.conversationId,
    characterId: channel.selection.characterId,
    ...(boundRelationshipId ? { relationshipId: boundRelationshipId } : {}),
    query: message.content.slice(0, 1_000),
  });
  channel.assertCurrent();
  if (signal.aborted) throw new DOMException('Video message aborted', 'AbortError');
  if (privateContext.relationshipId !== boundRelationshipId)
    throw new Error('此对话的私人关系暂不可用，请回到文字对话检查关系设置。');
  const result = await model.runTurn({
    session: {
      id: channel.selection.conversationId,
      createdAt: record.session.createdAt,
      updatedAt: record.session.updatedAt,
      messages: [],
      deviceState: createEmptyDeviceState(),
    },
    message: message.content,
    context: {
      sessionId: channel.selection.conversationId,
      sourceType: 'web',
      traceId: `video-message-${message.id}`,
    },
    instructions: `当前角色「${scene.name}」：\n${scene.basePrompt ?? scene.prompt}\n\n这是用户主动发起的私人视频问答。当前画面是本次参考，旧记录只是背景；不能把旧画面当作当前事实。没有设备工具或授权，不得声称已操作设备、写入记忆或执行其他外部动作。\n\n${recent}\n\n${privateContext.text}`,
    tools: [],
    image,
    abortSignal: signal,
    conversation: [{ kind: 'message', role: 'user', content: message.content }],
  });
  channel.assertCurrent();
  if (signal.aborted) throw new DOMException('Video message aborted', 'AbortError');
  if (result.toolCalls?.length) throw new Error('视频问答不允许设备或其他工具调用');
  const reply = guardUnverifiedActionClaim(result.assistantMessage.trim(), []);
  if (!reply) throw new Error('模型尚未给出可保存的回答');
  const assistant: ConversationTextMessage = {
    id: `video-reply-${crypto.randomUUID()}`,
    role: 'assistant',
    content: reply,
    createdAt: Date.now(),
  };
  if (signal.aborted) throw videoMessageAbort();
  let confirmStarted = false;
  let confirmed = false;
  let cancellation: Promise<void> | null = null;
  const cancelPending = () => {
    cancellation ??= channel.cancelVideoReply(assistant.id);
    return cancellation;
  };
  const onAbort = () => {
    void cancelPending().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    await channel.stageVideoReply(assistant.id, message.id, assistant.content);
    channel.assertCurrent();
    if (signal.aborted) {
      await cancelPending();
      throw videoMessageAbort();
    }
    confirmStarted = true;
    await channel.confirmVideoReply(assistant.id);
    confirmed = true;
    channel.assertCurrent();
    if (signal.aborted) throw new VideoReplySaveUncertainError();
    return assistant;
  } catch (error) {
    if (confirmed) throw error;
    if (!confirmStarted && !signal.aborted) throw error;
    try {
      await cancelPending();
    } catch {
      // Confirmation is the only path from draft to transcript. If it never
      // started, a failed retraction can leave a short-lived draft but no reply
      // in the chat. After confirmation starts, outcome must be checked.
      if (confirmStarted) throw new VideoReplySaveUncertainError();
    }
    if (signal.aborted) throw videoMessageAbort();
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
