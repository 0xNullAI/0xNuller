import type { PrivateConversationChannel } from '@0xnullai/auth';
import type { LlmImageInput } from '@dg-agent/core';

export class ObservationCancellationUnconfirmedError extends Error {
  constructor(cause: unknown) {
    super('服务器观察撤销未确认，请重新联网核对聊天记录。', { cause });
    this.name = 'ObservationCancellationUnconfirmedError';
  }
}

/** The camera frame goes only to the live observer; the history boundary receives plain final text. */
export async function observeWithPrivateHistory(
  channel: PrivateConversationChannel,
  image: LlmImageInput,
  signal: AbortSignal,
  observe: (image: LlmImageInput, signal: AbortSignal) => Promise<string>,
  stop: () => Promise<void>,
): Promise<string> {
  let observationId: string | null = null;
  let cancellation: Promise<void> | null = null;
  const cancelPending = () => {
    if (!observationId) return null;
    cancellation ??= channel.cancelCameraObservation(observationId).catch((error: unknown) => {
      throw new ObservationCancellationUnconfirmedError(error);
    });
    return cancellation;
  };
  const onAbort = () => {
    void cancelPending()?.catch(() => undefined);
  };
  try {
    channel.assertCurrent();
    // A paused/stopped camera run must not start a new billable inference even
    // if its queued frame reaches this boundary after cancellation.
    if (signal.aborted) {
      await stop();
      return '';
    }
    const text = await observe(image, signal);
    if (signal.aborted) {
      await stop();
      return '';
    }
    channel.assertCurrent();
    if (signal.aborted) {
      await stop();
      return '';
    }
    if (text.trim()) {
      observationId = `camera-${crypto.randomUUID()}`;
      signal.addEventListener('abort', onAbort, { once: true });
      await channel.appendCameraObservation(observationId, text.trim());
    }
    if (signal.aborted) {
      await cancelPending();
      await stop();
      return '';
    }
    channel.assertCurrent();
    return text;
  } catch (error) {
    await stop();
    if (signal.aborted && observationId) {
      await cancelPending();
      return '';
    }
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
