import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '@dg-kit/core';
import { OpenAiRealtimeSession } from './openai-realtime-session.js';
import { GlmRealtimeSession } from './glm-realtime-session.js';
import { createDefaultRealtimeProviderSettings, type RealtimeProviderId } from './providers.js';
import type { RealtimeSessionOptions } from './realtime-session.js';

const TOOL: ToolDefinition = {
  name: 'shock_start',
  description: '启动郊狼通道',
  parameters: { type: 'object', properties: { channel: { type: 'string' } }, required: ['channel'] },
};

function options(providerId: RealtimeProviderId): RealtimeSessionOptions {
  return {
    settings: { ...createDefaultRealtimeProviderSettings(providerId), apiKey: 'k.k' },
    tools: [TOOL],
    instructions: '你是助手',
    events: {},
  };
}

// Test subclasses expose the protected hooks so the wire shapes can be
// asserted without opening a real WebSocket.
class ProbeOpenAi extends OpenAiRealtimeSession {
  session() {
    return this['buildSessionUpdate']() as { session: Record<string, unknown> };
  }
  callId(m: Record<string, unknown>) {
    return this['functionCallId'](m);
  }
  outputItem(id: string, out: string) {
    return this['functionCallOutputItem'](id, out);
  }
}
class ProbeGlm extends GlmRealtimeSession {
  session() {
    return this['buildSessionUpdate']() as { session: Record<string, unknown> };
  }
  callId(m: Record<string, unknown>) {
    return this['functionCallId'](m);
  }
  outputItem(id: string, out: string) {
    return this['functionCallOutputItem'](id, out);
  }
}

const EXPECTED_TOOL = {
  type: 'function',
  name: 'shock_start',
  description: '启动郊狼通道',
  parameters: TOOL.parameters,
};

describe('every dialect declares tools for tool calling', () => {
  it('xAI (flat shape) includes the tools array + tool_choice auto', () => {
    const { session } = new ProbeOpenAi('xai', options('xai')).session();
    expect(session.tools).toEqual([EXPECTED_TOOL]);
    expect(session.tool_choice).toBe('auto');
    // Flat shape markers.
    expect(session.input_audio_format).toBe('pcm16');
    expect(session.audio).toBeUndefined();
  });

  it('OpenAI GA (nested shape) includes the tools array + nested audio', () => {
    const { session } = new ProbeOpenAi('openai', options('openai')).session();
    expect(session.tools).toEqual([EXPECTED_TOOL]);
    expect(session.tool_choice).toBe('auto');
    // Nested GA shape markers.
    expect(session.audio).toBeDefined();
    expect(session.output_modalities).toEqual(['audio']);
    expect(session.input_audio_format).toBeUndefined();
  });

  it('GLM includes tools, beta_fields, and pcm output', () => {
    const { session } = new ProbeGlm(options('zhipu')).session();
    expect(session.tools).toEqual([EXPECTED_TOOL]);
    expect(session.tool_choice).toBe('auto');
    expect(session.beta_fields).toEqual({ chat_mode: 'audio', tts_source: 'e2e' });
    // Output must be pcm, not wav (the old bug corrupted output audio).
    expect(session.output_audio_format).toBe('pcm');
  });
});

describe('function-call id handling differs per dialect', () => {
  it('OpenAI family uses call_id and echoes it back in the output item', () => {
    const probe = new ProbeOpenAi('openai', options('openai'));
    expect(probe.callId({ call_id: 'c-1', name: 'shock_start', arguments: '{}' })).toBe('c-1');
    expect(probe.outputItem('c-1', '{}')).toEqual({ type: 'function_call_output', call_id: 'c-1', output: '{}' });
  });

  it('GLM falls back to response_id (no call_id) and omits call_id in the output item', () => {
    const probe = new ProbeGlm(options('zhipu'));
    // No call_id in GLM's event — must not drop the call.
    expect(probe.callId({ response_id: 'r-9', name: 'shock_start', arguments: '{}' })).toBe('r-9');
    expect(probe.outputItem('r-9', '{}')).toEqual({ type: 'function_call_output', output: '{}' });
  });
});
