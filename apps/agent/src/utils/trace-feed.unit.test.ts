import { describe, expect, it } from 'vitest';
import type { RuntimeTraceEntry } from '@dg-agent/core';
import { buildTraceFeed } from './trace-feed';

const trace = (
  id: string,
  kind: RuntimeTraceEntry['kind'],
  toolCallId?: string,
): RuntimeTraceEntry => ({
  id,
  kind,
  createdAt: Number(id.replace(/\D/g, '')),
  turnId: 'turn-1',
  toolCallId,
  toolName: 'shock_start',
});

describe('工具执行状态展示', () => {
  it('同一次调用出现待核对时，不同时展示已执行或确定失败', () => {
    const feed = buildTraceFeed([
      trace('1', 'tool-result', 'call-1'),
      trace('2', 'tool-failed', 'call-1'),
      trace('3', 'tool-unknown', 'call-1'),
      trace('4', 'tool-result', 'call-2'),
    ]);
    expect(feed).toHaveLength(2);
    expect(feed[0]?.text).toContain('待核对');
    expect(feed[0]?.text).not.toContain('已执行');
    expect(feed[1]?.text).toContain('已执行');
  });

  it('旧记录没有调用编号时，仍展示原始执行记录', () => {
    expect(buildTraceFeed([trace('1', 'tool-result')])[0]?.text).toContain('已执行');
  });
});
