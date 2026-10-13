import { describe, expect, it } from 'vitest';
import { createBasicWaveformLibrary } from '@dg-agent/waveforms';
import type { LlmClient, LlmTurnInput, LlmTurnResult } from '@dg-agent/core';
import { AgentRuntime } from './agent-runtime.js';
import { REPLY_ABORTED_IN_BACKGROUND_NOTE } from './runtime-errors.js';
import { TestDevice, TestPermission, TestSessionStore } from './runtime.test-support.js';

/** Replies with text only and remembers the instructions of every request. */
class RecordingLlm implements LlmClient {
  readonly instructions: string[] = [];
  hold = false;

  async runTurn(input: LlmTurnInput): Promise<LlmTurnResult> {
    this.instructions.push(input.instructions);
    if (this.hold) {
      await new Promise<void>((_, reject) => {
        input.abortSignal?.addEventListener('abort', () =>
          reject(new DOMException('', 'AbortError')),
        );
      });
    }
    return { assistantMessage: '好的' };
  }

  get last(): string {
    return this.instructions.at(-1) ?? '';
  }
}

function setup(device = new TestDevice()) {
  const llm = new RecordingLlm();
  const sessionStore = new TestSessionStore();
  const runtime = new AgentRuntime({
    device,
    llm,
    permission: new TestPermission(),
    waveformLibrary: createBasicWaveformLibrary(),
    sessionStore,
    buildInstructions: () => 'BASE',
  });
  const send = (text = '继续') =>
    runtime.sendUserMessage({
      sessionId: 's',
      text,
      context: { sessionId: 's', sourceType: 'web', traceId: `t-${Math.random()}` },
    });
  return { runtime, llm, device, sessionStore, send };
}

describe('the next reply hears about device changes it did not make', () => {
  it('tells a background stop once, after the base instructions', async () => {
    const { runtime, llm, send } = setup();
    await send('你好');
    expect(llm.last).toBe('BASE');

    runtime.noteDeviceInterruption('s', { kind: 'background-stopped', at: Date.now() });
    await send();

    expect(llm.last.startsWith('BASE\n\n[上次回复之后的变化')).toBe(true);
    expect(llm.last).toContain('应用切到后台，所有设备已停止');
    expect(llm.last).toContain('从启动强度重新开始');

    await send();
    expect(llm.last).toBe('BASE');
    runtime.dispose();
  });

  it('describes a kept background, its timeout and the return in order', async () => {
    const { runtime, llm, send } = setup();
    const at = new Date(2026, 9, 13, 14, 30).getTime();
    runtime.noteDeviceInterruption('s', { kind: 'background-kept', at, until: at + 600_000 });
    runtime.noteDeviceInterruption('s', { kind: 'background-timeout', at: at + 600_000 });
    runtime.noteDeviceInterruption('s', { kind: 'returned', at: at + 900_000 });

    await send();

    const lines = llm.last.split('\n');
    expect(
      lines.findIndex((line) => line.includes('14:30 应用切到后台，按用户设置保持')),
    ).toBeLessThan(lines.findIndex((line) => line.includes('14:40 后台保持时间已到')));
    expect(llm.last).toContain('最长到 14:40');
    expect(llm.last).toContain('14:45 用户回到了应用');
    runtime.dispose();
  });

  it('ignores a return with nothing before it, and tells a doubled event once', async () => {
    const { runtime, llm, send } = setup();
    runtime.noteDeviceInterruption('s', { kind: 'returned', at: Date.now() });
    await send();
    expect(llm.last).toBe('BASE');

    const at = Date.now();
    runtime.noteDeviceInterruption('s', { kind: 'module-switch', at });
    runtime.noteDeviceInterruption('s', { kind: 'module-switch', at: at + 10 });
    await send();
    expect(llm.last.match(/切换到了其他模块/g)).toHaveLength(1);
    runtime.dispose();
  });

  it('keeps the notice for the next reply when the told reply is aborted', async () => {
    const { runtime, llm, send } = setup();
    runtime.noteDeviceInterruption('s', { kind: 'manual-stop', at: Date.now() });
    llm.hold = true;
    const pending = send();
    await expect.poll(() => llm.instructions.length).toBe(1);
    await runtime.abortCurrentReply('s');
    await expect(pending).rejects.toThrow();

    llm.hold = false;
    await send();
    expect(llm.last).toContain('用户按了停止');
    runtime.dispose();
  });

  it('notices output that ran at the end of the last reply and is off now', async () => {
    const device = new TestDevice({ strengthA: 10, waveActiveA: true });
    const { runtime, llm, send } = setup(device);
    await send('你好');
    expect(llm.last).toBe('BASE');

    await device.emergencyStop();
    await send();

    expect(llm.last).toContain('原因不在你的工具记录里');
    runtime.dispose();
  });

  it('saves a background abort as such, not as a manual stop', async () => {
    const { runtime, llm, sessionStore, send } = setup();
    llm.hold = true;
    const pending = send();
    await expect.poll(() => llm.instructions.length).toBe(1);

    await runtime.abortCurrentReply('s', 'background');
    await expect(pending).rejects.toThrow();

    const saved = await sessionStore.get('s');
    expect(saved?.messages.at(-1)?.content).toBe(REPLY_ABORTED_IN_BACKGROUND_NOTE);
    runtime.dispose();
  });
});
