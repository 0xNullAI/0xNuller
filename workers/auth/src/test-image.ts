import { deflateSync } from 'node:zlib';

function u32(value: number): Uint8Array {
  return Uint8Array.of(value >>> 24, value >>> 16, value >>> 8, value);
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), payload]);
  let crc = 0xffffffff;
  for (const byte of body) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return Buffer.concat([u32(payload.length), body, u32((crc ^ 0xffffffff) >>> 0)]);
}

/** A valid 1 × 1 RGBA PNG for server image upload tests. */
export const VALID_PNG = Uint8Array.from(
  Buffer.concat([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0)),
    chunk('IDAT', deflateSync(Uint8Array.of(0, 255, 0, 0, 255))),
    chunk('IEND', new Uint8Array()),
  ]),
);
