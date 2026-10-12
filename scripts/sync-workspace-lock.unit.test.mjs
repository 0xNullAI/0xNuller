import { describe, expect, it } from 'vitest';

import { syncWorkspaceLock } from './sync-workspace-lock.mjs';

describe('sync workspace lock', () => {
  it('updates workspace versions and dependency metadata without touching registry packages', () => {
    const lock = {
      name: 'old-root',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': {
          name: 'old-root',
          version: '1.0.0',
          dependencies: { workspace: '1.0.0' },
        },
        workspace: {
          name: 'workspace',
          version: '1.0.0',
          dependencies: { dependency: '^1.0.0' },
          devDependencies: { obsolete: '^1.0.0' },
        },
        'node_modules/dependency': {
          version: '1.5.0',
          resolved: 'https://registry.example/dependency.tgz',
        },
      },
    };
    const manifests = new Map([
      [
        '',
        {
          name: 'root',
          version: '2.0.0',
          private: true,
          dependencies: { workspace: '2.0.0' },
        },
      ],
      [
        'workspace',
        {
          name: 'workspace',
          version: '2.0.0',
          dependencies: { dependency: '^2.0.0' },
        },
      ],
    ]);

    const synced = syncWorkspaceLock(lock, manifests);

    expect(synced).toMatchObject({
      name: 'root',
      version: '2.0.0',
      packages: {
        '': { name: 'root', version: '2.0.0', dependencies: { workspace: '2.0.0' } },
        workspace: {
          name: 'workspace',
          version: '2.0.0',
          dependencies: { dependency: '^2.0.0' },
        },
        'node_modules/dependency': {
          version: '1.5.0',
          resolved: 'https://registry.example/dependency.tgz',
        },
      },
    });
    expect(synced.packages.workspace).not.toHaveProperty('devDependencies');
    expect(lock.packages.workspace.version).toBe('1.0.0');
  });

  it('rejects a manifest missing from the lockfile', () => {
    expect(() =>
      syncWorkspaceLock(
        { packages: { '': {} } },
        new Map([['missing', { name: 'missing', version: '1.0.0' }]]),
      ),
    ).toThrow('missing workspace missing');
  });
});
