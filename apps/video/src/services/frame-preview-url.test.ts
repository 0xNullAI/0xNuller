// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { FramePreviewUrl } from './frame-preview-url.js';

describe('FramePreviewUrl', () => {
  it('replaces and revokes transient preview URLs without putting image bytes in state', () => {
    const urlApi = {
      createObjectURL: vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second'),
      revokeObjectURL: vi.fn(),
    };
    const preview = new FramePreviewUrl(urlApi);
    const image = document.createElement('img');

    preview.show(new Blob(['first']), image);
    preview.show(new Blob(['second']), image);

    expect(image.src).toContain('blob:second');
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:first');

    preview.clear(image);
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith('blob:second');
    expect(image.hasAttribute('src')).toBe(false);
  });
});
