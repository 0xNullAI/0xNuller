/** Auth owns the maximum visual hold independently of the client and proxy. */
export const MANAGED_VISION_RESERVATION_CREDITS = 59;

interface Input {
  usageKind: 'agent' | 'video';
  modelId: string;
  credits: number;
  context?: { conversationId: string; runId: string };
  bodyHash?: string;
}

export function validManagedTextReservation(input: Input): boolean {
  if (!['agent', 'video'].includes(input.usageKind)) return false;
  if (!['vision', 'chat-vision'].includes(input.modelId))
    return ['basic', 'balanced', 'powerful'].includes(input.modelId);
  return (
    input.usageKind === (input.modelId === 'vision' ? 'video' : 'agent') &&
    input.credits === MANAGED_VISION_RESERVATION_CREDITS &&
    input.context !== undefined &&
    typeof input.bodyHash === 'string' &&
    /^[a-f0-9]{64}$/.test(input.bodyHash)
  );
}
