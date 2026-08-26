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
  kit: [
    /^packages\/kit\//,
    /^\.changeset\//,
    /^docs\/(?:platform-release|testing)\.md$/,
    /^\.github\/workflows\/(?:ci|kit-release|kit-version)\.yml$/,
  ],
  mcp: [
    /^apps\/mcp\//,
    /^packages\/kit\//,
    /^\.changeset\//,
    /^docs\/(?:platform-release|testing)\.md$/,
    /^\.github\/workflows\/(?:ci|mcp-release|kit-version)\.yml$/,
  ],
};

export function domainChanged(domain, files) {
  const rules = RULES[domain];
  if (!rules) throw new Error(`unknown release domain: ${domain}`);
  return files.some((file) => [...SHARED, ...rules].some((pattern) => pattern.test(file)));
}
