const REDACTED_IMAGE = '[REDACTED_IMAGE]';

/**
 * Recursively clones model diagnostics while removing base64/data-URL image
 * payloads. This is intentionally shape-based so it covers pi-ai, OpenAI
 * Chat Completions and Responses payloads without logging a new dialect by
 * accident.
 */
export function redactModelData(value: unknown): unknown {
  return redact(value, new WeakMap<object, unknown>());
}

function redact(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') {
    return /^data:image\/(?:jpeg|webp);base64,/i.test(value) ? REDACTED_IMAGE : value;
  }
  if (value === null || typeof value !== 'object') return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;

  if (Array.isArray(value)) {
    const output: unknown[] = [];
    seen.set(value, output);
    for (const item of value) output.push(redact(item, seen));
    return output;
  }

  const record = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  seen.set(value, output);
  const isImageBlock =
    record.type === 'image' ||
    record.type === 'input_image' ||
    typeof record.image_url === 'string' ||
    (record.image_url !== null && typeof record.image_url === 'object');

  for (const [key, child] of Object.entries(record)) {
    if (isImageBlock && key === 'data' && typeof child === 'string') {
      output[key] = REDACTED_IMAGE;
      continue;
    }
    output[key] = redact(child, seen);
  }
  return output;
}
