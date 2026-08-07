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
  feed(msg: Record<string, unknown>) {
    this['handleMessage'](JSON.stringify(msg));
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

  it('GLM includes tools + beta_fields but OMITS tool_choice, and uses pcm output', () => {
    const { session } = new ProbeGlm(options('zhipu')).session();
    expect(session.tools).toEqual([EXPECTED_TOOL]);
    // GLM-Realtime rejects the ENTIRE session.update with 400 if tool_choice is
    // present (verified against a live key). It must be absent, not 'auto'.
    expect('tool_choice' in session).toBe(false);
    expect(session.beta_fields).toEqual({ chat_mode: 'audio', tts_source: 'e2e' });
    // Output must be pcm, not wav (the old bug corrupted output audio).
    expect(session.output_audio_format).toBe('pcm');
  });

  it('GLM forces a non-empty required for optional-only tools; other dialects leave it untouched', () => {
    // Real shape of shock_stop/vibrate_stop: one optional property, no `required`.
    const optionalOnly: ToolDefinition = {
      name: 'shock_stop',
      description: '停止',
      parameters: { type: 'object', properties: { channel: { type: 'string', enum: ['A', 'B'] } } },
    };
    const withTool = (id: RealtimeProviderId): RealtimeSessionOptions => ({
      settings: { ...createDefaultRealtimeProviderSettings(id), apiKey: 'k.k' },
      tools: [optionalOnly],
      instructions: '你是助手',
      events: {},
    });
    // GLM: 422s on an empty/absent required, so every property becomes required.
    const glmTools = new ProbeGlm(withTool('zhipu')).session().session.tools as Array<{
      parameters: { required?: unknown };
    }>;
    expect(glmTools[0]?.parameters.required).toEqual(['channel']);
    // xAI/OpenAI: untouched — `channel` stays optional (no `required` key).
    const xaiTools = new ProbeOpenAi('xai', withTool('xai')).session().session.tools as Array<{
      parameters: { required?: unknown };
    }>;
    expect(xaiTools[0]?.parameters.required).toBeUndefined();
  });

  it('keeps user and assistant transcripts distinct when GLM reuses one item_id for the turn', () => {
    const entries: Array<{ id: string; role: string; text: string }> = [];
    const probe = new ProbeGlm({
      settings: { ...createDefaultRealtimeProviderSettings('zhipu'), apiKey: 'k.k' },
      tools: [],
      instructions: 'x',
      events: { onTranscript: (e) => entries.push(e) },
    });
    const ITEM = 'item-shared-abc'; // GLM sends the SAME item_id for both roles
    probe.feed({ type: 'conversation.item.input_audio_transcription.completed', item_id: ITEM, transcript: '你好' });
    probe.feed({ type: 'response.audio_transcript.done', item_id: ITEM, transcript: '你好呀' });

    const user = entries.find((e) => e.role === 'user');
    const assistant = entries.find((e) => e.role === 'assistant');
    expect(user?.text).toBe('你好');
    expect(assistant?.text).toBe('你好呀');
    // Distinct ids → the reply can't overwrite the user's line in the UI.
    expect(user?.id).not.toBe(assistant?.id);
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
