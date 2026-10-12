import { unzipSync } from 'fflate';
import {
  importExternalCardJson,
  MAX_EXTERNAL_CARD_BYTES,
  type ImportedExternalCard,
} from './character-draft.js';

export const MAX_EXTERNAL_CARD_FILE_BYTES = 20_000_000;
export type ExternalCardContainer = 'json' | 'png' | 'charx';
export interface ImportedCharacterFile extends ImportedExternalCard {
  container: ExternalCardContainer;
  /** Exact source bytes stay in this editor session for a lossless private download. */
  originalFile?: File;
  assetCount: number;
}

const PNG_SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

function uint32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! * 0x1000000 +
      (bytes[offset + 1]! << 16) +
      (bytes[offset + 2]! << 8) +
      bytes[offset + 3]!) >>>
    0
  );
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let value = 0xffffffff;
  for (let offset = start; offset < end; offset++)
    value = CRC_TABLE[(value ^ bytes[offset]!) & 0xff]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function decodeCardBase64(encoded: string): string {
  const compact = encoded.replace(/\s/g, '');
  if (compact.length > Math.ceil(MAX_EXTERNAL_CARD_BYTES / 3) * 4 + 4)
    throw new Error('PNG 内嵌角色 JSON 超过 120 KB');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) throw new Error('PNG 角色数据不是合法 base64');
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    throw new Error('PNG 角色数据不是合法 base64');
  }
  if (binary.length > MAX_EXTERNAL_CARD_BYTES) throw new Error('PNG 内嵌角色 JSON 超过 120 KB');
  try {
    return decoder.decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
  } catch {
    throw new Error('PNG 角色 JSON 不是 UTF-8');
  }
}

const MAX_ASSETS = 100;
const MAX_ASSET_BYTES = 8_000_000;
const MAX_DECOMPRESSED_ASSETS = 20_000_000;

function safeAssetPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 240 &&
    /^[\x21-\x7e]+$/.test(path) &&
    !path.includes('\\') &&
    !path.includes(':') &&
    !path.includes('?') &&
    !path.includes('#') &&
    !path.startsWith('/') &&
    !path.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

function embeddedReferences(raw: Record<string, unknown>): string[] {
  const data = raw.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  const assets = (data as Record<string, unknown>).assets;
  if (!Array.isArray(assets)) return [];
  if (assets.length > MAX_ASSETS) throw new Error('角色资产引用过多');
  const refs: string[] = [];
  for (const asset of assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset))
      throw new Error('角色资产引用格式无效');
    const { uri, ext } = asset as Record<string, unknown>;
    if (typeof uri !== 'string' || typeof ext !== 'string') throw new Error('角色资产引用格式无效');
    if (!uri.startsWith('embeded://') && !uri.startsWith('__asset:')) continue;
    const path = uri.startsWith('embeded://') ? uri.slice(10) : uri.slice(8);
    if (
      !safeAssetPath(path) ||
      !/^[a-z0-9]{1,10}$/i.test(ext) ||
      !path.toLowerCase().endsWith(`.${ext.toLowerCase()}`)
    )
      throw new Error('角色资产路径或扩展名无效');
    refs.push(uri);
  }
  return refs;
}

function assertAssetMime(path: string, bytes: Uint8Array): void {
  const ext = path.split('.').pop()!.toLowerCase();
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  const matches: Record<string, boolean> = {
    png: starts(137, 80, 78, 71, 13, 10, 26, 10),
    jpg: starts(255, 216, 255),
    jpeg: starts(255, 216, 255),
    gif: ascii(0, 4) === 'GIF8',
    webp: ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP',
    avif: ascii(4, 8) === 'ftyp' && ascii(8, 12).startsWith('avif'),
    mp3: starts(73, 68, 51) || starts(255, 251) || starts(255, 243) || starts(255, 242),
    wav: ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE',
    ogg: ascii(0, 4) === 'OggS',
    mp4: ascii(4, 8) === 'ftyp',
    webm: starts(26, 69, 223, 163),
  };
  if (matches[ext] !== true) throw new Error(`角色资产 ${path} 的格式或 MIME 不受支持`);
}

