import { describe, expect, it } from 'vitest';
import type { RealtimeTranscriptEntry } from './realtime-session.js';

/**
 * Mirrors the reducer in `use-realtime-call.ts`'s `onTranscript` handler.
 * Kept as a standalone pure function here so the append-vs-replace
 * behaviour is testable without mounting React — the bug this guards
 * against (a second turn overwriting the first instead of appending)
 * shipped once and was only caught by manual testing.
 */
function applyTranscript(
  transcript: RealtimeTranscriptEntry[],
  entry: RealtimeTranscriptEntry,
): RealtimeTranscriptEntry[] {
  const index = transcript.findIndex((item) => item.id === entry.id);
  return index === -1
    ? [...transcript, entry]
    : transcript.map((item, i) => (i === index ? entry : item));
}

describe('transcript accumulation', () => {
  it('appends a new turn instead of replacing the previous one', () => {
    let transcript: RealtimeTranscriptEntry[] = [];
    transcript = applyTranscript(transcript, { id: 'u1', role: 'user', text: '你好', done: true });
    transcript = applyTranscript(transcript, { id: 'a1', role: 'assistant', text: '你好呀', done: true });
    transcript = applyTranscript(transcript, { id: 'u2', role: 'user', text: '再来一次', done: true });

    expect(transcript.map((t) => t.text)).toEqual(['你好', '你好呀', '再来一次']);
  });

  it('updates the same line in place while deltas stream for one item id', () => {
    let transcript: RealtimeTranscriptEntry[] = [];
    transcript = applyTranscript(transcript, { id: 'a1', role: 'assistant', text: '你', done: false });
    transcript = applyTranscript(transcript, { id: 'a1', role: 'assistant', text: '你好', done: false });
    transcript = applyTranscript(transcript, { id: 'a1', role: 'assistant', text: '你好呀', done: true });

    expect(transcript).toHaveLength(1);
    expect(transcript[0]).toEqual({ id: 'a1', role: 'assistant', text: '你好呀', done: true });
  });

  it('keeps interleaved user and assistant turns in arrival order', () => {
    let transcript: RealtimeTranscriptEntry[] = [];
    transcript = applyTranscript(transcript, { id: 'u1', role: 'user', text: '一', done: true });
    transcript = applyTranscript(transcript, { id: 'a1', role: 'assistant', text: '二', done: false });
    transcript = applyTranscript(transcript, { id: 'u2', role: 'user', text: '三', done: true });
    // A late delta for the earlier assistant item must not reorder it to the end.
    transcript = applyTranscript(transcript, { id: 'a1', role: 'assistant', text: '二二', done: true });

    expect(transcript.map((t) => `${t.role}:${t.text}`)).toEqual([
      'user:一',
      'assistant:二二',
      'user:三',
    ]);
  });
});
