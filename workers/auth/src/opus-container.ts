/**
 * Recorded voice clips are Opus in WebM (Chromium, Android WebView) or Ogg (Firefox). The
 * speech recogniser accepts Ogg Opus only, so a WebM clip is rewrapped packet for packet:
 * no decoding, no re-encoding. The same pass measures the clip length, which bounds the
 * Credit hold before anything is sent to the provider.
 */
export class OpusContainerError extends Error {
  constructor(message = '录音格式无法识别') {
    super(message);
  }
}

export interface OggOpusClip {
  ogg: Uint8Array;
  /** Playable length from the Opus packet headers, after the encoder pre-skip. */
  durationMs: number;
}

const OPUS_RATE = 48_000;

/** Samples (at 48 kHz) in one Opus packet, from its TOC byte (RFC 6716 §3.1). */
export function opusPacketSamples(packet: Uint8Array): number {
  if (!packet.length) throw new OpusContainerError();
  const toc = packet[0]!;
  const config = toc >> 3;
  const frameSamples =
    config < 12
      ? [480, 960, 1920, 2880][config % 4]!
      : config < 16
        ? [480, 960][config % 2]!
        : [120, 240, 480, 960][config % 4]!;
  const code = toc & 3;
  const frames = code === 0 ? 1 : code < 3 ? 2 : (packet[1] ?? 0) & 0x3f;
  const samples = frameSamples * frames;
  if (!samples || samples > 5760) throw new OpusContainerError();
  return samples;
}

// ---- Ogg writing ----

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index << 24;
    for (let bit = 0; bit < 8; bit++)
      value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc;
}

function oggPage(
  packets: Uint8Array[],
  granule: bigint,
  sequence: number,
  flags: number,
): Uint8Array {
  const lacing: number[] = [];
  for (const packet of packets) {
    let remaining = packet.length;
    while (remaining >= 255) {
      lacing.push(255);
      remaining -= 255;
    }
    lacing.push(remaining);
  }
  const bodySize = packets.reduce((sum, packet) => sum + packet.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodySize);
  const view = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53, 0, flags]);
  view.setBigUint64(6, granule, true);
  view.setUint32(14, 0x6d61_6f79, true); // stream serial: any constant for a single stream
  view.setUint32(18, sequence, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let offset = 27 + lacing.length;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }
  view.setUint32(22, oggCrc(page), true);
  return page;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function opusHead(channels: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set(new TextEncoder().encode('OpusHead'));
  head[8] = 1;
  head[9] = channels;
  new DataView(head.buffer).setUint16(10, 312, true); // common encoder pre-skip
  new DataView(head.buffer).setUint32(12, OPUS_RATE, true);
  return head;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode('maoyuan');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode('OpusTags'));
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  return tags;
}

function isOpusHead(bytes: Uint8Array): boolean {
  return bytes.length >= 19 && new TextDecoder().decode(bytes.subarray(0, 8)) === 'OpusHead';
}

function preSkip(head: Uint8Array): number {
  return new DataView(head.buffer, head.byteOffset, head.byteLength).getUint16(10, true);
}

function writeOgg(head: Uint8Array, packets: Uint8Array[]): Uint8Array {
  const pages = [oggPage([head], 0n, 0, 0x02), oggPage([opusTags()], 0n, 1, 0)];
  let granule = 0n;
  let sequence = 2;
  let batch: Uint8Array[] = [];
  let segments = 0;
  packets.forEach((packet, index) => {
    const needed = Math.floor(packet.length / 255) + 1;
    if (batch.length && segments + needed > 255) {
      pages.push(oggPage(batch, granule, sequence++, 0));
      batch = [];
      segments = 0;
    }
    batch.push(packet);
    segments += needed;
    granule += BigInt(opusPacketSamples(packet));
    if (index === packets.length - 1) pages.push(oggPage(batch, granule, sequence++, 0x04));
  });
  return concat(pages);
}

function durationMs(samples: number, skip: number): number {
  return Math.max(0, Math.ceil(((samples - skip) * 1000) / OPUS_RATE));
}

// ---- Ogg reading (only to measure a clip that is already Ogg Opus) ----

/** Validates an Ogg Opus stream and returns its playable length. */
export function measureOggOpus(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  let head: Uint8Array | null = null;
  let lastGranule = 0n;
  let serial: number | null = null;
  while (offset < bytes.length) {
    if (
      offset + 27 > bytes.length ||
      bytes[offset] !== 0x4f ||
      bytes[offset + 1] !== 0x67 ||
      bytes[offset + 2] !== 0x67 ||
      bytes[offset + 3] !== 0x53
    )
      throw new OpusContainerError();
    const pageSerial = view.getUint32(offset + 14, true);
    if (serial === null) serial = pageSerial;
    if (pageSerial !== serial) throw new OpusContainerError('只支持单声道流的录音');
    const count = bytes[offset + 26]!;
    let size = 0;
    for (let index = 0; index < count; index++) size += bytes[offset + 27 + index] ?? 0;
    const body = offset + 27 + count;
    if (body + size > bytes.length) throw new OpusContainerError();
    if (!head) head = bytes.subarray(body, body + size);
    const granule = view.getBigUint64(offset + 6, true);
    if (granule !== 0xffff_ffff_ffff_ffffn && granule > lastGranule) lastGranule = granule;
    offset = body + size;
  }
  if (!head || !isOpusHead(head)) throw new OpusContainerError();
  if (lastGranule > BigInt(Number.MAX_SAFE_INTEGER)) throw new OpusContainerError();
  return durationMs(Number(lastGranule), preSkip(head));
}

