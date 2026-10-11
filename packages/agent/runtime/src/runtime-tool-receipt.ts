import { isDeviceToolName } from '@dg-agent/core';

export type ToolReceiptStatus = 'succeeded' | 'denied' | 'failed' | 'pending' | 'unknown';

/** A result tied to the model's exact call. Only the runtime may issue this receipt. */
export interface ToolExecutionReceipt {
  runId: string;
  callId: string;
  name: string;
  status: ToolReceiptStatus;
  output: string;
}

export function parseToolOutput(output: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(output);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function hasId(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).id === 'string' &&
    Boolean((value as Record<string, unknown>).id)
  );
}

const deviceCommandTypes: Readonly<Record<string, string>> = {
  shock_start: 'start',
  start: 'start',
  shock_stop: 'stop',
  stop: 'stop',
  shock_adjust: 'adjustStrength',
  adjust_strength: 'adjustStrength',
  shock_change_wave: 'changeWave',
  change_wave: 'changeWave',
  shock_burst: 'burst',
  burst: 'burst',
  vibrate_start: 'vibrateStart',
  vibrate_stop: 'vibrateStop',
  vibrate_adjust: 'vibrateAdjust',
  vibrate_change_pattern: 'vibrateSetPattern',
  vibrate_burst: 'vibrateBurst',
};

function classify(
  name: string,
  output: Record<string, unknown> | null,
  args?: Readonly<Record<string, unknown>>,
): ToolReceiptStatus {
  if (!output) return 'unknown';
  const meta = parseMeta(output._meta);
  if (meta.kind === 'tool-denied') return 'denied';
  if (meta.kind === 'tool-failed') return 'failed';
  if (meta.kind === 'tool-unknown') return 'unknown';
  if (meta.kind === 'tool-pending') return 'pending';

  if (['pending', 'queued', 'running', 'processing'].includes(String(output.status)))
    return 'pending';
  if (['unknown', 'needs-review', 'unconfirmed'].includes(String(output.status))) return 'unknown';
  if (['denied', 'rejected'].includes(String(output.status))) return 'denied';
  if (['failed', 'error', 'cancelled', 'canceled'].includes(String(output.status))) return 'failed';
  if (output.error || output.ok === false) return 'failed';
  if (output.interrupted === true) return 'unknown';

  if (isDeviceToolName(name)) {
    // Exact Coyote routing is part of the action identity. A result from another
    // connection cannot prove this call, even if the command type matches.
    if (typeof args?.targetId === 'string' && output.targetId !== args.targetId) return 'unknown';
    if (name === 'set_indicator_color') {
      return output.ok === true &&
        ['paw-prints', 'civet-edging', 'opossum'].includes(String(output.deviceKind)) &&
        output.deviceKind === args?.deviceKind &&
        Number.isInteger(output.color) &&
        Number(output.color) >= 0 &&
        Number(output.color) <= 7 &&
        output.color === Number(args?.color)
        ? 'succeeded'
        : 'unknown';
    }
    const command = output.command;
    return (output.ok === true || output.ok === 'clamped') &&
      command !== null &&
      typeof command === 'object' &&
      !Array.isArray(command) &&
      (command as Record<string, unknown>).type === deviceCommandTypes[name]
      ? 'succeeded'
      : 'unknown';
  }
  if (name === 'timer') return hasId(output.timer) ? 'succeeded' : 'unknown';
  if (name === 'task_plan_save') return hasId(output.item) ? 'succeeded' : 'unknown';
  if (name === 'file_read')
    return typeof output.id === 'string' && typeof output.text === 'string'
      ? 'succeeded'
      : 'unknown';
  if (['web_search', 'search_web', 'browser_search'].includes(name))
    return Array.isArray(output.results) || Array.isArray(output.items) ? 'succeeded' : 'unknown';
  if (name === 'memory_search')
    return typeof output.relationshipId === 'string' && Array.isArray(output.longTerm)
      ? 'succeeded'
      : 'unknown';
  if (['memory_propose', 'task_plan_list', 'file_list'].includes(name))
    return Array.isArray(output.items) ? 'succeeded' : 'unknown';
  if (name === 'reminder_propose') return hasId(output.item) ? 'succeeded' : 'unknown';
  return output.ok === true ? 'succeeded' : 'unknown';
}

function parseMeta(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createToolExecutionReceipt(input: {
  runId: string;
  callId: string;
  name: string;
  args?: Readonly<Record<string, unknown>>;
  output: string;
}): ToolExecutionReceipt {
  const { args: _args, ...receipt } = input;
  return { ...receipt, status: classify(input.name, parseToolOutput(input.output), input.args) };
}