function readPng(bytes: Uint8Array): { json: string; assetCount: number } {
  if (bytes.length > MAX_EXTERNAL_CARD_FILE_BYTES) throw new Error('角色文件超过 20 MB');
  if (bytes.length < 20 || PNG_SIGNATURE.some((value, index) => bytes[index] !== value))
    throw new Error('文件不是合法 PNG/APNG');
  let offset = PNG_SIGNATURE.length;
  let chunks = 0;
  let sawHeader = false;
  let sawImageData = false;
  let sawEnd = false;
  let v2: string | undefined;
  let v3: string | undefined;
  const embedded = new Map<string, string>();
  while (offset + 12 <= bytes.length) {
    if (++chunks > 10_000) throw new Error('PNG 数据块过多');
    const length = uint32(bytes, offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error('PNG 数据块不完整');
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (crc32(bytes, offset + 4, dataEnd) !== uint32(bytes, dataEnd))
      throw new Error('PNG 数据校验失败');
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) throw new Error('PNG 缺少图像头');
      sawHeader = true;
    }
    if (type === 'IDAT') sawImageData = true;
    if (type === 'tEXt') {
      const keywordEnd = bytes.indexOf(0, dataStart);
      if (keywordEnd < dataStart || keywordEnd >= dataEnd || keywordEnd - dataStart > 79)
        throw new Error('PNG 文本块无效');
      const keyword = String.fromCharCode(...bytes.subarray(dataStart, keywordEnd));
      if (keyword === 'ccv3' || keyword === 'chara') {
        if (length > 170_000) throw new Error('PNG 内嵌角色数据超过限制');
        const encoded = new TextDecoder('latin1').decode(bytes.subarray(keywordEnd + 1, dataEnd));
        if (keyword === 'ccv3') {
          if (v3 !== undefined) throw new Error('PNG 有重复的 ccv3 角色数据');
          v3 = encoded;
        } else {
          if (v2 !== undefined) throw new Error('PNG 有重复的 chara 角色数据');
          v2 = encoded;
        }
      } else if (keyword.startsWith('chara-ext-asset_:')) {
        const path = keyword.slice('chara-ext-asset_:'.length);
        if (
          !safeAssetPath(path) ||
          embedded.has(path) ||
          embedded.size >= MAX_ASSETS ||
          length > MAX_ASSET_BYTES * 1.4
        )
          throw new Error('PNG 附属资产路径、数量或大小无效');
        embedded.set(
          path,
          new TextDecoder('latin1').decode(bytes.subarray(keywordEnd + 1, dataEnd)),
        );
      }
    }
    offset = dataEnd + 4;
    if (type === 'IEND') {
      if (length !== 0) throw new Error('PNG 结束块无效');
      sawEnd = true;
      break;
    }
  }
  if (!sawEnd || !sawImageData || offset !== bytes.length) throw new Error('PNG 文件不完整');
  const json =
    v3 !== undefined ? decodeCardBase64(v3) : v2 !== undefined ? decodeCardBase64(v2) : undefined;
  if (json === undefined) throw new Error('PNG 内没有 ccv3 或 chara 角色卡');
  const raw = JSON.parse(json) as Record<string, unknown>;
  const refs = embeddedReferences(raw);
  for (const uri of refs) {
    if (!uri.startsWith('__asset:')) continue;
    const path = uri.slice(8);
    const encoded = embedded.get(path);
    if (encoded === undefined) throw new Error(`PNG 缺少所引用资产：${path}`);
    if (
      encoded.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 + 4 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
    )
      throw new Error('PNG 附属资产编码或大小无效');
    let binary: string;
    try {
      binary = atob(encoded);
    } catch {
      throw new Error('PNG 附属资产不是合法 base64');
    }
    if (binary.length > MAX_ASSET_BYTES) throw new Error('PNG 附属资产超过 8 MB');
    assertAssetMime(
      path,
      Uint8Array.from(binary, (char) => char.charCodeAt(0)),
    );
  }
  return { json, assetCount: embedded.size };
}

/** Read and validate embedded card metadata without exposing the image or its assets. */
export function cardJsonFromPng(bytes: Uint8Array): string {
  return readPng(bytes).json;
}

function cardJsonFromCharx(bytes: Uint8Array): { json: string; assetCount: number } {
  let cardEntries = 0;
  let assetCount = 0;
  let oversized = false;
  let oversizedCard = false;
  let totalSize = 0;
  const names = new Set<string>();
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: (entry) => {
        if (!safeAssetPath(entry.name.replace(/\/$/, '')) || names.has(entry.name))
          throw new Error('CHARX 路径或重复条目无效');
        names.add(entry.name);
        totalSize += entry.originalSize;
        if (totalSize > MAX_DECOMPRESSED_ASSETS || entry.originalSize > MAX_ASSET_BYTES)
          oversized = true;
        if (entry.name === 'card.json') {
          cardEntries += 1;
          if (entry.originalSize > MAX_EXTERNAL_CARD_BYTES) {
            oversizedCard = true;
            oversized = true;
          }
          return !oversized;
        }
        if (!entry.name.endsWith('/')) assetCount += 1;
        if (assetCount > MAX_ASSETS) oversized = true;
        return false;
      },
    });
  } catch {
    throw new Error('CHARX 压缩包无效或无法安全读取');
  }
  if (cardEntries !== 1) throw new Error('CHARX 根目录必须恰有一个 card.json');
  if (oversizedCard) throw new Error('CHARX 的 card.json 超过 120 KB');
  if (oversized) throw new Error('CHARX 附属资产数量或解压大小超过限制');
  if (!entries['card.json'] || entries['card.json'].length > MAX_EXTERNAL_CARD_BYTES)
    throw new Error('CHARX 的 card.json 超过 120 KB');
  try {
    const json = decoder.decode(entries['card.json']);
    const refs = embeddedReferences(JSON.parse(json) as Record<string, unknown>);
    const paths = [
      ...new Set(refs.filter((uri) => uri.startsWith('embeded://')).map((uri) => uri.slice(10))),
    ];
    for (const path of paths)
      if (!names.has(path)) throw new Error(`CHARX 缺少所引用资产：${path}`);
    if (paths.length) {
      const selected = unzipSync(bytes, { filter: (entry) => paths.includes(entry.name) });
      for (const path of paths) {
        const asset = selected[path];
        if (!asset || asset.length > MAX_ASSET_BYTES) throw new Error(`CHARX 资产 ${path} 无效`);
        assertAssetMime(path, asset);
      }
    }
    return { json, assetCount };
  } catch {
    throw new Error('CHARX 的 card.json 或资产引用无效');
  }
}

