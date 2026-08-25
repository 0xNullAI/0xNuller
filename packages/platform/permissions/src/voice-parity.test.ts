import { describe, expect, it } from 'vitest';
import { BrowserPermissionService, TIMED_PERMISSION_WINDOW_MS } from '@0xnullai/permissions';

describe('@0xnullai/permissions public entrypoint', () => {
  it('exports the permission service used by Voice', () => {
    expect(BrowserPermissionService).toBeTypeOf('function');
    expect(TIMED_PERMISSION_WINDOW_MS).toBeGreaterThan(0);
  });
});
