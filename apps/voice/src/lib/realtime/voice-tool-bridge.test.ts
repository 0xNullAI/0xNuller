import { describe, expect, it, vi } from 'vitest';
import { VoiceToolBridge } from './voice-tool-bridge';
import type { RealtimeSession } from './realtime-session';

function session(): RealtimeSession {
  return {
    connect: vi.fn(),
    disconnect: vi.fn(),
    sendFunctionCallOutput: vi.fn(),
    requestResponse: vi.fn(),
    whenAudioDrained: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    updateInstructions: vi.fn(),
    updateConfiguration: vi.fn(),
  };
}

describe('VoiceToolBridge evidence', () => {
  it('records a verified device result with its exact call and target', async () => {
    const realtime = session();
    const receipts: Array<{ status: string; callId: string }> = [];
    const bridge = new VoiceToolBridge(
      realtime,
      {
        execute: vi.fn().mockResolvedValue({
          toolCallId: 'call-1',
          output: JSON.stringify({ ok: true, targetId: 'target-1', command: { type: 'start' } }),
        }),
      },
      (receipt) => receipts.push(receipt),
    );
    bridge.handleFunctionCall({
      callId: 'call-1',
      name: 'shock_start',
      argsJson: '{"targetId":"target-1"}',
    });
    bridge.handleResponseDone();
    await vi.waitFor(() => expect(realtime.requestResponse).toHaveBeenCalledOnce());
    expect(receipts).toMatchObject([{ callId: 'call-1', status: 'succeeded' }]);
  });

  it('records executor errors as failed rather than successful actions', async () => {
    const realtime = session();
    const receipts: Array<{ status: string }> = [];
    const bridge = new VoiceToolBridge(
      realtime,
      {
        execute: vi.fn().mockRejectedValue(new Error('device disconnected')),
      },
      (receipt) => receipts.push(receipt),
    );
    bridge.handleFunctionCall({ callId: 'call-2', name: 'shock_start', argsJson: '{}' });
    bridge.handleResponseDone();
    await vi.waitFor(() => expect(realtime.requestResponse).toHaveBeenCalledOnce());
    expect(receipts).toMatchObject([{ status: 'failed' }]);
  });
});
