import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ARCHITECTURE_RULES,
  analyzeImports,
  compareWithBaseline,
  extractModuleSpecifiers,
} from './architecture-policy.mjs';

const root = path.resolve('/repo');

function workspace(relativeDirectory, name, manifest = {}) {
  const layer = relativeDirectory.startsWith('apps/')
    ? 'app'
    : relativeDirectory.startsWith('packages/platform/')
      ? 'platform'
      : relativeDirectory.startsWith('packages/kit/')
        ? 'kit'
        : 'other';
  return {
    directory: path.join(root, relativeDirectory),
    relativeDirectory,
    name,
    manifest: { name, ...manifest },
    layer,
    shell: relativeDirectory === 'apps/web',
    aliases: [],
  };
}

function source(owner, relativeFile, code) {
  return { file: path.join(owner.directory, relativeFile), source: code, workspace: owner };
}

describe('architecture dependency policy', () => {
  it('extracts static, dynamic, require, export, and import-type module specifiers', () => {
    expect(
      extractModuleSpecifiers(`
        import value from 'static-package';
        export type { Value } from 'exported-package';
        const lazy = import('lazy-package');
        const legacy = require('legacy-package');
        type Imported = import('type-package').Imported;
      `),
    ).toEqual([
      'exported-package',
      'lazy-package',
      'legacy-package',
      'static-package',
      'type-package',
    ]);
  });

  it('rejects app-to-app deep imports but permits shell composition', () => {
    const chat = workspace('apps/chat', 'chat');
    const control = workspace('apps/control', 'control');
    const web = workspace('apps/web', 'web', { dependencies: { control: '*' } });
    const workspaces = [chat, control, web];
    const violations = analyzeImports({
      root,
      workspaces,
      sources: [
        source(control, 'src/App.ts', `import '../../chat/src/App';`),
        source(web, 'src/Shell.ts', `import 'control';`),
      ],
    });

    expect(violations.map(({ rule }) => rule)).toEqual([ARCHITECTURE_RULES.APP_TO_APP]);
  });

  it('resolves TypeScript path aliases that point into another app source tree', () => {
    const chat = workspace('apps/chat', 'chat');
    const control = workspace('apps/control', 'control');
    control.aliases = [{ pattern: '@chat/*', target: path.join(chat.directory, 'src/*') }];

    expect(
      analyzeImports({
        root,
        workspaces: [chat, control],
        sources: [source(control, 'src/App.ts', `import '@chat/hooks/use-device';`)],
      }).map(({ rule }) => rule),
    ).toEqual([ARCHITECTURE_RULES.APP_TO_APP]);
  });

  it('rejects platform-to-app and kit-to-product imports', () => {
    const app = workspace('apps/chat', 'chat');
    const platform = workspace('packages/platform/settings', '@product/settings');
    const kit = workspace('packages/kit/core', '@kit/core');
    const violations = analyzeImports({
      root,
      workspaces: [app, platform, kit],
      sources: [
        source(platform, 'src/index.ts', `export * from '../../../../apps/chat/src/lib';`),
        source(kit, 'src/index.ts', `import '../../../platform/settings/src/index';`),
      ],
    });

    expect(violations.map(({ rule }) => rule)).toEqual([
      ARCHITECTURE_RULES.KIT_TO_PRODUCT,
      ARCHITECTURE_RULES.PLATFORM_TO_APP,
    ]);
  });

  it('requires imported workspace packages in a dependency field', () => {
    const app = workspace('apps/control', 'control');
    const shared = workspace('packages/platform/settings', '@product/settings');
    const violations = analyzeImports({
      root,
      workspaces: [app, shared],
      sources: [source(app, 'src/App.ts', `import '@product/settings';`)],
    });
    expect(violations.map(({ rule }) => rule)).toEqual([ARCHITECTURE_RULES.UNDECLARED_WORKSPACE]);

    app.manifest.devDependencies = { '@product/settings': '*' };
    expect(
      analyzeImports({
        root,
        workspaces: [app, shared],
        sources: [source(app, 'src/App.test.ts', `import '@product/settings/testing';`)],
      }),
    ).toEqual([]);
  });

  it('separates baseline debt, new violations, and resolved baseline entries', () => {
    const first = { id: 'first', rule: 'rule', importer: 'a', specifier: 'b', target: 'b' };
    const second = { id: 'second', rule: 'rule', importer: 'c', specifier: 'd', target: 'd' };
    const resolved = { id: 'resolved', rule: 'rule', importer: 'e', specifier: 'f', target: 'f' };

    expect(compareWithBaseline([first, second], [first, resolved])).toEqual({
      existing: [first],
      newViolations: [second],
      resolved: [resolved],
    });
  });
});
