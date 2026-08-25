import { describe, expect, it } from 'vitest';
import { MODULES, moduleIdFromPath } from './routes';

describe('product routes', () => {
  it('keeps the requested main navigation order', () => {
    expect(MODULES.map((module) => module.id)).toEqual([
      'control',
      'chat',
      'agent',
      'voice',
      'video',
      'market',
      'playground',
    ]);
  });

  it('keeps Video independently addressable from the product module registry', () => {
    expect(moduleIdFromPath('/video')).toBe('video');
    expect(MODULES.find((module) => module.id === 'video')).toMatchObject({
      label: 'Video',
      blurb: '摄像头视觉闭环场景',
    });
  });
});
