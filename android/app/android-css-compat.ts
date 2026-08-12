import postcss from 'postcss';

/**
 * Android 11 devices can still ship WebView 92. CSS cascade layers only became
 * available in Chromium 99; an older WebView discards an entire unsupported
 * `@layer` block, which leaves the React tree rendered but completely unstyled.
 *
 * Tailwind has already serialised the layers in cascade order by this point, so
 * unwrapping them preserves that order while making the CSS usable by the
 * oldest WebView supported by this app.
 */
export async function unwrapCascadeLayers(css: string): Promise<string> {
  const result = await postcss([
    {
      postcssPlugin: 'android-unwrap-cascade-layers',
      AtRule: {
        layer(rule) {
          if (rule.nodes) {
            rule.replaceWith(...rule.nodes);
          } else {
            rule.remove();
          }
        },
      },
    },
  ]).process(css, { from: undefined });

  return result.css;
}
