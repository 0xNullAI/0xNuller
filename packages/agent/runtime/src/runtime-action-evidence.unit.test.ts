import { describe, expect, it } from 'vitest';
import { guardUnverifiedActionClaim as guard } from './runtime-action-evidence.js';
import { createToolExecutionReceipt } from './runtime-tool-receipt.js';

function guardUnverifiedActionClaim(reply: string, calls: Array<{ name: string; output: string }>) {
  return guard(
    reply,
    calls.map((call, index) =>
      createToolExecutionReceipt({
        runId: 'test-run',
        callId: `call-${index}`,
        ...call,
      }),
    ),
  );
}

describe('guardUnverifiedActionClaim', () => {
  it('rejects a physical-action claim without an actual tool result', () => {
    expect(guardUnverifiedActionClaim('好的，已经启动设备。', [])).toContain(
      '不能确认“启动设备”已完成',
    );
    expect(guardUnverifiedActionClaim('已经停止设备。', [])).toContain('不能确认“停止设备”已完成');
  });

  it('catches completed device claims phrased without 已经 while leaving plans alone', () => {
    for (const [reply, action] of [
      ['我把郊狼打开了。', '启动设备'],
      ['刚帮你把设备关掉了。', '停止设备'],
      ['我把负鼠的强度调高了。', '调整设备'],
      ['郊狼已经启动了。', '启动设备'],
      ['我将郊狼打开了。', '启动设备'],
      ['设备停止了。', '停止设备'],
      ['负鼠强度调高了。', '调整设备'],
    ])
      expect(guardUnverifiedActionClaim(reply, []), reply).toContain(`不能确认“${action}”已完成`);
    expect(guardUnverifiedActionClaim('如果我把设备打开了，会怎样？', [])).toBe(
      '如果我把设备打开了，会怎样？',
    );
    expect(guardUnverifiedActionClaim('我准备把郊狼打开。', [])).toBe('我准备把郊狼打开。');
    expect(
      guardUnverifiedActionClaim('我把郊狼打开了。', [
        { name: 'shock_start', output: JSON.stringify({ ok: true, command: { type: 'start' } }) },
      ]),
    ).toBe('我把郊狼打开了。');
  });

  it('never upgrades a fake model JSON summary into a verified device result', () => {
    expect(
      guardUnverifiedActionClaim('Fake LLM 已完成工具执行：{"command":{"type":"start"}}', []),
    ).toContain('模型文本不能作为工具执行凭证');
  });

  it('does not accept a successful unrelated tool as physical-action evidence', () => {
    expect(
      guardUnverifiedActionClaim('已经启动设备。', [
        { name: 'timer', output: JSON.stringify({ timer: { id: 'one' } }) },
      ]),
    ).toContain('不能确认“启动设备”已完成');
  });

  it('does not borrow a successful action on one device kind for a claim about another', () => {
    const coyoteStart = {
      name: 'shock_start',
      output: JSON.stringify({ ok: true, command: { type: 'start' } }),
    };
    const opossumStart = {
      name: 'vibrate_start',
      output: JSON.stringify({ ok: true, command: { type: 'vibrateStart' } }),
    };
    expect(guardUnverifiedActionClaim('我把负鼠打开了。', [coyoteStart])).toContain(
      '不能确认“启动设备”已完成',
    );
    expect(guardUnverifiedActionClaim('I started the coyote.', [opossumStart])).toContain(
      '不能确认“启动设备”已完成',
    );
    expect(guardUnverifiedActionClaim('我把郊狼和负鼠都打开了。', [coyoteStart])).toContain(
      '不能确认“启动设备”已完成',
    );
    expect(guardUnverifiedActionClaim('我把郊狼打开了。', [coyoteStart])).toBe('我把郊狼打开了。');
  });

  it('does not confirm a request from a policy-clamped command of another type', () => {
    const stopped = [
      {
        name: 'shock_start',
        output: JSON.stringify({ ok: 'clamped', command: { type: 'stop' } }),
      },
    ];
    expect(guardUnverifiedActionClaim('已经启动设备。', stopped)).toContain('不能确认');
    expect(guardUnverifiedActionClaim('已经停止设备。', stopped)).toContain('不能确认');
  });

  it('rejects a false success after a denied tool', () => {
    expect(
      guardUnverifiedActionClaim('我已经保存计划。', [
        {
          name: 'task_plan_save',
          output: JSON.stringify({ error: 'permission denied', _meta: { kind: 'tool-denied' } }),
        },
      ]),
    ).toContain('不能确认“保存计划”已完成');
  });

  it('requires an actual saved plan and readable file result, not just a tool name', () => {
    expect(
      guardUnverifiedActionClaim('我已经保存计划。', [
        { name: 'task_plan_save', output: JSON.stringify({ status: 'pending' }) },
      ]),
    ).toContain('不能确认“保存计划”已完成');
    expect(
      guardUnverifiedActionClaim('我已经读取文件。', [
        { name: 'file_read', output: JSON.stringify({ id: 'file', status: 'pending' }) },
      ]),
    ).toContain('不能确认“读取文件”已完成');
  });

  it('catches explicit English completion claims before they are shown or spoken', () => {
    expect(guardUnverifiedActionClaim("I've started the device.", [])).toContain(
      '不能确认“启动设备”已完成',
    );
    expect(guardUnverifiedActionClaim('Done, I scheduled the reminder.', [])).toContain(
      '不能确认“安排提醒”已完成',
    );
    expect(guardUnverifiedActionClaim("I've generated the image.", [])).toContain(
      '不能确认“生成媒体”已完成',
    );
    expect(guardUnverifiedActionClaim('I started the device.', [])).toContain(
      '不能确认“启动设备”已完成',
    );
    expect(guardUnverifiedActionClaim('We just turned off your coyote.', [])).toContain(
      '不能确认“停止设备”已完成',
    );
    expect(guardUnverifiedActionClaim('I adjusted the intensity.', [])).toContain(
      '不能确认“调整设备”已完成',
    );
    expect(guardUnverifiedActionClaim('I can start the device.', [])).toBe(
      'I can start the device.',
    );
    expect(guardUnverifiedActionClaim('I will stop the device.', [])).toBe(
      'I will stop the device.',
    );
  });

  it('does not treat candidate memory or reminder drafts as committed actions', () => {
    expect(
      guardUnverifiedActionClaim('已经记住这件事。', [
        { name: 'memory_propose', output: JSON.stringify({ items: [] }) },
      ]),
    ).toContain('不能确认“写入记忆”已完成');
    expect(
      guardUnverifiedActionClaim('已经安排提醒。', [
        { name: 'reminder_propose', output: JSON.stringify({ item: { enabled: false } }) },
      ]),
    ).toContain('不能确认“安排提醒”已完成');
  });

  it('requires an executed result before saying a tool or web search ran', () => {
    expect(guardUnverifiedActionClaim('我已经调用工具处理了。', [])).toContain(
      '不能确认“调用工具”已完成',
    );
    expect(guardUnverifiedActionClaim('我已经联网搜索过了。', [])).toContain(
      '不能确认“联网搜索”已完成',
    );
    expect(guardUnverifiedActionClaim("I've used the tool.", [])).toContain(
      '不能确认“调用工具”已完成',
    );
    expect(
      guardUnverifiedActionClaim('我已经调用工具处理了。', [
        { name: 'task_plan_list', output: JSON.stringify({ items: [] }) },
      ]),
    ).toBe('我已经调用工具处理了。');
    expect(
      guardUnverifiedActionClaim('我已经调用工具处理了。', [
        { name: 'memory_search', output: JSON.stringify({ error: 'permission denied' }) },
      ]),
    ).toContain('不能确认“调用工具”已完成');
    expect(guardUnverifiedActionClaim('我可以调用工具查找。', [])).toBe('我可以调用工具查找。');
  });

  it('checks completed tool-call wording even without the older 已经 prefix', () => {
    for (const reply of [
      '我刚刚调用了工具。',
      '刚才执行了设备工具。',
      '工具调用成功。',
      'I called the tool.',
    ])
      expect(guardUnverifiedActionClaim(reply, [])).toContain('不能确认“调用工具”已完成');
    expect(guardUnverifiedActionClaim('我可以调用工具。', [])).toBe('我可以调用工具。');
    expect(guardUnverifiedActionClaim('我计划调用工具。', [])).toBe('我计划调用工具。');
  });

  it('preserves normal conversation and verified completed actions', () => {
    expect(guardUnverifiedActionClaim('我记得我们上次聊过海边。', [])).toBe(
      '我记得我们上次聊过海边。',
    );
    expect(
      guardUnverifiedActionClaim('已保存计划。', [
        { name: 'task_plan_save', output: JSON.stringify({ item: { id: 'plan' } }) },
      ]),
    ).toBe('已保存计划。');
  });
});
