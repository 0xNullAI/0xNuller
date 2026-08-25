import path from 'node:path';

export const TEST_PROJECT_ALIASES = {
  agent: '@dg-agent/web',
  android: 'android',
  auth: 'auth',
  chat: '0xnullai-chat',
  control: 'control',
  kit: 'kit',
  market: 'market',
  mcp: 'dg-mcp',
  platform: 'platform',
  playground: 'playground',
  tooling: 'tooling',
  video: 'video',
  voice: '0xnullai-voice',
  web: 'web',
};

const projectPathRules = [
  ['android/app/', 'android'],
  ['apps/agent/', '@dg-agent/web'],
  ['apps/chat/', '0xnullai-chat'],
  ['apps/control/', 'control'],
  ['apps/market/', 'market'],
  ['apps/mcp/', 'dg-mcp'],
  ['apps/playground/', 'playground'],
  ['apps/video/', 'video'],
  ['apps/voice/', '0xnullai-voice'],
  ['apps/web/', 'web'],
  ['packages/agent/', 'agent-packages'],
  ['packages/kit/', 'kit'],
  ['packages/platform/', 'platform'],
  ['scripts/', 'tooling'],
  ['workers/auth/', 'auth'],
  ['workers/llm-proxy/', 'worker-proxies'],
  ['workers/speech-proxy/', 'worker-proxies'],
];

const relatedFilePattern = /\.(?:[cm]?[jt]sx?|jsonc?)$/i;
const ignoredPathPattern = /(^|\/)(?:dist|node_modules|target|gen|\.wrangler|\.astro)(?:\/|$)/;
const globalTestFiles = new Set(['vitest.config.ts', 'scripts/run-vitest.mjs']);

function normalizePath(file) {
  return file.split(path.sep).join('/').replace(/^\.\//, '');
}

export function selectRelatedFiles(files) {
  return [...new Set(files.map(normalizePath))]
    .filter((file) => relatedFilePattern.test(file) && !ignoredPathPattern.test(file))
    .sort();
}

export function isGlobalTestFile(input) {
  const file = normalizePath(input);
  return (
    globalTestFiles.has(file) ||
    /(^|\/)vitest\.config\.[cm]?[jt]s$/.test(file) ||
    file.startsWith('test/setup/')
  );
}

export function touchesGlobalTestConfig(files) {
  return files.some(isGlobalTestFile);
}

export function resolveTestProjects(inputs) {
  const projects = inputs.map((input) => TEST_PROJECT_ALIASES[input] ?? input);
  return [...new Set(projects)];
}

export function projectsForFiles(files) {
  const projects = files.flatMap((input) => {
    const file = normalizePath(input);
    return projectPathRules
      .filter(([prefix]) => file.startsWith(prefix))
      .map(([, project]) => project);
  });
  return [...new Set(projects)].sort();
}

export function filesNeedingRetest(currentHashes, previousHashes = {}) {
  return Object.keys(currentHashes)
    .filter((file) => currentHashes[file] !== previousHashes[file])
    .sort();
}
