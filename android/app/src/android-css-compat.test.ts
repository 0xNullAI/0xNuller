import { describe, expect, it } from 'vitest';
import { unwrapCascadeLayers } from '../android-css-compat';

describe('Android CSS compatibility', () => {
  it('preserves layer contents in their resolved output order', async () => {
    const css = await unwrapCascadeLayers(`
      @layer theme, base, shell;
      @layer theme { :root { --surface: white; } }
      @layer base { body { margin: 0; } }
      @layer shell {
        @media (display-mode: standalone) { main { min-height: 100%; } }
      }
    `);

    expect(css).not.toContain('@layer');
    expect(css.indexOf('--surface')).toBeLessThan(css.indexOf('body'));
    expect(css.indexOf('body')).toBeLessThan(css.indexOf('@media'));
    expect(css).toContain('main { min-height: 100%; }');
  });
});