// ---- WebM (Matroska) reading ----

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  audio: 0xe1,
  channels: 0x9f,
  cluster: 0x1f43b675,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
} as const;
/** Elements whose children we need; everything else is skipped by size. */
const CONTAINERS = new Set<number>([
  ID.segment,
  ID.tracks,
  ID.trackEntry,
  ID.audio,
  ID.cluster,
  ID.blockGroup,
]);
const UNKNOWN_SIZE = -1;

function readVint(bytes: Uint8Array, offset: number, keepMarker: boolean) {
  const first = bytes[offset];
  if (first === undefined || first === 0) throw new OpusContainerError();
  let length = 1;
  while (!(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || offset + length > bytes.length) throw new OpusContainerError();
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let index = 1; index < length; index++) {
    const byte = bytes[offset + index]!;
    allOnes &&= byte === 0xff;
    value = value * 256 + byte;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

interface WebmTrack {
  number: number;
  codec: string;
  privateData: Uint8Array | null;
  channels: number;
}

/** Rewraps WebM Opus packets into Ogg Opus. Lacing and non-Opus tracks are rejected. */
export function webmOpusToOgg(bytes: Uint8Array): OggOpusClip {
  if (readVint(bytes, 0, true).value !== ID.ebml) throw new OpusContainerError();
  const tracks: WebmTrack[] = [];
  const packets: Uint8Array[] = [];
  let track: WebmTrack | null = null;
  let audioTrack: number | null = null;

  const blockPacket = (start: number, end: number) => {
    const number = readVint(bytes, start, false);
    const flags = bytes[start + number.length + 2];
    if (flags === undefined) throw new OpusContainerError();
    audioTrack ??= tracks.find((candidate) => candidate.codec === 'A_OPUS')?.number ?? null;
    if (audioTrack === null) throw new OpusContainerError('录音不是 Opus 编码');
    if (number.value !== audioTrack) return;
    if (flags & 0x06) throw new OpusContainerError();
    const packet = bytes.slice(start + number.length + 3, end);
    opusPacketSamples(packet);
    packets.push(packet);
  };

  const walk = (start: number, end: number, parent: number) => {
    let offset = start;
    while (offset < end) {
      const id = readVint(bytes, offset, true);
      const size = readVint(bytes, offset + id.length, false);
      const body = offset + id.length + size.length;
      const length = size.unknown ? UNKNOWN_SIZE : size.value;
      if (length === UNKNOWN_SIZE && !CONTAINERS.has(id.value)) throw new OpusContainerError();
      // An unknown size (live MediaRecorder output) runs to the end of the parent.
      const stop = length === UNKNOWN_SIZE ? end : body + length;
      if (stop > end || stop > bytes.length) throw new OpusContainerError();
      if (id.value === ID.trackEntry) {
        track = { number: 0, codec: '', privateData: null, channels: 1 };
        walk(body, stop, id.value);
        tracks.push(track);
        track = null;
      } else if (CONTAINERS.has(id.value)) {
        if (length === UNKNOWN_SIZE && id.value === ID.cluster) {
          // Clusters of unknown size end where the next cluster (or other top element) starts.
          offset = walkCluster(body, end);
          continue;
        }
        walk(body, stop, id.value);
      } else if (id.value === ID.simpleBlock || (id.value === ID.block && parent === ID.blockGroup))
        blockPacket(body, stop);
      else if (track && id.value === ID.trackNumber) track.number = readUint(body, stop);
      else if (track && id.value === ID.codecId)
        track.codec = new TextDecoder().decode(bytes.subarray(body, stop));
      else if (track && id.value === ID.codecPrivate) track.privateData = bytes.slice(body, stop);
      else if (track && id.value === ID.channels) track.channels = readUint(body, stop);
      offset = stop;
    }
  };

  const walkCluster = (start: number, end: number): number => {
    let offset = start;
    while (offset < end) {
      const id = readVint(bytes, offset, true);
      if (id.value === ID.cluster || id.value === ID.tracks || id.value === ID.segment)
        return offset;
      const size = readVint(bytes, offset + id.length, false);
      const body = offset + id.length + size.length;
      if (size.unknown) throw new OpusContainerError();
      const stop = body + size.value;
      if (stop > end) throw new OpusContainerError();
      if (id.value === ID.simpleBlock) blockPacket(body, stop);
      else if (id.value === ID.blockGroup) walk(body, stop, id.value);
      offset = stop;
    }
    return offset;
  };

  const readUint = (start: number, end: number) => {
    let value = 0;
    for (let index = start; index < end; index++) value = value * 256 + bytes[index]!;
    return value;
  };

  walk(0, bytes.length, 0);
  const opus = tracks.find((candidate) => candidate.number === audioTrack);
  if (!opus || !packets.length) throw new OpusContainerError();
  const channels = opus.channels === 2 ? 2 : 1;
  const head =
    opus.privateData && isOpusHead(opus.privateData) ? opus.privateData : opusHead(channels);
  const samples = packets.reduce((sum, packet) => sum + opusPacketSamples(packet), 0);
  return { ogg: writeOgg(head, packets), durationMs: durationMs(samples, preSkip(head)) };
}

/** Normalises a stored voice clip for the recogniser. */
export function oggOpusClip(bytes: Uint8Array, mime: string): OggOpusClip {
  if (mime === 'audio/ogg') return { ogg: bytes, durationMs: measureOggOpus(bytes) };
  if (mime === 'audio/webm') return webmOpusToOgg(bytes);
  throw new OpusContainerError('此录音格式暂不支持自动识别');
}
