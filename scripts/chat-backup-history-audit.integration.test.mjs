import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createChatBackupBundle } from './chat-backup-bundle.mjs';
import {
  auditHistoricalRoomBundle,
  auditHistoricalRoomInventory,
} from './chat-backup-history-audit.mjs';

const passphrase = 'independent historical inventory test passphrase';

test('historical inventory audit compares room identities, kinds and message files without leaking IDs', () => {
  const report = auditHistoricalRoomInventory(
    [
      { code: 'old-group', kind: 'group' },
      { code: `dm:${'a'.repeat(64)}`, kind: 'dm' },
    ],
    [
      { code: 'old-group', kind: 'group' },
      { code: 'new-group', kind: 'group' },
    ],
    ['old-group.json'],
  );
  expect(report).toMatchObject({
    inventoryMatched: false,
    historicalCoverage: 'unverified',
    ledgerRooms: 2,
    capturedRooms: 2,
    missingFromCapture: 1,
    unexpectedInCapture: 1,
    kindMismatch: 0,
    missingMessageFiles: 1,
  });
  expect(JSON.stringify(report)).not.toContain('old-group');
});

test('historical audit decrypts a bundle but does not certify historical coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'history-audit-test-'));
  const source = join(root, 'source');
  const bundle = join(root, 'bundle');
  const ledger = join(root, 'independent-ledger.json');
  try {
    await mkdir(join(source, 'rooms'), { recursive: true });
    await writeFile(
      join(source, 'room-index.json'),
      JSON.stringify([{ code: 'room-1', kind: 'group' }]),
    );
    await writeFile(join(source, 'rooms', 'room-1.json'), '[]');
    await writeFile(ledger, JSON.stringify([{ code: 'room-1', kind: 'group' }]));
    await createChatBackupBundle(source, bundle, passphrase);
    expect(await auditHistoricalRoomBundle(bundle, ledger, passphrase)).toMatchObject({
      inventoryMatched: true,
      historicalCoverage: 'unverified',
      ledgerRooms: 1,
      capturedRooms: 1,
    });
    await writeFile(ledger, JSON.stringify([{ code: 'room-2', kind: 'group' }]));
    expect(
      await auditHistoricalRoomBundle(bundle, ledger, passphrase, [
        { code: 'room-1', kind: 'group' },
      ]),
    ).toMatchObject({ inventoryMatched: true, ledgerRooms: 1 });
    expect(await auditHistoricalRoomBundle(bundle, ledger, passphrase)).toMatchObject({
      inventoryMatched: false,
      ledgerRooms: 1,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('historical audit rejects duplicate or malformed ledger entries', () => {
  expect(() =>
    auditHistoricalRoomInventory(
      [
        { code: 'room-1', kind: 'group' },
        { code: 'room-1', kind: 'group' },
      ],
      [],
      [],
    ),
  ).toThrow('Invalid historical room ledger');
  expect(() => auditHistoricalRoomInventory([{ code: 'dm:wrong', kind: 'dm' }], [], [])).toThrow(
    'Invalid historical room ledger',
  );
  expect(() => auditHistoricalRoomInventory([], [{ code: 'room-1', kind: 'dm' }], [])).toThrow(
    'Invalid captured room index',
  );
});
