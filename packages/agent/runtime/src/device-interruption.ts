import type { DeviceInterruptionEvent, DeviceState } from '@dg-agent/core';
import { isCoyoteOutputActive } from '@dg-kit/core';

/** Enough to tell the model what happened while it was not replying; older events add nothing. */
const MAX_EVENTS = 8;
const DUPLICATE_WINDOW_MS = 5_000;

/** Pending interruptions per session, told to the model once and then dropped. */
export class DeviceInterruptionLog {
  private readonly pending = new Map<string, DeviceInterruptionEvent[]>();

  note(sessionId: string, event: DeviceInterruptionEvent): void {
    const events = this.pending.get(sessionId) ?? [];
    // "Came back" only means something after an event the model has not heard about yet.
    if (event.kind === 'returned' && events.length === 0) return;
    // One change often arrives through two paths (the lease revoke and the registry, or the
    // native pause and the page event); tell it once.
    const last = events.at(-1);
    if (last?.kind === event.kind && Math.abs(event.at - last.at) < DUPLICATE_WINDOW_MS) return;
    events.push(event);
    this.pending.set(sessionId, events.slice(-MAX_EVENTS));
  }

  /** What the next turn should be told. The events stay pending until `consume`. */
  peek(sessionId: string): readonly DeviceInterruptionEvent[] {
    return [...(this.pending.get(sessionId) ?? [])];
  }

  /** Drop exactly these events once a reply that was told about them completed. */
  consume(sessionId: string, told: readonly DeviceInterruptionEvent[]): void {
    const events = this.pending.get(sessionId);
    if (!events) return;
    const rest = events.filter((event) => !told.includes(event));
    if (rest.length > 0) this.pending.set(sessionId, rest);
    else this.pending.delete(sessionId);
  }

  clear(sessionId?: string): void {
    if (sessionId === undefined) this.pending.clear();
    else this.pending.delete(sessionId);
  }
}

/**
 * The model's notice for one turn, or '' when there is nothing to say.
 *
 * Without known events it still compares the saved state from the end of the last reply with the
 * device now: output that was running then and is off now was stopped by something the model did
 * not do (a stop button elsewhere, another module, a lost connection, or a timed wave ending).
 */
export function describeDeviceInterruptions(
  events: readonly DeviceInterruptionEvent[],
  previous: DeviceState | undefined,
  current: DeviceState,
  now: number,
): string {
  const lines = events.map(describeEvent);
  if (
    lines.length === 0 &&
    previous &&
    isCoyoteOutputActive(previous) &&
    !isCoyoteOutputActive(current)
  ) {
    lines.push(
      '你上次回复结束时郊狼还在输出，现在已经停止。原因不在你的工具记录里：可能是用户按了停止、在别处操作、连接中断，或波形到时结束。',
    );
  }
  if (lines.length === 0) return '';
  return [
    `[上次回复之后的变化 - 现在 ${clock(now)}]`,
    ...lines.map((line) => `- ${line}`),
    '设备的真实状态只以[当前设备状态]为准：不要说设备仍在运行，也不要当作之前的安排还在继续。',
    '用户想继续时，先简短确认，再从启动强度重新开始，不要直接恢复到之前的强度。',
  ].join('\n');
}

function describeEvent(event: DeviceInterruptionEvent): string {
  const at = clock(event.at);
  switch (event.kind) {
    case 'background-stopped':
      return `${at} 应用切到后台，所有设备已停止；未完成的回复、定时提醒和设备联动都已取消。`;
    case 'background-kept':
      return `${at} 应用切到后台，按用户设置保持当时的输出${
        event.until ? `（最长到 ${clock(event.until)}）` : ''
      }；你的回复、定时提醒和设备联动已暂停，期间只允许停止或降低。`;
    case 'background-timeout':
      return `${at} 后台保持时间已到，所有设备已停止。`;
    case 'returned':
      return `${at} 用户回到了应用。`;
    case 'manual-stop':
      return `${at} 用户按了停止，所有设备已停止；未完成的回复、定时提醒和设备联动都已取消。`;
    case 'module-switch':
      return `${at} 用户切换到了其他模块，所有设备已停止；未完成的回复、定时提醒和设备联动都已取消。`;
  }
}

function clock(ms: number): string {
  const date = new Date(ms);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
