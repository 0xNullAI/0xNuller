import { describe, expect, it } from 'vitest';
import { DoubaoRealtimeBridge, parseRoundUsage } from './doubao-realtime.js';

const parse = (messages: string[]) => messages.map((message) => JSON.parse(message));
const up = (bridge: DoubaoRealtimeBridge, event: Record<string, unknown>) =>
  bridge.fromUpstream(JSON.stringify(event));
const down = (bridge: DoubaoRealtimeBridge, event: Record<string, unknown>) =>
  parse(bridge.fromClient(JSON.stringify(event)));

/** The usage shape a live Seeduplex `response.done` carried. */
const doneEvent = {
  type: 'response.done',
  response: {
    usage: {
      total_tokens: 5711,
      input_tokens: 2858,
      output_tokens: 293,
      input_token_details: {
        text_tokens: 2736,
        audio_tokens: 122,
        image_tokens: 0,
        cached_tokens: 2560,
        cached_tokens_details: { text_tokens: 2560, audio_tokens: 0, image_tokens: 0 },
      },
      output_token_details: { text_tokens: 89, audio_tokens: 204 },
    },
  },
};

function started() {
  const bridge = new DoubaoRealtimeBridge('example-realtime-model');
  down(bridge, {
    type: 'session.update',
    session: { instructions: 'persona', voice: 'eve', tools: [] },
  });
  up(bridge, { type: 'session.created', session: { id: 's1' } });
  return bridge;
}

describe('Seeduplex usage', () => {
  it('reads cached input as its own bucket, not a subset of input', () => {
    expect(parseRoundUsage(doneEvent)).toEqual({
      inputTextTokens: 2736,
      inputAudioTokens: 122,
      cachedTextTokens: 2560,
      cachedAudioTokens: 0,
      outputTextTokens: 89,
      outputAudioTokens: 204,
    });
  });

  it('treats any unreadable report as missing rather than estimating', () => {
    expect(parseRoundUsage({ type: 'response.done' })).toBeNull();
    expect(
      parseRoundUsage({ response: { usage: { input_tokens: 10, output_tokens: 5 } } }),
    ).toBeNull();
    const negative = structuredClone(doneEvent);
    negative.response.usage.output_token_details.audio_tokens = -1;
    expect(parseRoundUsage(negative)).toBeNull();
    const fractional = structuredClone(doneEvent);
    fractional.response.usage.input_token_details.text_tokens = 1.5;
    expect(parseRoundUsage(fractional)).toBeNull();
  });
});

