import { describe, expect, it } from 'vitest';
import { isAllowedMediaType, ALLOWED_MEDIA_TYPES } from './wire';

/**
 * The upload endpoint takes no auth and no room-membership check, and
 * read-back serves the stored bytes inline from the app's own origin — the
 * origin that holds the session cookie. The type check is therefore the
 * boundary between "someone posted a picture" and "someone parked script on
 * our domain".
 *
 * It used to be a `image/` prefix match, which admits `image/svg+xml`.
 */

describe('上传媒体类型白名单', () => {
  it('放行客户端真正会产生的类型', () => {
    // compressImage always re-encodes to JPEG; the recorder picks from these.
    expect(isAllowedMediaType('image/jpeg')).toBe(true);
    expect(isAllowedMediaType('audio/webm')).toBe(true);
    expect(isAllowedMediaType('audio/mp4')).toBe(true);
  });

  it('带参数的录音类型仍然放行', () => {
    expect(isAllowedMediaType('audio/webm;codecs=opus')).toBe(true);
    expect(isAllowedMediaType('audio/webm; codecs=opus')).toBe(true);
  });

  it('拒绝 SVG——它是能带 <script> 的文档，不是图片', () => {
    expect(isAllowedMediaType('image/svg+xml')).toBe(false);
    expect(isAllowedMediaType('IMAGE/SVG+XML')).toBe(false);
    expect(isAllowedMediaType('image/svg+xml;charset=utf-8')).toBe(false);
  });

  it('拒绝会被当成活动内容的类型', () => {
    for (const mime of [
      'text/html',
      'application/xhtml+xml',
      'application/javascript',
      'text/javascript',
      'application/xml',
      'application/pdf',
    ]) {
      expect(isAllowedMediaType(mime), mime).toBe(false);
    }
  });

  it('参数不能用来夹带类型', () => {
    // The bare type is what gets compared, never the whole header.
    expect(isAllowedMediaType('text/html;x=image/jpeg')).toBe(false);
    expect(isAllowedMediaType('image/svg+xml;fallback=image/png')).toBe(false);
  });

  it('缺失或空的 Content-Type 一律拒绝', () => {
    expect(isAllowedMediaType(null)).toBe(false);
    expect(isAllowedMediaType('')).toBe(false);
    expect(isAllowedMediaType('   ')).toBe(false);
  });

  it('白名单里没有任何可执行类型', () => {
    const executable = /svg|html|xml|javascript|ecmascript|pdf/i;
    expect(ALLOWED_MEDIA_TYPES.filter((t) => executable.test(t))).toEqual([]);
  });
});
