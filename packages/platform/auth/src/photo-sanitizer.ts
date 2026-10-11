const MAX_DIMENSION = 4096;

export function sanitizePhoto(input: ArrayBuffer, mime: string): Uint8Array {
  const bytes = new Uint8Array(input);
  if (mime === 'image/jpeg') return sanitizeJpeg(bytes);
  if (mime === 'image/png') return sanitizePng(bytes);
  if (mime === 'image/webp') return sanitizeWebp(bytes);
  throw new Error('unsupported image type');
}

function concat(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function dimensions(width: number, height: number): void {
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error('image dimensions out of range');
  }
}

function sanitizeJpeg(bytes: Uint8Array): Uint8Array {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('invalid jpeg');
  const parts = [bytes.slice(0, 2)];
  let offset = 2;
  let sawSize = false;
  let sawScan = false;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('invalid jpeg segment');
    const marker = bytes[offset + 1]!;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + length + 2 > bytes.length) throw new Error('invalid jpeg segment');
    const end = offset + length + 2;
    if (marker === 0xda) {
      if (!sawSize) throw new Error('invalid jpeg');
      let imageEnd = -1;
      for (let i = end; i + 1 < bytes.length; i++) {
        if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) {
          imageEnd = i + 2;
          break;
        }
      }
      if (imageEnd < 0) throw new Error('invalid jpeg');
      parts.push(bytes.slice(offset, imageEnd));
      sawScan = true;
      break;
    }
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      dimensions(
        (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
        (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
      );
      sawSize = true;
    }
    if (marker !== 0xe1 && marker !== 0xed && marker !== 0xfe) parts.push(bytes.slice(offset, end));
    offset = end;
  }
  if (!sawSize || !sawScan) throw new Error('invalid jpeg');
  return concat(parts);
}

function u32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}
function ascii(bytes: Uint8Array, offset: number, size: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + size));
}

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc ^= bytes[i]!;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function sanitizePng(bytes: Uint8Array): Uint8Array {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, i) => bytes[i] === value)) throw new Error('invalid png');
  const parts = [bytes.slice(0, 8)];
  const metadata = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  let offset = 8;
  let sawEnd = false;
  let sawHeader = false;
  let sawImage = false;
  while (offset + 12 <= bytes.length) {
    const length = u32(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('invalid png chunk');
    const type = ascii(bytes, offset + 4, 4);
    if (u32(bytes, end - 4) !== crc32(bytes, offset + 4, end - 4))
      throw new Error('invalid png checksum');
    if (!sawHeader && (type !== 'IHDR' || length !== 13)) throw new Error('invalid png header');
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) throw new Error('invalid png header');
      dimensions(u32(bytes, offset + 8), u32(bytes, offset + 12));
      sawHeader = true;
    }
    if (type === 'IDAT') sawImage = true;
    if (!metadata.has(type)) parts.push(bytes.slice(offset, end));
    offset = end;
    if (type === 'IEND') {
      if (length !== 0) throw new Error('invalid png end');
      sawEnd = true;
      break;
    }
  }
  if (!sawHeader || !sawImage || !sawEnd || offset !== bytes.length) throw new Error('invalid png');
  return concat(parts);
}

function le32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}
function sanitizeWebp(bytes: Uint8Array): Uint8Array {
  if (ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP')
    throw new Error('invalid webp');
  if (le32(bytes, 4) + 8 !== bytes.length) throw new Error('invalid webp');
  const chunks: Uint8Array[] = [];
  let offset = 12;
  let sawImage = false;
  let sawCanvas = false;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = le32(bytes, offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (end > bytes.length) throw new Error('invalid webp chunk');
    if (type === 'VP8X' && length < 10) throw new Error('invalid webp canvas');
    if (type === 'VP8X' && length >= 10) {
      if (sawCanvas) throw new Error('invalid webp canvas');
      const chunk = bytes.slice(offset, end);
      chunk[8] = chunk[8]! & ~0x0c;
      dimensions(
        1 + (chunk[12]! | (chunk[13]! << 8) | (chunk[14]! << 16)),
        1 + (chunk[15]! | (chunk[16]! << 8) | (chunk[17]! << 16)),
      );
      chunks.push(chunk);
      sawCanvas = true;
    } else if (type !== 'EXIF' && type !== 'XMP ') {
      chunks.push(bytes.slice(offset, end));
      if (type === 'VP8 ') {
        if (
          length < 10 ||
          bytes[offset + 11] !== 0x9d ||
          bytes[offset + 12] !== 0x01 ||
          bytes[offset + 13] !== 0x2a
        )
          throw new Error('invalid webp image');
        dimensions(
          (bytes[offset + 14]! | (bytes[offset + 15]! << 8)) & 0x3fff,
          (bytes[offset + 16]! | (bytes[offset + 17]! << 8)) & 0x3fff,
        );
        sawImage = true;
      } else if (type === 'VP8L') {
        if (length < 5 || bytes[offset + 8] !== 0x2f) throw new Error('invalid webp image');
        dimensions(
          1 + (bytes[offset + 9]! | ((bytes[offset + 10]! & 0x3f) << 8)),
          1 +
            ((bytes[offset + 10]! >> 6) |
              (bytes[offset + 11]! << 2) |
              ((bytes[offset + 12]! & 0x0f) << 10)),
        );
        sawImage = true;
      } else if (type === 'ANMF') {
        if (!sawCanvas || length < 16) throw new Error('invalid webp frame');
        sawImage = true;
      }
    }
    offset = end;
  }
  if (!sawImage || offset !== bytes.length) throw new Error('invalid webp');
  const payload = concat(chunks);
  const result = new Uint8Array(12 + payload.length);
  result.set(new TextEncoder().encode('RIFF'), 0);
  const size = result.length - 8;
  result[4] = size & 255;
  result[5] = (size >>> 8) & 255;
  result[6] = (size >>> 16) & 255;
  result[7] = (size >>> 24) & 255;
  result.set(new TextEncoder().encode('WEBP'), 8);
  result.set(payload, 12);
  return result;
}
