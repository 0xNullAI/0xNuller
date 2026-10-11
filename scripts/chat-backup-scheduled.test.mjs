import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createChatBackupBundle } from './chat-backup-bundle.mjs';
import { runScheduledChatBackup } from './chat-backup-scheduled.mjs';

const passphrase = 'scheduled backup test passphrase';

test('a scheduled run captures once, audits the independent ledger, and stays unverified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheduled-backup-'));
  const ledger = join(root, 'ledger.json');
  await writeFile(ledger, JSON.stringify([{ code: 'room-1', kind: 'group' }]));
  const calls = [];
  const capture = (name) => async (destination) => {
    calls.push(name);
    if (name !== 'chat') {
      await mkdir(destination);
      await writeFile(join(destination, 'encrypted.bin'), name);
      return;
    }
    const source = join(root, 'chat-source');
    await mkdir(join(source, 'rooms'), { recursive: true });
    await writeFile(
      join(source, 'room-index.json'),
      JSON.stringify([{ code: 'room-1', kind: 'group' }]),
    );
    await writeFile(join(source, 'rooms', 'room-1.json'), '[]');
    await createChatBackupBundle(source, destination, passphrase);
  };
  try {
    const result = await runScheduledChatBackup(
      root,
      ledger,
      passphrase,
      { d1: capture('d1'), chat: capture('chat'), authMedia: capture('authMedia') },
      {
        exercise: async () => ({ passed: false, issues: ['historical_room_coverage_unverified'] }),
      },
    );
    expect(calls).toEqual(['d1', 'chat', 'authMedia']);
    expect(result).toMatchObject({
      state: 'captured-unverified',
      batchState: 'captured-unverified',
      recoveryPassed: false,
      ledgerUnchanged: true,
      inventory: { inventoryMatched: true, historicalCoverage: 'unverified' },
    });
    expect(
      JSON.parse(await readFile(join(root, result.runId, 'scheduled-result.json'), 'utf8')),
    ).toEqual(result);
    expect((await lstat(join(root, result.runId, 'scheduled-result.json'))).mode & 0o077).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a scheduled run audits the frozen ledger and reports a ledger changed during capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheduled-backup-ledger-change-'));
  const ledger = join(root, 'ledger.json');
  const initial = [{ code: 'room-1', kind: 'group' }];
  await writeFile(ledger, JSON.stringify(initial));
  let auditedLedger;
  try {
    const result = await runScheduledChatBackup(
      root,
      ledger,
      passphrase,
      {
        d1: async (destination) => {
          await mkdir(destination);
          await writeFile(join(destination, 'encrypted.bin'), 'd1');
        },
        chat: async (destination) => {
          await mkdir(destination);
          await writeFile(join(destination, 'encrypted.bin'), 'chat');
          await writeFile(ledger, JSON.stringify([{ code: 'room-2', kind: 'group' }]));
        },
        authMedia: async (destination) => {
          await mkdir(destination);
          await writeFile(join(destination, 'encrypted.bin'), 'media');
        },
      },
      {
        exercise: async () => ({ passed: false, issues: ['historical_room_coverage_unverified'] }),
        audit: async (_bundle, _ledgerPath, _passphrase, snapshot) => {
          auditedLedger = snapshot;
          return { inventoryMatched: true, historicalCoverage: 'unverified' };
        },
      },
    );
    expect(auditedLedger).toEqual(initial);
    expect(result).toMatchObject({ state: 'ledger-changed', ledgerUnchanged: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a scheduled run reports a mismatched independent room inventory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheduled-backup-inventory-mismatch-'));
  const ledger = join(root, 'ledger.json');
  await writeFile(ledger, JSON.stringify([{ code: 'room-1', kind: 'group' }]));
  try {
    const result = await runScheduledChatBackup(
      root,
      ledger,
      passphrase,
      {
        d1: async (destination) => {
          await mkdir(destination);
          await writeFile(join(destination, 'encrypted.bin'), 'd1');
        },
        chat: async (destination) => {
          await mkdir(destination);
          await writeFile(join(destination, 'encrypted.bin'), 'chat');
        },
        authMedia: async (destination) => {
          await mkdir(destination);
          await writeFile(join(destination, 'encrypted.bin'), 'media');
        },
      },
      {
        exercise: async () => ({ passed: false, issues: ['historical_room_coverage_unverified'] }),
        audit: async () => ({ inventoryMatched: false, historicalCoverage: 'unverified' }),
      },
    );
    expect(result).toMatchObject({ state: 'inventory-mismatch', ledgerUnchanged: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a scheduled run refuses an empty ledger or readable-by-others backup root before capture', async () => {
  const root = await mkdtemp(join(tmpdir(), 'scheduled-backup-denied-'));
  const ledger = join(root, 'ledger.json');
  const captures = {
    d1: async () => {
      throw new Error('must not capture');
    },
    chat: async () => {
      throw new Error('must not capture');
    },
    authMedia: async () => {
      throw new Error('must not capture');
    },
  };
  try {
    await writeFile(ledger, '[]');
    await expect(runScheduledChatBackup(root, ledger, passphrase, captures)).rejects.toThrow(
      'must be nonempty',
    );
    await writeFile(ledger, JSON.stringify([{ code: 'room-1', kind: 'group' }]));
    await chmod(root, 0o755);
    await expect(runScheduledChatBackup(root, ledger, passphrase, captures)).rejects.toThrow(
      'restricted real directory',
    );
    expect((await readFile(ledger, 'utf8')).length).toBeGreaterThan(0);
  } finally {
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});
