/** Idempotent retries always preserve the chosen financial action. A timeout can mean committed. */
export async function finalizeBilling(env, auth, key, action, charge, metadata) {
  let cause;
  for (let attempt = 0; attempt < 3; attempt++) {
    let timer;
    try {
      const result = await Promise.race([
        action === 'settle'
          ? env.AUTH.settleCredits(auth, key, charge, metadata)
          : env.AUTH.releaseCredits(auth, key),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('billing_timeout')), 3000);
        }),
      ]);
      if (action === 'release' && result?.status === 'released') return result;
      if (
        action === 'settle' &&
        result?.status === 'settled' &&
        Number.isSafeInteger(result.charged) &&
        result.charged === charge
      )
        return result;
      // Opposite terminal state is not success and must not be "fixed" by switching actions.
      if (result?.status === 'released' || result?.status === 'settled')
        throw new TerminalBillingError(result);
      cause = new Error('billing_not_acknowledged');
    } catch (error) {
      if (error instanceof TerminalBillingError) throw error;
      cause = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw cause ?? new Error('billing_not_acknowledged');
}
class TerminalBillingError extends Error {
  constructor(result) {
    super('billing_terminal_mismatch');
    this.status = result.status;
    this.charged = result.charged;
  }
}
export function validUsage(value) {
  return (
    value &&
    typeof value === 'object' &&
    Number.isSafeInteger(value.prompt_tokens) &&
    value.prompt_tokens >= 0 &&
    Number.isSafeInteger(value.completion_tokens) &&
    value.completion_tokens >= 0 &&
    (value.prompt_tokens_details?.cached_tokens === undefined ||
      (Number.isSafeInteger(value.prompt_tokens_details.cached_tokens) &&
        value.prompt_tokens_details.cached_tokens >= 0 &&
        value.prompt_tokens_details.cached_tokens <= value.prompt_tokens))
  );
}
