import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '@dg-kit/core';
import { int16ToBase64 } from './audio';
import { BaseRealtimeSession } from './base-realtime-session';
import type { RealtimeSessionOptions } from './realtime-session';

class TestSession extends BaseRealtimeSession {
  readonly played = vi.fn();
  constructor(options: RealtimeSessionOptions) {
    super(options);
    vi.spyOn(this.playback, 'enqueuePcm16').mockImplementation(this.played);
    vi.spyOn(this.playback, 'whenDrained').mockResolvedValue(undefined);
  }
  dispatch(message: Record<string, unknown>): void {
    (this as unknown as { handleMessage(raw: string): void }).handleMessage(
      JSON.stringify(message),
    );
  }
  protected buildConnection(): Promise<{ url: string }> {
    return Promise.resolve({ url: '' });
  }
  protected buildSessionUpdate(): Record<string, unknown> {
    return {};
  }
  protected encodeAudioFrame(): string {
    return '';
  }
}

function createSession(authorize: (text: string) => boolean): TestSession {
  return new TestSession({
    settings: {} as RealtimeSessionOptions['settings'],
    instructions: '',
    tools: [{ name: 'shock_start' } as ToolDefinition],
    events: { onAuthorizeAudio: authorize },
  });
}

function emitReply(session: TestSession, text?: string): void {
  session.dispatch({ type: 'response.audio.delta', delta: int16ToBase64(new Int16Array([1, 2])) });
  if (text)
    session.dispatch({ type: 'response.audio_transcript.done', item_id: 'a', transcript: text });
  session.dispatch({ type: 'response.done' });
}

describe('device-capable realtime audio', () => {
  it('waits for the final transcript before playing approved audio', () => {
    const session = createSession((text) => text === '你好');
    session.dispatch({ type: 'response.audio.delta', delta: int16ToBase64(new Int16Array([1])) });
    expect(session.played).not.toHaveBeenCalled();
    session.dispatch({ type: 'response.audio_transcript.done', item_id: 'a', transcript: '你好' });
    session.dispatch({ type: 'response.done' });
    expect(session.played).toHaveBeenCalledOnce();
  });

  it('drops audio without a transcript or authorization', () => {
    const session = createSession((text) => text === 'safe');
    emitReply(session);
    emitReply(session, '未经验证的设备操作');
    expect(session.played).not.toHaveBeenCalled();
  });

  it('drops buffered audio after the user interrupts', () => {
    const session = createSession(() => true);
    session.dispatch({ type: 'response.audio.delta', delta: int16ToBase64(new Int16Array([1])) });
    session.dispatch({ type: 'input_audio_buffer.speech_started' });
    session.dispatch({ type: 'response.audio_transcript.done', item_id: 'a', transcript: '你好' });
    session.dispatch({ type: 'response.done' });
    expect(session.played).not.toHaveBeenCalled();
  });

  it('does not treat the start of a normal user turn as an interrupted reply', () => {
    const session = createSession(() => true);
    session.dispatch({ type: 'input_audio_buffer.speech_started' });
    session.dispatch({ type: 'response.created' });
    emitReply(session, '你好');
    expect(session.played).toHaveBeenCalledOnce();
  });

  it('drops a response interrupted before its first audio chunk', () => {
    const session = createSession(() => true);
    session.dispatch({ type: 'response.created' });
    session.dispatch({ type: 'input_audio_buffer.speech_started' });
    emitReply(session, '你好');
    expect(session.played).not.toHaveBeenCalled();
  });

  it('does not resume ordinary streaming audio after a barge-in', () => {
    const session = createSession(() => true);
    session.updateConfiguration({ instructions: '', tools: [] });
    session.dispatch({ type: 'response.created' });
    session.dispatch({ type: 'response.audio.delta', delta: int16ToBase64(new Int16Array([1])) });
    expect(session.played).toHaveBeenCalledOnce();
    session.dispatch({ type: 'input_audio_buffer.speech_started' });
    session.dispatch({ type: 'response.audio.delta', delta: int16ToBase64(new Int16Array([2])) });
    expect(session.played).toHaveBeenCalledOnce();
  });
});

it('uses separate subtitle IDs for successive provider turns without item_id', () => {
  const onTranscript = vi.fn();
  const session = new TestSession({
    settings: {} as RealtimeSessionOptions['settings'],
    instructions: '',
    tools: [],
    events: { onTranscript },
  });

  for (const text of ['第一轮', '第二轮']) {
    session.dispatch({ type: 'conversation.item.input_audio_transcription.delta', delta: text });
    session.dispatch({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: text,
    });
    session.dispatch({ type: 'response.audio_transcript.delta', delta: text });
    session.dispatch({ type: 'response.audio_transcript.done', transcript: text });
    session.dispatch({ type: 'response.done' });
  }

  const final = onTranscript.mock.calls
    .map(([entry]) => entry as { id: string; role: string; text: string; done: boolean })
    .filter((entry) => entry.done);
  expect(final.map(({ role, text }) => `${role}:${text}`)).toEqual([
    'user:第一轮',
    'assistant:第一轮',
    'user:第二轮',
    'assistant:第二轮',
  ]);
  expect(new Set(final.map(({ id }) => id)).size).toBe(4);
});

it('reports the start of each spoken user turn', () => {
  const onUserTurnStarted = vi.fn();
  const session = new TestSession({
    settings: {} as RealtimeSessionOptions['settings'],
    instructions: '',
    tools: [],
    events: { onUserTurnStarted },
  });
  session.dispatch({ type: 'input_audio_buffer.speech_started' });
  expect(onUserTurnStarted).toHaveBeenCalledOnce();
});

it('reserves the user transcript line from the GA conversation.item.added event', () => {
  const onTranscript = vi.fn();
  const session = new TestSession({
    settings: {} as RealtimeSessionOptions['settings'],
    instructions: '',
    tools: [],
    events: { onTranscript },
  });
  session.dispatch({ type: 'conversation.item.added', item: { id: 'u1', role: 'user' } });
  expect(onTranscript).toHaveBeenCalledWith(
    expect.objectContaining({ role: 'user', text: '', done: false }),
  );
});
