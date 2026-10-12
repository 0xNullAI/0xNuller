import { strToU8, zipSync, zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { cardJsonFromPng, importExternalCardFile } from './external-card-container.js';

const v2 = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: { name: '旧角色', description: '住在海边', extensions: { custom: true } },
};
const v3 = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '新角色',
    description: '经营书屋',
    assets: [
      { type: 'icon', name: 'main', uri: 'embeded://assets/icon/images/main.png', ext: 'png' },
    ],
  },
};
const pngV3 = {
  ...v3,
  data: {
    ...v3.data,
    assets: [{ type: 'icon', name: 'main', uri: '__asset:main.png', ext: 'png' }],
  },
};
const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

function crc32(bytes: Uint8Array): number {
  let result = 0xffffffff;
  for (const byte of bytes) {
    result ^= byte;
    for (let bit = 0; bit < 8; bit++)
      result = result & 1 ? (result >>> 1) ^ 0xedb88320 : result >>> 1;
  }
  return (result ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, data.length);
  const body = join(strToU8(type), data);
  const checksum = new Uint8Array(4);
  new DataView(checksum.buffer).setUint32(0, crc32(body));
  return join(header, body, checksum);
}

function png(...cards: Array<[string, unknown]>): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return join(
    signature,
    chunk('IHDR', ihdr),
    ...cards.map(([keyword, card]) => {
      const binary = Array.from(strToU8(JSON.stringify(card)), (byte) =>
        String.fromCharCode(byte),
      ).join('');
      return chunk('tEXt', strToU8(`${keyword}\0${btoa(binary)}`));
    }),
    chunk('IDAT', zlibSync(new Uint8Array([0, 255, 0, 0, 255]))),
    chunk('IEND', new Uint8Array()),
  );
}

function file(bytes: Uint8Array, name: string): File {
  return new File([bytes.slice().buffer], name);
}

