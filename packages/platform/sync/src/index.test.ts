/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { stripSecrets } from './index';

/**
 * The one rule in this module that cannot be got wrong: an API key must never
 * be uploaded. Syncing it would make 0xNullAI the custodian of a third-party
 * credential the user never agreed to hand over, and the server cannot catch
 * it — the payload is opaque there.
 */

describe('同步前剥掉不该上传的字段', () => {
  it('LLM 配置里的 apiKey 不上传', () => {
    const stripped = stripSecrets('llm', {
      providerId: 'openai',
      apiKey: 'sk-live-secret',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    }) as Record<string, unknown>;

    expect(stripped.apiKey).toBeUndefined();
    expect(JSON.stringify(stripped)).not.toContain('sk-live-secret');
  });

  it('其余字段照常同步——剥掉的只有密钥', () => {
    const stripped = stripSecrets('llm', {
      providerId: 'openai',
      apiKey: 'sk',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    }) as Record<string, unknown>;

    expect(stripped).toEqual({
      providerId: 'openai',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    });
  });

  it('其它命名空间原样通过', () => {
    const safety = { maxStrengthA: 30 };
    expect(stripSecrets('device-safety', safety)).toEqual(safety);
  });

  it('null / 非对象不会炸', () => {
    expect(stripSecrets('llm', null)).toBeNull();
    expect(stripSecrets('llm', 'nonsense')).toBe('nonsense');
  });
});