describe('browser ↔ Seeduplex translation', () => {
  it('creates the session once with the model, a catalog voice and flat tools, then only updates', () => {
    const bridge = new DoubaoRealtimeBridge('example-realtime-model');
    const tool = {
      type: 'function',
      name: 'set_strength',
      description: 'd',
      parameters: { type: 'object', properties: {} },
    };
    const [create] = down(bridge, {
      type: 'session.update',
      session: {
        instructions: 'persona',
        voice: 'eve',
        tools: [tool, { name: 'bad name!', parameters: {} }, { name: 'no_params' }],
        turn_detection: { type: 'server_vad' },
      },
    });
    expect(create).toEqual({
      type: 'session.create',
      session: {
        model: 'example-realtime-model',
        instructions: 'persona',
        audio: {
          input: { format: { type: 'pcm', rate: 16000 } },
          output: {
            format: { type: 'pcm_s16le', rate: 24000 },
            voice: 'zh_female_vv_uranus_bigtts',
          },
        },
        tools: [tool],
      },
    });
    expect(
      down(bridge, {
        type: 'session.update',
        session: { instructions: 'fresh status', voice: 'zh_male_m191_uranus_bigtts', tools: [] },
      }),
    ).toEqual([
      {
        type: 'session.update',
        session: { model: 'example-realtime-model', instructions: 'fresh status', tools: [] },
      },
    ]);
  });

  it('drops audio until the session exists and forwards it afterwards', () => {
    const bridge = new DoubaoRealtimeBridge('m');
    down(bridge, { type: 'session.update', session: { instructions: '' } });
    expect(down(bridge, { type: 'input_audio_buffer.append', audio: 'AAAA' })).toEqual([]);
    up(bridge, { type: 'session.created', session: { id: 's' } });
    expect(down(bridge, { type: 'input_audio_buffer.append', audio: 'AAAA' })).toEqual([
      { type: 'input_audio_buffer.append', audio: 'AAAA' },
    ]);
    expect(down(bridge, { type: 'input_audio_buffer.append', audio: 'A'.repeat(70_000) })).toEqual(
      [],
    );
    expect(down(bridge, { type: 'response.create' })).toEqual([]);
    expect(down(bridge, { type: 'session.close' })).toEqual([]);
  });

  it('maps a user turn, a parallel tool call and the spoken answer to browser events', () => {
    const bridge = started();
    expect(
      parse(
        up(bridge, { type: 'conversation.item.input_audio_transcription.started', item_id: 'q1' })
          .client,
      ),
    ).toEqual([
      { type: 'input_audio_buffer.speech_started', item_id: 'q1' },
      { type: 'conversation.item.created', item: { id: 'q1', role: 'user' } },
    ]);
    // Cumulative deltas would duplicate text in an appending UI; only the final text is sent.
    expect(
      up(bridge, {
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'q1',
        delta: '帮我',
      }).client,
    ).toEqual([]);
    expect(
      parse(
        up(bridge, {
          type: 'conversation.item.input_audio_transcription.completed',
          item_id: 'q1',
          text: '帮我调一下',
        }).client,
      ),
    ).toEqual([
      {
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'q1',
        transcript: '帮我调一下',
      },
    ]);
    const calls = parse(
      up(bridge, {
        type: 'response.function_call_arguments.done',
        items: [
          { call_id: 'c1', name: 'set_strength', arguments: '{"value":5}' },
          { call_id: 'c2', name: 'get_status', arguments: '{}' },
        ],
      }).client,
    );
    expect(calls).toEqual([
      {
        type: 'response.function_call_arguments.done',
        call_id: 'c1',
        name: 'set_strength',
        arguments: '{"value":5}',
      },
      {
        type: 'response.function_call_arguments.done',
        call_id: 'c2',
        name: 'get_status',
        arguments: '{}',
      },
    ]);
    expect(bridge.pendingRounds).toBe(1);
    // Results go back together, once every call in the batch has one.
    const output = (callId: string, value: string) =>
      down(bridge, {
        type: 'conversation.item.create',
        item: { type: 'function_call_output', call_id: callId, output: value },
      });
    expect(output('c1', '{"ok":true}')).toEqual([]);
    expect(output('unknown', '{}')).toEqual([]);
    expect(output('c2', '{"strength":5}')).toEqual([
      {
        type: 'conversation.item.create',
        items: [
          { call_id: 'c1', role: 'tool', content: [{ type: 'input_text', text: '{"ok":true}' }] },
          {
            call_id: 'c2',
            role: 'tool',
            content: [{ type: 'input_text', text: '{"strength":5}' }],
          },
        ],
      },
    ]);
    expect(output('c1', 'replay')).toEqual([]);

    expect(
      parse(
        up(bridge, {
          type: 'response.output_audio.started',
          question_id: 'q1',
          response_id: 'r1',
        }).client,
      ),
    ).toEqual([{ type: 'response.created', response_id: 'r1' }]);
    expect(
      parse(
        up(bridge, {
          type: 'response.output_text.delta',
          question_id: 'q1',
          response_id: 'r1',
          delta: '好的',
        }).client,
      ),
    ).toEqual([{ type: 'response.output_audio_transcript.delta', item_id: 'r1', delta: '好的' }]);
    expect(
      parse(up(bridge, { type: 'response.output_audio.delta', delta: 'AAAA' }).client),
    ).toEqual([{ type: 'response.output_audio.delta', delta: 'AAAA' }]);
    expect(
      parse(
        up(bridge, {
          type: 'response.output_text.done',
          question_id: 'q1',
          response_id: 'r1',
          text: '好的，已调到 5。',
        }).client,
      ),
    ).toEqual([
      {
        type: 'response.output_audio_transcript.done',
        item_id: 'r1',
        transcript: '好的，已调到 5。',
      },
    ]);
    // The browser's response ends with the audio; usage arrives later and stays server-side.
    expect(
      parse(up(bridge, { type: 'response.output_audio.done', response_id: 'r1' }).client),
    ).toEqual([{ type: 'response.done' }]);
    // The tool round and its answer share one question, so they are one billed round.
    expect(bridge.pendingRounds).toBe(1);
    const done = up(bridge, doneEvent);
    expect(done.client).toEqual([]);
    expect(done.usage?.outputAudioTokens).toBe(204);
    expect(bridge.pendingRounds).toBe(0);
    expect(bridge.rounds).toBe(1);
  });

  it('counts rounds that never report usage as missing at teardown', () => {
    const bridge = started();
    up(bridge, { type: 'response.output_audio.started', question_id: 'q1', response_id: 'r1' });
    up(bridge, { type: 'response.done', response: {} });
    up(bridge, { type: 'response.output_audio.started', question_id: 'q2', response_id: 'r2' });
    expect(bridge.missingRounds).toBe(1);
    expect(bridge.pendingRounds).toBe(1);
    bridge.closeRounds();
    expect(bridge.missingRounds).toBe(2);
    expect(bridge.rounds).toBe(0);
    expect(bridge.usage.outputAudioTokens).toBe(0);
  });

  it('sums usage over rounds and reports provider errors without leaking details', () => {
    const bridge = started();
    up(bridge, doneEvent);
    up(bridge, doneEvent);
    expect(bridge.usage).toMatchObject({ inputTextTokens: 5472, cachedTextTokens: 5120 });
    expect(
      parse(
        up(bridge, {
          type: 'error',
          error: { code: '55000000', message: 'speaker=x cant find internal voice' },
        }).client,
      ),
    ).toEqual([{ type: 'error', error: { message: '语音服务出错（55000000）' } }]);
    expect(up(bridge, { type: 'session.closed' }).closed).toBe(true);
    expect(up(bridge, { type: 'not json' }).client).toEqual([]);
    expect(bridge.fromUpstream('{').client).toEqual([]);
  });
});
