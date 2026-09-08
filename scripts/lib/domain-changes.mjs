const SHARED = [
  /^package(?:-lock)?\.json$/,
  /^scripts\//,
  /^tsconfig[^/]*\.json$/,
  /^vitest\.config\.ts$/,
];

const RULES = {
  product: [
    /^apps\/(?!mcp(?:\/|$))[^/]+\//,
    /^android\//,
    /^packages\/(?:agent|platform|kit)\//,
    /^workers\//,
    /^brand\//,
    /^docs\/(?:platform-release|android-release|testing)\.md$/,
    /^\.github\/workflows\/(?:ci|product-release|rollback-cloudflare)\.yml$/,
  ],
  // Native installers embed the full Web shell, but Worker-only configuration and
  // backend changes do not alter their bundles. Product version metadata remains
  // shared and deliberately forces fresh release artifacts.
  desktop: [
    /^android\//,
    /^apps\/(?:agent|chat|control|market|playground|video|voice|web)\/(?!wrangler\.jsonc$|worker\/|src\/worker\/)/,
    /^packages\/(?:agent|platform|kit)\//,
    /^brand\//,
    /^docs\/(?:platform-release|android-release|testing)\.md$/,
    /^\.github\/workflows\/ci\.yml$/,
  ],
  kit: [
    /^packages\/kit\//,
    /^\.changeset\//,
    /^docs\/(?:platform-release|testing)\.md$/,
    /^\.github\/workflows\/(?:ci|npm-release|npm-version)\.yml$/,
  ],
  mcp: [
    /^apps\/mcp\//,
    /^packages\/kit\//,
    /^\.changeset\//,
    /^docs\/(?:platform-release|testing)\.md$/,
    /^\.github\/workflows\/(?:ci|npm-release|npm-version)\.yml$/,
  ],
};

export function domainChanged(domain, files) {
  const rules = RULES[domain];
  if (!rules) throw new Error(`unknown release domain: ${domain}`);
  return files.some((file) => [...SHARED, ...rules].some((pattern) => pattern.test(file)));
}
