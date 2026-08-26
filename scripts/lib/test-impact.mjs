import path from 'node:path';

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

// Source composition is intentionally not expressed as npm dependencies. Web is the product
// compositor; the remaining edges mirror tracked architecture debt until shared behavior moves
// out of feature apps. Modeling both keeps affected tests accurate for today's repository.
const implicitWorkspaceDependencies = {
  '@0xnullai/web': [
    '@dg-agent/web',
    '0xnullai-chat',
    '0xnullai-control',
    '0xnullai-market',
    '0xnullai-playground',
    '0xnullai-video',
    '0xnullai-voice',
  ],
  '0xnullai-control': ['0xnullai-chat'],
  '0xnullai-playground': ['0xnullai-chat'],
  '0xnullai-voice': ['0xnullai-chat'],
  '@0xnullai/settings': ['0xnullai-voice'],
};

export const TEST_PROJECTS = [
  '@dg-agent/web',
  'android',
  'auth',
  '0xnullai-chat',
  'control',
  'market',
  'playground',
  'video',
  '0xnullai-voice',
  'web',
  'agent-packages',
  'platform',
  'worker-proxies',
  'kit',
  'dg-mcp',
  'tooling',
];

export const TEST_DOMAINS = ['all', 'repository', 'product', 'kit', 'mcp'];

const fullSuiteFiles = new Set([
  'package.json',
  'package-lock.json',
  'vitest.config.ts',
  'scripts/run-vitest.mjs',
  'scripts/run-affected-tests.mjs',
  'scripts/lib/test-impact.mjs',
]);

function normalizePath(file) {
  return file.split(path.sep).join('/').replace(/^\.\//, '');
}

function projectForWorkspace(workspace) {
  const { dir } = workspace;
  if (dir === 'android/app') return 'android';
  if (dir === 'apps/agent') return '@dg-agent/web';
  if (dir === 'apps/chat') return '0xnullai-chat';
  if (dir === 'apps/control') return 'control';
  if (dir === 'apps/market') return 'market';
  if (dir === 'apps/mcp') return 'dg-mcp';
  if (dir === 'apps/playground') return 'playground';
  if (dir === 'apps/video') return 'video';
  if (dir === 'apps/voice') return '0xnullai-voice';
  if (dir === 'apps/web') return 'web';
  if (dir === 'workers/auth') return 'auth';
  if (dir === 'workers/llm-proxy' || dir === 'workers/speech-proxy') return 'worker-proxies';
  if (dir.startsWith('packages/agent/')) return 'agent-packages';
  if (dir.startsWith('packages/kit/')) return 'kit';
  if (dir.startsWith('packages/platform/')) return 'platform';
  return null;
}

export function projectDomain(project) {
  if (project === 'tooling') return 'repository';
  if (project === 'kit') return 'kit';
  if (project === 'dg-mcp') return 'mcp';
  return 'product';
}

export function projectsForDomain(domain, projects = TEST_PROJECTS) {
  if (domain === 'all') return [...projects];
  return projects.filter((project) => projectDomain(project) === domain);
}

export function workspaceForFile(input, workspaces) {
  const file = normalizePath(input);
  return [...workspaces]
    .sort((left, right) => right.dir.length - left.dir.length)
    .find(({ dir }) => file === `${dir}/package.json` || file.startsWith(`${dir}/`));
}

export function buildReverseDependencyGraph(workspaces) {
  const names = new Set(workspaces.map(({ name }) => name));
  const reverse = new Map(workspaces.map(({ name }) => [name, new Set()]));

  for (const workspace of workspaces) {
    const dependencies = new Set(implicitWorkspaceDependencies[workspace.name] ?? []);
    for (const field of dependencyFields) {
      for (const dependency of Object.keys(workspace.manifest[field] ?? {}))
        dependencies.add(dependency);
    }
    for (const dependency of dependencies)
      if (names.has(dependency)) reverse.get(dependency).add(workspace.name);
  }
  return reverse;
}

export function reverseDependencyClosure(seedNames, reverseGraph) {
  const affected = new Set(seedNames);
  const queue = [...seedNames];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dependent of reverseGraph.get(current) ?? []) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }
  return affected;
}

function isDocumentationOnly(file) {
  return (
    file.startsWith('docs/') ||
    file.startsWith('.changeset/') ||
    file === 'README.md' ||
    /(^|\/)README(?:\.[^/]+)?\.md$/i.test(file)
  );
}

function isRepositoryTooling(file) {
  return file.startsWith('scripts/') && !fullSuiteFiles.has(file);
}

function requiresFullSuite(file) {
  return (
    fullSuiteFiles.has(file) ||
    file.startsWith('test/setup/') ||
    /(^|\/)vitest\.config\.[cm]?[jt]s$/.test(file) ||
    /^tsconfig(?:\.[^/]+)?\.json$/.test(file)
  );
}

export function planAffectedTests(files, workspaces, { domain = 'all' } = {}) {
  const normalized = [...new Set(files.map(normalizePath))].sort();
  const requestedProjects = projectsForDomain(domain);
  if (normalized.some(requiresFullSuite)) {
    return {
      kind: 'full',
      projects: requestedProjects,
      reason: 'shared test, dependency, or TypeScript configuration changed',
    };
  }

  const seeds = new Set();
  let toolingChanged = false;
  const unknownRuntimeFiles = [];
  for (const file of normalized) {
    const workspace = workspaceForFile(file, workspaces);
    if (workspace) {
      seeds.add(workspace.name);
      continue;
    }
    if (isRepositoryTooling(file)) {
      toolingChanged = true;
      continue;
    }
    if (
      isDocumentationOnly(file) ||
      file.startsWith('.github/') ||
      file.startsWith('.vscode/') ||
      file === '.gitignore' ||
      file === '.prettierignore' ||
      file === '.prettierrc'
    ) {
      continue;
    }
    unknownRuntimeFiles.push(file);
  }

  if (unknownRuntimeFiles.length > 0) {
    return {
      kind: 'full',
      projects: requestedProjects,
      reason: `unmapped runtime file: ${unknownRuntimeFiles[0]}`,
    };
  }

  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const closure = reverseDependencyClosure(seeds, buildReverseDependencyGraph(workspaces));
  const projects = new Set(toolingChanged ? ['tooling'] : []);
  for (const name of closure) {
    const workspace = byName.get(name);
    const project = workspace ? projectForWorkspace(workspace) : null;
    if (project) projects.add(project);
  }

  return {
    kind: 'affected',
    projects: [...projects]
      .filter((project) => domain === 'all' || projectDomain(project) === domain)
      .sort(),
    workspaces: [...closure].sort(),
    reason:
      seeds.size > 0
        ? 'workspace reverse-dependency closure'
        : toolingChanged
          ? 'repository tooling change'
          : 'no test-bearing change',
  };
}
