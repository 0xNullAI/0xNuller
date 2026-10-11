import { describe, expect, it } from 'vitest';
import { classifyPiAiError } from './errors.js';

describe('classifyPiAiError', () => {
  it.each<[string, string | undefined, string | RegExp]>([
    // Anthropic SDK leading-status shape.
    [
      'leading-status message',
      '401 {"type":"error","error":{"message":"invalid x-api-key"}}',
      /^Provider HTTP error 401:/,
    ],
    // Google SDK coded-status shape.
    [
      'coded-status message',
      '{"error":{"code":403,"message":"permission denied","status":"PERMISSION_DENIED"}}',
      /^Provider HTTP error 403:/,
    ],
    // Google streaming shape.
    [
      '"got status: NNN." message',
      'got status: 429. {"error":{"code":429}}',
      /^Provider HTTP error 429:/,
    ],
    // The message normalizeAssistantErrorMessage recognizes.
    ['missing API key', 'No API key for provider: anthropic', 'API key is required'],
    // Regression: @anthropic-ai/sdk and openai (Stainless-generated, same
    // lineage) both wrap a real fetch-level failure in APIConnectionError /
    // APIConnectionTimeoutError with the *original* error only in `.cause` —
    // pi-ai only ever reads `error.message`, which falls back to one of these
    // two fixed literals. Neither carries a status nor matches
    // runtime-errors.ts's own network regex on its own, so without this they
    // silently fell through to a generic `出错了：Connection error.` instead
    // of this app's usual "网络连接失败" copy.
    ['SDK connection-error fallback', 'Connection error.', /^NetworkError:/],
    ['SDK timeout fallback', 'Request timed out.', /^NetworkError:/],
    // Unrecognized message passes through as a generic error.
    ['unrecognized message', 'something unexpected happened', 'something unexpected happened'],
    // No message at all falls back to a Chinese placeholder.
    ['missing message', undefined, '未知错误'],
  ])('classifies %s', (_label, input, expected) => {
    const { message } = classifyPiAiError(input);
    if (expected instanceof RegExp) {
      expect(message).toMatch(expected);
    } else {
      expect(message).toBe(expected);
    }
  });
});
