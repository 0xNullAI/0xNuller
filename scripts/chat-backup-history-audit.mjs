import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyChatBackupBundle } from './chat-backup-bundle.mjs';

const roomCode = /^[A-Za-z0-9._:-]{1,128}$/;

function roomMap(entries, label) {
  if (!Array.isArray(entries)) throw new Error(`Invalid ${label}`);
  const rooms = new Map();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.code !== 'string' ||
      !roomCode.test(entry.code) ||
      !['group', 'dm'].includes(entry.kind) ||
      (entry.kind === 'dm'
        ? !/^dm:[a-f0-9]{64}$/.test(entry.code)
        : entry.code.startsWith('dm:')) ||
      rooms.has(entry.code)
    )
      throw new Error(`Invalid ${label}`);
    rooms.set(entry.code, entry.kind);
  }
  return rooms;
}

/** Compare an independently assembled historical ledger with an encrypted capture. */
export function auditHistoricalRoomInventory(ledger, captured, filenames) {
  const expected = roomMap(ledger, 'historical room ledger');
  const actual = roomMap(captured, 'captured room index');
  if (!Array.isArray(filenames) || filenames.some((file) => typeof file !== 'string'))
    throw new Error('Invalid captured room files');
  const expectedFiles = new Set(
    [...actual.keys()].map((code) => `${encodeURIComponent(code)}.json`),
  );
  const actualFiles = new Set(filenames);
  const missingFromCapture = [...expected.keys()].filter((code) => !actual.has(code)).length;
  const unexpectedInCapture = [...actual.keys()].filter((code) => !expected.has(code)).length;
  const kindMismatch = [...expected].filter(
    ([code, kind]) => actual.has(code) && actual.get(code) !== kind,
  ).length;
  const missingMessageFiles = [...expectedFiles].filter((file) => !actualFiles.has(file)).length;
  const unexpectedMessageFiles = [...actualFiles].filter((file) => !expectedFiles.has(file)).length;
  return {
    inventoryMatched: !(
      missingFromCapture ||
      unexpectedInCapture ||
      kindMismatch ||
      missingMessageFiles ||
      unexpectedMessageFiles
    ),
    historicalCoverage: 'unverified',
    ledgerRooms: expected.size,
    capturedRooms: actual.size,
    missingFromCapture,
    unexpectedInCapture,
    kindMismatch,
    missingMessageFiles,
    unexpectedMessageFiles,
  };
}

/** Decrypt only into a temporary isolated directory and print counts, never room IDs. */
export async function auditHistoricalRoomBundle(bundle, ledgerPath, passphrase, expectedLedger) {
  const temporary = await mkdtemp(join(tmpdir(), '0xnullai-room-audit-'));
  try {
    const restored = join(temporary, 'chat');
    await verifyChatBackupBundle(bundle, passphrase, restored);
    const ledger = expectedLedger ?? JSON.parse(await readFile(ledgerPath, 'utf8'));
    const index = JSON.parse(await readFile(join(restored, 'room-index.json'), 'utf8'));
    const files = await readdir(join(restored, 'rooms'));
    return auditHistoricalRoomInventory(ledger, index, files);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
