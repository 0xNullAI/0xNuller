import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']);
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.astro',
  '.tauri',
  '.wrangler',
  'coverage',
  'dist',
  'node_modules',
  'target',
]);

export const ARCHITECTURE_RULES = {
  APP_TO_APP: 'app-to-app',
  KIT_TO_PRODUCT: 'kit-to-product',
  PLATFORM_TO_APP: 'platform-to-app',
  UNDECLARED_WORKSPACE: 'undeclared-workspace-dependency',
};

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function workspaceLayer(relativeDirectory) {
  if (relativeDirectory.startsWith('apps/')) return 'app';
  if (relativeDirectory.startsWith('packages/platform/')) return 'platform';
  if (relativeDirectory.startsWith('packages/agent/')) return 'agent';
  if (relativeDirectory.startsWith('packages/kit/')) return 'kit';
  if (relativeDirectory.startsWith('workers/')) return 'worker';
  if (relativeDirectory === 'android/app') return 'shell';
  return 'other';
}

function visitDirectories(directory, callback) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue;
    const child = path.join(directory, entry.name);
    callback(child);
    visitDirectories(child, callback);
  }
}

function workspaceAliases(directory) {
  const aliases = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^tsconfig(?:\.[^.]+)?\.json$/.test(entry.name)) continue;
    const configPath = path.join(directory, entry.name);
    const parsed = ts.parseConfigFileTextToJson(configPath, readFileSync(configPath, 'utf8'));
    if (parsed.error) continue;
    for (const [pattern, targets] of Object.entries(parsed.config.compilerOptions?.paths ?? {})) {
      for (const target of targets) {
        aliases.push({ pattern, target: path.resolve(directory, target) });
      }
    }
  }
  return aliases;
}

export function discoverWorkspaces(root) {
  const workspaces = [];
  for (const topLevel of ['apps', 'android', 'packages', 'workers']) {
    const directory = path.join(root, topLevel);
    if (!existsSync(directory)) continue;
    visitDirectories(directory, (candidate) => {
      const manifestPath = path.join(candidate, 'package.json');
      if (!existsSync(manifestPath)) return;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const relativeDirectory = toPosix(path.relative(root, candidate));
      workspaces.push({
        directory: candidate,
        relativeDirectory,
        manifest,
        name: manifest.name,
        layer: workspaceLayer(relativeDirectory),
        shell: relativeDirectory === 'apps/web' || relativeDirectory === 'android/app',
        aliases: workspaceAliases(candidate),
      });
    });
  }
  return workspaces.sort((a, b) => a.relativeDirectory.localeCompare(b.relativeDirectory));
}

export function collectWorkspaceSourceFiles(workspace) {
  const files = [];
  const collect = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(child);
      else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(child);
    }
  };
  collect(workspace.directory);
  return files.sort();
}

export function extractModuleSpecifiers(source, fileName = 'source.ts') {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const specifiers = new Set();
  const addStringLiteral = (node) => {
    if (node && ts.isStringLiteralLike(node)) specifiers.add(node.text);
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addStringLiteral(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node)) {
      addStringLiteral(node.argument.literal);
    } else if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      addStringLiteral(node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...specifiers].sort();
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function containingWorkspace(filePath, workspaces) {
  if (!filePath) return undefined;
  return workspaces
    .filter(
      ({ directory }) => filePath === directory || filePath.startsWith(`${directory}${path.sep}`),
    )
    .sort((a, b) => b.directory.length - a.directory.length)[0];
}

function resolveAlias(specifier, aliases = []) {
  for (const alias of aliases) {
    const wildcard = alias.pattern.indexOf('*');
    if (wildcard === -1) {
      if (specifier === alias.pattern) return alias.target;
      continue;
    }
    const prefix = alias.pattern.slice(0, wildcard);
    const suffix = alias.pattern.slice(wildcard + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const matched = specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
    return alias.target.replace('*', matched);
  }
}

function targetWorkspaceForImport({
  importerFile,
  importerWorkspace,
  specifier,
  workspaces,
  workspaceByName,
}) {
  if (specifier.startsWith('.')) {
    return containingWorkspace(path.resolve(path.dirname(importerFile), specifier), workspaces);
  }
  return (
    workspaceByName.get(packageNameFromSpecifier(specifier)) ??
    containingWorkspace(resolveAlias(specifier, importerWorkspace.aliases), workspaces)
  );
}

function declaredDependencies(manifest) {
  return new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]);
}

function violationId({ rule, importer, specifier, target }) {
  return `${rule}|${importer}|${specifier}|${target}`;
}

export function analyzeImports({ root, workspaces, sources }) {
  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const violations = [];
  for (const { file, source, workspace: importerWorkspace } of sources) {
    const importer = toPosix(path.relative(root, file));
    const declarations = declaredDependencies(importerWorkspace.manifest);
    for (const specifier of extractModuleSpecifiers(source, file)) {
      const importedPackage = specifier.startsWith('.')
        ? undefined
        : workspaceByName.get(packageNameFromSpecifier(specifier));
      const targetWorkspace = targetWorkspaceForImport({
        importerFile: file,
        importerWorkspace,
        specifier,
        workspaces,
        workspaceByName,
      });
      if (!targetWorkspace || targetWorkspace === importerWorkspace) continue;

      const target = targetWorkspace.relativeDirectory;
      const found = [];
      if (
        importerWorkspace.layer === 'app' &&
        !importerWorkspace.shell &&
        targetWorkspace.layer === 'app'
      ) {
        found.push(ARCHITECTURE_RULES.APP_TO_APP);
      }
      if (importerWorkspace.layer === 'platform' && targetWorkspace.layer === 'app') {
        found.push(ARCHITECTURE_RULES.PLATFORM_TO_APP);
      }
      if (
        importerWorkspace.layer === 'kit' &&
        (targetWorkspace.layer === 'platform' || targetWorkspace.layer === 'app')
      ) {
        found.push(ARCHITECTURE_RULES.KIT_TO_PRODUCT);
      }
      if (
        importedPackage &&
        targetWorkspace.name !== importerWorkspace.name &&
        !declarations.has(targetWorkspace.name)
      ) {
        found.push(ARCHITECTURE_RULES.UNDECLARED_WORKSPACE);
      }

      for (const rule of found) {
        const violation = { rule, importer, specifier, target };
        violations.push({ ...violation, id: violationId(violation) });
      }
    }
  }
  return violations.sort((a, b) => a.id.localeCompare(b.id));
}

export function analyzeRepository(root) {
  const workspaces = discoverWorkspaces(root);
  const sources = workspaces.flatMap((workspace) =>
    collectWorkspaceSourceFiles(workspace).map((file) => ({
      file,
      source: readFileSync(file, 'utf8'),
      workspace,
    })),
  );
  return analyzeImports({ root, workspaces, sources });
}

export function compareWithBaseline(violations, baselineEntries) {
  const currentById = new Map(violations.map((violation) => [violation.id, violation]));
  const baselineIds = new Set(baselineEntries.map(({ id }) => id));
  return {
    existing: violations.filter(({ id }) => baselineIds.has(id)),
    newViolations: violations.filter(({ id }) => !baselineIds.has(id)),
    resolved: baselineEntries.filter(({ id }) => !currentById.has(id)),
  };
}

export function formatViolation(violation) {
  return `[${violation.rule}] ${violation.importer} imports ${violation.specifier} (${violation.target})`;
}
