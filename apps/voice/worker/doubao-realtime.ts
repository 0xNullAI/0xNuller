/**
 * Translates between the browser's realtime protocol (the flat `session.update`, pcm16 audio,
 * `function_call_output` items) and Doubao's Seeduplex realtime protocol (JSON events at
 * `/api/v3/duplex/realtime/dialogue`). Pure and synchronous: the Durable Object owns the
 * sockets, billing and shutdown; this class owns event shapes and round accounting.
 *
 * Seeduplex facts this relies on (checked against a live session):
 * - `session.create` first, `session.update` later; `tools` are flat and replaced wholesale.
 * - Audio in: base64 pcm s16le 16 kHz mono, 20 ms frames at real-time pace. Audio out:
 *   `pcm_s16le` at 24 kHz, base64 in `response.output_audio.delta`.
 * - User transcription deltas are cumulative, so only the completed text is forwarded.
 * - A tool call arrives as `response.function_call_arguments.done` with `items[]`; all results
 *   go back in ONE `conversation.item.create`, after which the model continues by itself.
 * - `response.done` carries usage once per round (a tool round and its spoken answer share
 *   one), often seconds after the audio ended. Cached input tokens are reported in addition
 *   to the uncached ones.
 */
import { normalizeManagedVoice, type RealtimeUsage } from '@0xnullai/ai-pricing';

export type RoundUsage = Required<RealtimeUsage>;

const MAX_INSTRUCTIONS = 60_000;
const MAX_TOOLS = 64;
const MAX_TOOL_JSON = 16_000;
const MAX_AUDIO_BASE64 = 64_000;
const MAX_TOOL_OUTPUT = 16_000;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function count(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

/**
 * Reads `response.done` usage. Returns null unless every billed field is a non-negative
 * integer: an unreadable report is treated as missing, never filled in.
 */
export function parseRoundUsage(event: Record<string, unknown>): RoundUsage | null {
  const usage = record(record(event.response)?.usage) ?? record(event.usage);
  const input = record(usage?.input_token_details);
  const output = record(usage?.output_token_details);
  if (!input || !output) return null;
  const cached =
    input.cached_tokens_details === undefined ? {} : record(input.cached_tokens_details);
  if (!cached) return null;
  const fields = {
    inputTextTokens: count(input.text_tokens),
    inputAudioTokens: count(input.audio_tokens),
    cachedTextTokens: cached.text_tokens === undefined ? 0 : count(cached.text_tokens),
    cachedAudioTokens: cached.audio_tokens === undefined ? 0 : count(cached.audio_tokens),
    outputTextTokens: count(output.text_tokens),
    outputAudioTokens: count(output.audio_tokens),
  };
  return Object.values(fields).every((value) => value !== null) ? (fields as RoundUsage) : null;
}

export function emptyUsage(): RoundUsage {
  return {
    inputAudioTokens: 0,
    inputTextTokens: 0,
    cachedAudioTokens: 0,
    cachedTextTokens: 0,
    outputAudioTokens: 0,
    outputTextTokens: 0,
  };
}

function sanitizeTools(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const tools: Array<Record<string, unknown>> = [];
  for (const entry of value.slice(0, MAX_TOOLS)) {
    const tool = record(entry);
    const parameters = record(tool?.parameters);
    if (!tool || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name) || !parameters)
      continue;
    const shaped = {
      type: 'function',
      name: tool.name,
      description: typeof tool.description === 'string' ? tool.description.slice(0, 2_000) : '',
      parameters,
    };
    if (JSON.stringify(shaped).length <= MAX_TOOL_JSON) tools.push(shaped);
  }
  return tools;
}

export interface UpstreamResult {
  /** Events for the browser, already serialised. */
  client: string[];
  /** Usage reported for one finished round, if this event carried a readable report. */
  usage?: RoundUsage;
  /** The provider closed the session; no more events will follow. */
  closed?: boolean;
}