/** The Worker and editor use one bounded parser before retaining private originals. */
export function validateCharacterContainerBytes(
  bytes: Uint8Array,
  mime: 'image/png' | 'application/zip',
): { format: 'ccv2' | 'ccv3'; assetCount: number } {
  if (bytes.length > MAX_EXTERNAL_CARD_FILE_BYTES) throw new Error('角色文件超过 20 MB');
  const { json, assetCount } = mime === 'image/png' ? readPng(bytes) : cardJsonFromCharx(bytes);
  const imported = importExternalCardJson(json);
  if (mime === 'application/zip' && imported.archive.format !== 'ccv3')
    throw new Error('CHARX 的 card.json 必须是 CCv3 角色卡');
  const refs = embeddedReferences(imported.archive.raw);
  if (mime === 'image/png' && refs.some((uri) => uri.startsWith('embeded://')))
    throw new Error('PNG 卡含 CHARX 资产引用；请导入完整 CHARX');
  if (mime === 'application/zip' && refs.some((uri) => uri.startsWith('__asset:')))
    throw new Error('CHARX 卡含 PNG 内嵌资产引用；请导入对应 PNG');
  return { format: imported.archive.format, assetCount };
}

export async function importExternalCardFile(file: File): Promise<ImportedCharacterFile> {
  if (file.size > MAX_EXTERNAL_CARD_FILE_BYTES)
    throw new Error('角色文件超过 20 MB；请使用较小的角色文件');
  if (
    file.name.length > 120 ||
    file.name.includes('/') ||
    file.name.includes('\\') ||
    [...file.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    throw new Error('角色文件名无效或超过 120 字符');
  const name = file.name.toLowerCase();
  if (name.endsWith('.json')) {
    if (file.type && !['application/json', 'text/json', 'text/plain'].includes(file.type))
      throw new Error('JSON 文件 MIME 类型与扩展名不符');
    if (file.size > MAX_EXTERNAL_CARD_BYTES) throw new Error('角色 JSON 超过 120 KB');
    const imported = importExternalCardJson(await file.text());
    if (
      embeddedReferences(imported.archive.raw).some(
        (uri) => uri.startsWith('embeded://') || uri.startsWith('__asset:'),
      )
    )
      throw new Error('JSON 引用了未附带的本地资产；请导入完整 PNG 或 CHARX');
    return { ...imported, container: 'json', assetCount: 0 };
  }
  if (name.endsWith('.png') || name.endsWith('.apng')) {
    if (file.type && !['image/png', 'image/apng'].includes(file.type))
      throw new Error('PNG 文件 MIME 类型与扩展名不符');
    const { json, assetCount } = readPng(new Uint8Array(await file.arrayBuffer()));
    const imported = importExternalCardJson(json);
    if (embeddedReferences(imported.archive.raw).some((uri) => uri.startsWith('embeded://')))
      throw new Error('PNG 卡含 CHARX 资产引用；请导入完整 CHARX');
    return {
      ...imported,
      container: 'png',
      originalFile: file,
      assetCount,
      warnings: [
        ...imported.warnings,
        'PNG/APNG 原文件可保存到账号私有草稿并原样下载；图片与附属资产不会自动公开',
      ],
    };
  }
  if (name.endsWith('.charx')) {
    if (
      file.type &&
      !['application/zip', 'application/x-zip-compressed', 'application/octet-stream'].includes(
        file.type,
      )
    )
      throw new Error('CHARX 文件 MIME 类型与扩展名不符');
    const { json, assetCount } = cardJsonFromCharx(new Uint8Array(await file.arrayBuffer()));
    const imported = importExternalCardJson(json);
    if (imported.archive.format !== 'ccv3')
      throw new Error('CHARX 的 card.json 必须是 CCv3 角色卡');
    if (embeddedReferences(imported.archive.raw).some((uri) => uri.startsWith('__asset:')))
      throw new Error('CHARX 卡含 PNG 内嵌资产引用；请导入对应 PNG');
    return {
      ...imported,
      container: 'charx',
      originalFile: file,
      assetCount,
      warnings: [
        ...imported.warnings,
        `CHARX 原文件含 ${assetCount} 个附属文件，可保存到账号私有草稿并原样下载；附属资产不会自动公开`,
      ],
    };
  }
  throw new Error('仅支持 CCv2／CCv3 的 JSON、PNG/APNG 或 CHARX 文件');
}
