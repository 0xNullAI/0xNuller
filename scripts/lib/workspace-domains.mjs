export function workspaceDomain(manifestPath) {
  if (manifestPath.startsWith('packages/kit/')) return 'kit';
  if (manifestPath === 'apps/mcp/package.json') return 'mcp';
  if (
    manifestPath.startsWith('apps/') ||
    manifestPath.startsWith('android/') ||
    manifestPath.startsWith('packages/agent/') ||
    manifestPath.startsWith('packages/platform/') ||
    manifestPath.startsWith('workers/')
  ) {
    return 'product';
  }
  return null;
}

export function workspacesForDomain(manifests, domain) {
  return manifests
    .filter(({ path }) => workspaceDomain(path) === domain)
    .filter(({ manifest }) => typeof manifest.name === 'string')
    .sort((left, right) => left.path.localeCompare(right.path));
}