export class DoubaoRealtimeBridge {
  private sessionCreated = false;
  private sessionRequested = false;
  private voice: string | null = null;
  /** call_id → output, for the tool batch currently awaiting results. */
  private toolBatch: Map<string, string | null> | null = null;
  /** Rounds that produced output and still await their usage report, oldest first. */
  private readonly open: string[] = [];
  private currentQuestion: string | null = null;
  private anonymousRounds = 0;
  rounds = 0;
  missingRounds = 0;
  readonly usage: RoundUsage = emptyUsage();

  constructor(private readonly model: string) {}

  /** Rounds that produced output and have not reported usage yet. */
  get pendingRounds(): number {
    return this.open.length;
  }

  get ready(): boolean {
    return this.sessionCreated;
  }

  /** Browser event → upstream events (JSON strings). Unknown or invalid events are dropped. */
  fromClient(raw: string): string[] {
    let event: Record<string, unknown> | null;
    try {
      event = record(JSON.parse(raw));
    } catch {
      return [];
    }
    switch (event?.type) {
      case 'session.update':
        return this.sessionEvent(record(event.session));
      case 'input_audio_buffer.append':
        // Audio before the session exists would be refused upstream; a few hundred ms are lost.
        return this.sessionCreated &&
          typeof event.audio === 'string' &&
          event.audio.length <= MAX_AUDIO_BASE64
          ? [JSON.stringify({ type: 'input_audio_buffer.append', audio: event.audio })]
          : [];
      case 'conversation.item.create':
        return this.toolOutput(record(event.item));
      default:
        // `response.create` included: Seeduplex continues by itself after tool results.
        return [];
    }
  }

  private sessionEvent(session: Record<string, unknown> | null): string[] {
    if (!session) return [];
    const instructions =
      typeof session.instructions === 'string'
        ? session.instructions.slice(0, MAX_INSTRUCTIONS)
        : '';
    const tools = sanitizeTools(session.tools);
    if (!this.sessionRequested) {
      this.sessionRequested = true;
      this.voice = normalizeManagedVoice(session.voice);
      return [
        JSON.stringify({
          type: 'session.create',
          session: {
            model: this.model,
            instructions,
            audio: {
              input: { format: { type: 'pcm', rate: 16000 } },
              output: { format: { type: 'pcm_s16le', rate: 24000 }, voice: this.voice },
            },
            tools,
          },
        }),
      ];
    }
    // The voice is fixed for the call; later updates refresh instructions and tools only.
    return [
      JSON.stringify({
        type: 'session.update',
        session: { model: this.model, instructions, tools },
      }),
    ];
  }

  private toolOutput(item: Record<string, unknown> | null): string[] {
    const batch = this.toolBatch;
    if (
      !batch ||
      item?.type !== 'function_call_output' ||
      typeof item.call_id !== 'string' ||
      !batch.has(item.call_id) ||
      batch.get(item.call_id) !== null
    )
      return [];
    batch.set(
      item.call_id,
      typeof item.output === 'string' ? item.output.slice(0, MAX_TOOL_OUTPUT) : '{}',
    );
    if ([...batch.values()].some((output) => output === null)) return [];
    this.toolBatch = null;
    return [
      JSON.stringify({
        type: 'conversation.item.create',
        items: [...batch].map(([callId, output]) => ({
          call_id: callId,
          role: 'tool',
          content: [{ type: 'input_text', text: output }],
        })),
      }),
    ];
  }

  private openRound(questionId: unknown) {
    const key =
      typeof questionId === 'string' && questionId
        ? questionId
        : (this.currentQuestion ?? `round-${++this.anonymousRounds}`);
    if (!this.open.includes(key)) this.open.push(key);
  }

