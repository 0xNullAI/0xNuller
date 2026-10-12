import { describe, expect, it } from 'vitest';

import { pendingChangesetFiles, verifyChangesetsConsumed } from './verify-changesets-consumed.mjs';

describe('verify changesets consumed', () => {
  it('ignores the maintained README', () => {
    expect(pendingChangesetFiles(['README.md'])).toEqual([]);
    expect(verifyChangesetsConsumed(['README.md'])).toContain('no pending');
  });

  it('reports every pending release note in stable order', () => {
    const entries = ['zebra.md', 'README.md', 'alpha.md', 'config.json'];

    expect(pendingChangesetFiles(entries)).toEqual(['alpha.md', 'zebra.md']);
    expect(() => verifyChangesetsConsumed(entries)).toThrow(
      '.changeset/alpha.md\n- .changeset/zebra.md',
    );
  });
});
