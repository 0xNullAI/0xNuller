import { describe, expect, it } from 'vitest';
import { MODULES, moduleIdFromPath } from './routes';

describe('Video route', () => {
  it('is independently addressable from the product module registry', () => {
    expect(moduleIdFromPath('/video')).toBe('video');
    expect(MODULES.find((module) => module.id === 'video')).toMatchObject({
      label: 'Video',
      blurb: '摄像头视觉闭环场景',
    });
  });
});