  /** Upstream event → browser events and billing facts. */
  fromUpstream(raw: string): UpstreamResult {
    let event: Record<string, unknown> | null;
    try {
      event = record(JSON.parse(raw));
    } catch {
      return { client: [] };
    }
    if (!event) return { client: [] };
    const send = (...events: Record<string, unknown>[]) =>
      events.map((value) => JSON.stringify(value));
    const responseId = typeof event.response_id === 'string' ? event.response_id : undefined;
    switch (event.type) {
      case 'session.created':
        this.sessionCreated = true;
        return { client: [] };
      case 'conversation.item.input_audio_transcription.started': {
        const itemId = typeof event.item_id === 'string' ? event.item_id : undefined;
        if (itemId) this.currentQuestion = itemId;
        // The user started a turn: barge-in for playback, and a fresh tool-evidence turn.
        return {
          client: send(
            { type: 'input_audio_buffer.speech_started', item_id: itemId },
            ...(itemId
              ? [{ type: 'conversation.item.created', item: { id: itemId, role: 'user' } }]
              : []),
          ),
        };
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const itemId = typeof event.item_id === 'string' ? event.item_id : undefined;
        if (itemId) this.currentQuestion = itemId;
        const text =
          typeof event.text === 'string'
            ? event.text
            : typeof event.transcript === 'string'
              ? event.transcript
              : '';
        return {
          client: send({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: itemId,
            transcript: text,
          }),
        };
      }
      case 'response.output_audio.started':
        this.openRound(event.question_id);
        return { client: send({ type: 'response.created', response_id: responseId }) };
      case 'response.output_text.delta':
        this.openRound(event.question_id);
        return typeof event.delta === 'string'
          ? {
              client: send({
                type: 'response.output_audio_transcript.delta',
                item_id: responseId,
                delta: event.delta,
              }),
            }
          : { client: [] };
      case 'response.output_text.done':
        return {
          client: send({
            type: 'response.output_audio_transcript.done',
            item_id: responseId,
            ...(typeof event.text === 'string' ? { transcript: event.text } : {}),
          }),
        };
      case 'response.output_audio.delta':
        return typeof event.delta === 'string'
          ? { client: send({ type: 'response.output_audio.delta', delta: event.delta }) }
          : { client: [] };
      case 'response.output_audio.done':
        // The browser's per-response gate (device-capable audio, tool sequencing) closes
        // when the spoken answer ends; the provider's usage report can come much later.
        return { client: send({ type: 'response.done' }) };
      case 'response.function_call_arguments.done': {
        const calls = (Array.isArray(event.items) ? event.items : [])
          .map(record)
          .filter(
            (call): call is Record<string, unknown> =>
              !!call &&
              typeof call.call_id === 'string' &&
              call.call_id.length <= 128 &&
              typeof call.name === 'string' &&
              TOOL_NAME.test(call.name) &&
              typeof call.arguments === 'string' &&
              call.arguments.length <= MAX_TOOL_OUTPUT,
          );
        if (!calls.length) return { client: [] };
        this.openRound(event.question_id);
        this.toolBatch = new Map(calls.map((call) => [call.call_id as string, null]));
        return {
          client: send(
            ...calls.map((call) => ({
              type: 'response.function_call_arguments.done',
              call_id: call.call_id,
              name: call.name,
              arguments: call.arguments,
            })),
          ),
        };
      }
      case 'response.done': {
        this.open.shift();
        const usage = parseRoundUsage(event);
        if (!usage) {
          this.missingRounds++;
          return { client: [] };
        }
        this.rounds++;
        for (const key of Object.keys(usage) as (keyof RoundUsage)[]) this.usage[key] += usage[key];
        return { client: [], usage };
      }
      case 'error': {
        const error = record(event.error);
        const code =
          typeof error?.code === 'string' || typeof error?.code === 'number'
            ? String(error.code)
            : '';
        return {
          client: send({
            type: 'error',
            error: { message: code ? `语音服务出错（${code}）` : '语音服务出错' },
          }),
        };
      }
      case 'session.closed':
        return { client: [], closed: true };
      default:
        return { client: [] };
    }
  }

  /** Rounds that ended without usage: the ones still open when the call is torn down. */
  closeRounds(): void {
    this.missingRounds += this.open.length;
    this.open.length = 0;
  }
}
