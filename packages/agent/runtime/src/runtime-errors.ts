export const REPLY_ABORTED_ERROR_MESSAGE = '已停止当前回复';
export const REPLY_ABORTED_NOTE = '✋ 已手动中止';
/** Stored in place of `REPLY_ABORTED_NOTE` when the reply ended because the app was backgrounded. */
export const REPLY_ABORTED_IN_BACKGROUND_NOTE = '⏸ 应用切到后台，已中止';
export const TOOL_LOOP_EXHAUSTED_MESSAGE = '🛑 单轮对话交互轮数已达上限';

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'AbortError';
  }
  return error instanceof Error && error.name === 'AbortError';
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;

  if (typeof DOMException !== 'undefined') {
    throw new DOMException(REPLY_ABORTED_ERROR_MESSAGE, 'AbortError');
  }

  const error = new Error(REPLY_ABORTED_ERROR_MESSAGE);
  error.name = 'AbortError';
  throw error;
}

const CREDIT_EXHAUSTED_MESSAGE =
  'Credit 不足，可以在「我的 → 账户 → Credit」兑换卡密，或在「我的 → AI → 高级」使用自己的 API。';

export function normalizeAssistantErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '未知错误');

  if (/API key is required/i.test(raw)) {
    return '还没有配置 API Key，请先在设置里填写';
  }

  if (/Credit\s*不足|insufficient[_ ]credit/i.test(raw)) return CREDIT_EXHAUSTED_MESSAGE;

  const statusMatch = raw.match(
    /\b(?:API error|HTTP error|Provider HTTP error)\s+(\d{3})\b|(?:HTTP 错误|模型服务 HTTP 错误)\s+(\d{3})/i,
  );
  if (statusMatch) {
    const status = Number(statusMatch[1] ?? statusMatch[2]);
    const detail = providerDetail(raw);
    if (status === 400) return `请求被服务端拒绝，请检查模型、参数或接口兼容性${detail}`;
    if (status === 402) return CREDIT_EXHAUSTED_MESSAGE;
    if (status === 401) return `API Key 无效或已过期，请检查设置${detail}`;
    if (status === 403) return `当前接口访问被拒绝，请检查账号权限、地区限制或代理${detail}`;
    if (status === 429) return '请求过于频繁，已被限流，请稍后再试';
    if (status >= 500) return 'AI 服务暂时不可用，请稍后重试';
  }

  if (/Failed to fetch|NetworkError|TypeError: network|net::|WebSocket/i.test(raw)) {
    return '网络连接失败，请检查网络、代理或服务状态后重试';
  }

  return `出错了：${raw}`;
}

/**
 * The provider's own explanation (for example "API key is not scoped to a workspace")
 * is usually the only actionable part of a 4xx; a generic hint alone hides it.
 */
function providerDetail(raw: string): string {
  const quoted = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1];
  let message = quoted;
  if (quoted) {
    try {
      message = JSON.parse(`"${quoted}"`) as string;
    } catch {
      message = quoted;
    }
  }
  const text = message?.replace(/\s+/g, ' ').trim();
  return text ? `（服务商说明：${text.length > 200 ? `${text.slice(0, 200)}…` : text}）` : '';
}
