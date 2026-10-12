import { afterEach, expect, it, vi } from 'vitest';
import { generateConversationDigest } from './conversation-digest-generation';
import { testPriceTable } from './test-helpers';

afterEach(() => vi.unstubAllGlobals());
const source = [{ id: 'u1', role: 'user' as const, content: '周日想去读书' }];
const route = testPriceTable.background;

it('sends only bounded supplied text and accepts a completed structured summary', async () => {
  const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    expect(body.messages[1]?.content).toContain('周日想去读书');
    expect(body.messages[1]?.content).toContain('之前谈到旅行');
    return Response.json({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({ summary: ' 讨论了周日读书。 ' }),
          },
        },
      ],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  expect(await generateConversationDigest('test-key', route, '之前谈到旅行', source)).toBe(
    '讨论了周日读书。',
  );
  expect(fetcher).toHaveBeenCalledOnce();
});

it('rejects unbounded input, incomplete output and model tool calls', async () => {
  const fetcher = vi.fn(async () =>
    Response.json({
      choices: [
        {
          finish_reason: 'tool_calls',
          message: { content: '{"summary":"假的"}', tool_calls: [{}] },
        },
      ],
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  await expect(
    generateConversationDigest('key', route, '', [{ ...source[0]!, content: 'a'.repeat(1001) }]),
  ).rejects.toThrow('输入范围无效');
  expect(fetcher).not.toHaveBeenCalled();
  await expect(generateConversationDigest('key', route, '', source)).rejects.toThrow('暂不可用');
});

it('accepts a 900-character emoji message the source query already bounded', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        choices: [
          {
            finish_reason: 'stop',
            message: { content: '```json\n' + JSON.stringify({ summary: '表情' }) + '\n```' },
          },
        ],
      }),
    ),
  );
  const emoji = [{ id: 'u1', role: 'user' as const, content: '😀'.repeat(900) }];
  expect(await generateConversationDigest('test-key', route, '', emoji)).toBe('表情');
});