describe('external character file import', () => {
  it('prefers the CCv3 chunk over a V2 fallback in PNG and keeps the portrait out of published data', async () => {
    const asset = png();
    const image = join(
      signature,
      chunk('IHDR', png(['ccv3', pngV3]).subarray(16, 29)),
      chunk('tEXt', strToU8(`chara\0${base64(strToU8(JSON.stringify(v2)))}`)),
      chunk('tEXt', strToU8(`ccv3\0${base64(strToU8(JSON.stringify(pngV3)))}`)),
      chunk('tEXt', strToU8(`chara-ext-asset_:main.png\0${base64(asset)}`)),
      chunk('IDAT', zlibSync(new Uint8Array([0, 255, 0, 0, 255]))),
      chunk('IEND', new Uint8Array()),
    );
    const result = await importExternalCardFile(file(image, 'character.png'));
    expect(result.container).toBe('png');
    expect(result.name).toBe('新角色');
    expect(result.archive.raw).toEqual(pngV3);
    expect(result.assetCount).toBe(1);
    expect(result.originalFile).toBeInstanceOf(File);
    expect(new Uint8Array(await result.originalFile!.arrayBuffer())).toEqual(image);
    expect(result.warnings.join(' ')).toContain('账号私有草稿');
    expect(JSON.stringify(result.archive.raw)).not.toContain('旧角色');
  });

  it('imports V2 from the legacy chara PNG chunk and rejects corrupt or ambiguous chunks', async () => {
    const image = png(['chara', v2]);
    expect((await importExternalCardFile(file(image, 'old.apng'))).archive.format).toBe('ccv2');
    const corrupted = image.slice();
    corrupted[corrupted.length - 5] = (corrupted[corrupted.length - 5] ?? 0) ^ 1;
    expect(() => cardJsonFromPng(corrupted)).toThrow('校验失败');
    expect(() => cardJsonFromPng(png(['ccv3', v3], ['ccv3', v3]))).toThrow('重复');
    expect(() => cardJsonFromPng(png())).toThrow('没有 ccv3 或 chara');
  });

  it('reads only root card.json from CHARX and reports omitted assets', async () => {
    const archive = zipSync({
      'card.json': strToU8(JSON.stringify(v3)),
      'assets/icon/images/main.png': png(),
    });
    const result = await importExternalCardFile(file(archive, 'book.charx'));
    expect(result.container).toBe('charx');
    expect(result.name).toBe('新角色');
    expect(result.assetCount).toBe(1);
    expect(new Uint8Array(await result.originalFile!.arrayBuffer())).toEqual(archive);
    expect(result.warnings.join(' ')).toContain('1 个附属文件');
    expect(result.archive.raw).toEqual(v3);
    await expect(
      importExternalCardFile(
        file(zipSync({ 'nested/card.json': strToU8(JSON.stringify(v3)) }), 'bad.charx'),
      ),
    ).rejects.toThrow('根目录');
    await expect(
      importExternalCardFile(
        file(zipSync({ 'card.json': strToU8(JSON.stringify(v2)) }), 'v2.charx'),
      ),
    ).rejects.toThrow('CCv3');
    await expect(
      importExternalCardFile(
        file(
          zipSync({
            'card.json': strToU8('x'.repeat(120_001)),
          }),
          'oversized.charx',
        ),
      ),
    ).rejects.toThrow('120 KB');
  });

  it('rejects missing, unsafe, and mismatched embedded assets while retaining unknown JSON fields', async () => {
    const valid = { ...v3, data: { ...v3.data, extensions: { 'vendor/future': { keep: true } } } };
    const parsed = await importExternalCardFile(
      file(
        zipSync({
          'card.json': strToU8(JSON.stringify(valid)),
          'assets/icon/images/main.png': png(),
        }),
        'valid.charx',
      ),
    );
    expect(parsed.archive.raw).toEqual(valid);
    await expect(
      importExternalCardFile(
        file(
          zipSync({
            'card.json': strToU8(JSON.stringify(v3)),
          }),
          'missing.charx',
        ),
      ),
    ).rejects.toThrow('资产引用无效');
    await expect(
      importExternalCardFile(
        file(
          zipSync({
            'card.json': strToU8(JSON.stringify(v3)),
            'assets/icon/images/main.png': strToU8('<svg/>'),
          }),
          'mime.charx',
        ),
      ),
    ).rejects.toThrow('资产引用无效');
    const traversal = {
      ...v3,
      data: {
        ...v3.data,
        assets: [{ type: 'icon', name: 'main', uri: 'embeded://../secret.png', ext: 'png' }],
      },
    };
    await expect(
      importExternalCardFile(
        file(
          zipSync({
            'card.json': strToU8(JSON.stringify(traversal)),
          }),
          'path.charx',
        ),
      ),
    ).rejects.toThrow('资产引用无效');
  });

  it('applies size and format limits before reading contents', async () => {
    await expect(
      importExternalCardFile({ name: 'huge.png', size: 20_000_001 } as File),
    ).rejects.toThrow('20 MB');
    await expect(
      importExternalCardFile(file(strToU8(JSON.stringify(v2)), 'card.json')),
    ).resolves.toMatchObject({ container: 'json', name: '旧角色' });
    await expect(importExternalCardFile(file(strToU8('hello'), 'card.txt'))).rejects.toThrow(
      '仅支持',
    );
    await expect(
      importExternalCardFile(
        new File([strToU8(JSON.stringify(v2))], 'card.json', {
          type: 'image/png',
        }),
      ),
    ).rejects.toThrow('MIME');
    const invalidBase64 = join(
      signature,
      chunk('IHDR', new Uint8Array(13)),
      chunk('tEXt', strToU8('ccv3\0not-base64!')),
      chunk('IDAT', zlibSync(new Uint8Array([0, 255, 0, 0, 255]))),
      chunk('IEND', new Uint8Array()),
    );
    expect(() => cardJsonFromPng(invalidBase64)).toThrow('base64');
  });
});
