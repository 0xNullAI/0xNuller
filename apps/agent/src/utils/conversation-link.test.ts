// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearAgentConversationLink,
  linkedAgentConversationId,
  replaceAgentConversationLink,
} from './conversation-link';

afterEach(() => window.history.replaceState(null, '', '/'));

describe('Agent 会话地址', () => {
  it('只接受唯一且符合服务器会话编号格式的 Agent 链接', () => {
    expect(linkedAgentConversationId('/agent', '?conversation=session-1')).toBe('session-1');
    expect(linkedAgentConversationId('/agent', '?conversation=x&conversation=y')).toBeNull();
    expect(linkedAgentConversationId('/agent', '?conversation=%2F')).toBeNull();
    expect(linkedAgentConversationId('/market', '?conversation=session-1')).toBeNull();
  });

  it('切换已有会话时更新地址，并保留其他查询参数', () => {
    window.history.replaceState(null, '', '/agent?mode=text&conversation=old');
    replaceAgentConversationLink('session-2');
    expect(window.location.pathname + window.location.search).toBe(
      '/agent?mode=text&conversation=session-2',
    );
    replaceAgentConversationLink('bad/id');
    expect(window.location.search).toContain('conversation=session-2');
    clearAgentConversationLink();
    expect(window.location.pathname + window.location.search).toBe('/agent?mode=text');
  });
});
