/**
 * Test fixtures for recorded voice clips: a minimal WebM (Matroska) Opus file built byte by
 * byte, and a fake WebSocket upgrade for the speech recogniser.
 */
import { vi } from 'vitest';

function vint(value: number): number[] {
  if (value < 0x7f) return [0x80 | value];
  if (value < 0x3fff) return [0x40 | (value >> 8), value & 0xff];
  return [0x10 | (value >>> 24), (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
function element(id: number[], body: number[], unknownSize = false): number[] {
  return [...id, ...(unknownSize ? UNKNOWN : vint(body.length)), ...body];
}

/** One 20 ms SILK frame per packet (TOC config 1, code 0) with a few payload bytes. */
export function opusPacket(seed = 0): number[] {
  return [0x08, 0x10 + (seed % 7), 0x20, 0x30];
}

/**
 * A WebM like MediaRecorder writes: unknown-size Segment and (optionally) Clusters, one Opus
 * track with an OpusHead CodecPrivate, audio in SimpleBlocks.
 */
export function webmOpus(
  seconds: number,
  { unknownClusters = true, codec = 'A_OPUS' } = {},
): Uint8Array {
  const head = [
    ...new TextEncoder().encode('OpusHead'),
    1,
    1,
    0x38,
    0x01, // pre-skip 312
    0x80,
    0xbb,
    0,
    0, // 48000
    0,
    0,
    0,
  ];
  const track = element(
    [0xae],
    [
      ...element([0xd7], [1]),
      ...element([0x86], [...new TextEncoder().encode(codec)]),
      ...element([0x63, 0xa2], head),
      ...element([0xe1], element([0x9f], [1])),
    ],
  );
  const packets = Math.round((seconds * 1000) / 20);
  const clusters: number[] = [];
  for (let start = 0; start < packets; start += 50) {
    const blocks: number[] = element([0xe7], [0]);
    for (let index = start; index < Math.min(packets, start + 50); index++)
      blocks.push(...element([0xa3], [0x81, 0, 0, 0x80, ...opusPacket(index)]));
    clusters.push(...element([0x1f, 0x43, 0xb6, 0x75], blocks, unknownClusters));
  }
  const ebml = element(
    [0x1a, 0x45, 0xdf, 0xa3],
    element([0x42, 0x82], [...new TextEncoder().encode('webm')]),
  );
  const segment = element(
    [0x18, 0x53, 0x80, 0x67],
    [...element([0x16, 0x54, 0xae, 0x6b], track), ...clusters],
    true,
  );
  return new Uint8Array([...ebml, ...segment]);
}

type Listener = (event: { data?: unknown }) => void;

/** Server frame: full response with sequence, or an error frame. */
function serverFrame(payload: unknown, flags: number, errorCode?: number): ArrayBuffer {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const isError = errorCode !== undefined;
  const frame = new Uint8Array(12 + body.length);
  frame.set([0x11, ((isError ? 0b1111 : 0b1001) << 4) | flags, 0x10, 0]);
  const view = new DataView(frame.buffer);
  view.setUint32(4, isError ? errorCode : 1);
  view.setUint32(8, body.length);
  frame.set(body, 12);
  return frame.buffer;
}

export type AsrScript =
  | { text: string; durationMs: number }
  | { errorCode: number }
  | { durationMs?: undefined; text: string; omitDuration: true }
  | 'hang'
  /** The connection drops after all audio was sent, before any final result. */
  | 'drop';

/** A `fetch` that upgrades to a fake recogniser socket and answers after the last packet. */
export function fakeAsrFetch(script: AsrScript) {
  const sent: Uint8Array[] = [];
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => {
    const listeners = new Map<string, Listener[]>();
    const emit = (type: string, event: { data?: unknown } = {}) =>
      queueMicrotask(() => listeners.get(type)?.forEach((listener) => listener(event)));
    const socket = {
      accept: vi.fn(),
      close: vi.fn(),
      addEventListener: (type: string, listener: Listener) =>
        listeners.set(type, [...(listeners.get(type) ?? []), listener]),
      send: (data: Uint8Array) => {
        sent.push(data);
        if (script === 'hang' || data[1]! >> 4 !== 0b0010 || (data[1]! & 0b0010) === 0) return;
        if (script === 'drop') {
          emit('close');
          return;
        }
        if ('errorCode' in script) {
          emit('message', { data: serverFrame({ error: 'rejected' }, 0, script.errorCode) });
          return;
        }
        emit('message', {
          data: serverFrame({ audio_info: { duration: 200 }, result: { text: '' } }, 1),
        });
        emit('message', {
          data: serverFrame(
            {
              ...('omitDuration' in script ? {} : { audio_info: { duration: script.durationMs } }),
              result: { text: script.text },
            },
            3,
          ),
        });
      },
    };
    return { webSocket: socket, body: null } as unknown as Response;
  });
  return { fetcher, sent };
}
