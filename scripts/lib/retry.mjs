export async function retry(operation, options = {}) {
  const attempts = options.attempts ?? 1;
  const delayMs = options.delayMs ?? 0;
  const onRetry = options.onRetry ?? (() => {});

  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new TypeError('retry attempts must be a positive integer');
  }

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      onRetry(error, attempt, attempts);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
