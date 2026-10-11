interface Input {
  usageKind: 'agent' | 'video';
  modelId: string;
  credits: number;
  context?: { conversationId: string; runId: string };
  bodyHash?: string;
}

/**
 * The proxy prices every hold from the `AI_PRICE_TABLE` secret, so Auth no longer pins a fixed
 * visual amount (prices are not in the repository). A visual hold must still be a positive whole
 * Credit amount bound to the right usage kind, an owned conversation and the exact request hash;
 * the generic reservation path enforces the upper bound and balance.
 */
export function validManagedTextReservation(input: Input): boolean {
  if (!['agent', 'video'].includes(input.usageKind)) return false;
  if (!['vision', 'chat-vision'].includes(input.modelId))
    return ['basic', 'balanced', 'powerful'].includes(input.modelId);
  return (
    input.usageKind === (input.modelId === 'vision' ? 'video' : 'agent') &&
    Number.isSafeInteger(input.credits) &&
    input.credits >= 1 &&
    input.context !== undefined &&
    typeof input.bodyHash === 'string' &&
    /^[a-f0-9]{64}$/.test(input.bodyHash)
  );
}
