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
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) throw new Error('invalid jpeg segment');
    const marker = bytes[offset + 1]!;
    if (marker === 0xda) {
      parts.push(bytes.slice(offset));
      break;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + length + 2 > bytes.length) throw new Error('invalid jpeg segment');
    const end = offset + length + 2;
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
  if (!sawSize || parts.length < 2) throw new Error('invalid jpeg');
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

function sanitizePng(bytes: Uint8Array): Uint8Array {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, i) => bytes[i] === value)) throw new Error('invalid png');
  const parts = [bytes.slice(0, 8)];
  const metadata = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  let offset = 8;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = u32(bytes, offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error('invalid png chunk');
    const type = ascii(bytes, offset + 4, 4);
    if (type === 'IHDR') dimensions(u32(bytes, offset + 8), u32(bytes, offset + 12));
    if (!metadata.has(type)) parts.push(bytes.slice(offset, end));
    offset = end;
    if (type === 'IEND') {
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd) throw new Error('invalid png');
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
  const chunks: Uint8Array[] = [];
  let offset = 12;
  let sawImage = false;
  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = le32(bytes, offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (end > bytes.length) throw new Error('invalid webp chunk');
    if (type === 'VP8X' && length >= 10) {
      const chunk = bytes.slice(offset, end);
      chunk[8] = chunk[8]! & ~0x0c;
      dimensions(
        1 + (chunk[12]! | (chunk[13]! << 8) | (chunk[14]! << 16)),
        1 + (chunk[15]! | (chunk[16]! << 8) | (chunk[17]! << 16)),
      );
      chunks.push(chunk);
      sawImage = true;
    } else if (type !== 'EXIF' && type !== 'XMP ') {
      chunks.push(bytes.slice(offset, end));
      if (type === 'VP8 ' || type === 'VP8L') sawImage = true;
    }
    offset = end;
  }
  if (!sawImage) throw new Error('invalid webp');
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
