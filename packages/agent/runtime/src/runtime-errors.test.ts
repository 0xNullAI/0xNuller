import { describe, expect, it } from 'vitest';
import { normalizeAssistantErrorMessage } from './runtime-errors.js';

describe('normalizeAssistantErrorMessage', () => {
  it('keeps the provider explanation for a rejected request', () => {
    const raw =
      'Provider HTTP error 400: 400 {"type":"error","error":{"type":"invalid_request_error","message":"This API key is not scoped to a workspace."}}';
    expect(normalizeAssistantErrorMessage(new Error(raw))).toBe(
      '请求被服务端拒绝，请检查模型、参数或接口兼容性（服务商说明：This API key is not scoped to a workspace.）',
    );
  });

  it('keeps the generic hint when the provider gives no message', () => {
    expect(normalizeAssistantErrorMessage(new Error('Provider HTTP error 401: 401'))).toBe(
      'API Key 无效或已过期，请检查设置',
    );
  });
});
