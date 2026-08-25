import { describe, expect, it, vi } from 'vitest';
import { switchVideoOutputTarget } from './output-target-selection.js';

describe('switchVideoOutputTarget', () => {
  it('confirms stop before publishing a different exact identity', async () => {
    const order: string[] = [];
    await switchVideoOutputTarget(
      'coyote/one',
      'embedded/device/motor',
      async () => {
        order.push('stop');
      },
      () => order.push('invalidate'),
      (targetId) => order.push(`select:${targetId}`),
    );
    expect(order).toEqual(['stop', 'invalidate', 'select:embedded/device/motor']);
  });

  it('does not change selection when the old target cannot confirm stop', async () => {
    const commit = vi.fn();
    const invalidate = vi.fn();
    await expect(
      switchVideoOutputTarget(
        'coyote/one',
        'coyote/two',
        async () => {
          throw new Error('stop failed');
        },
        invalidate,
        commit,
      ),
    ).rejects.toThrow('stop failed');
    expect(invalidate).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
  });
});
