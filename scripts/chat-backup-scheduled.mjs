import { randomUUID } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { captureChatBackupBatch } from './chat-backup-batch.mjs';
import {
  auditHistoricalRoomBundle,
  auditHistoricalRoomInventory,
} from './chat-backup-history-audit.mjs';

/** Known, documented limits that do not make a run fail. */
const ACCEPTED_LIMITATIONS = new Set(['historical_room_coverage_unverified']);

/** Captured, with every runnable check passed; still not a verified backup (exit 3). */
export const SCHEDULED_SUCCESS_STATE = 'captured-unverified';

const safeRunId = (now) => `${now.toISOString().replace(/[-:.]/g, '')}-${randomUUID()}`;

/** A one-shot capture for an external scheduler. An independent ledger is mandatory. */
export async function runScheduledChatBackup(
  backupRoot,
  ledgerPath,
  passphrase,
  captures,
  { now = new Date(), exercise, audit = auditHistoricalRoomBundle } = {},
) {
  const root = resolve(backupRoot);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0)
    throw new Error('Backup root must be a restricted real directory');
  const ledgerStat = await lstat(ledgerPath);
  if (!ledgerStat.isFile() || ledgerStat.isSymbolicLink())
    throw new Error('Historical room ledger must be a regular file');
  const ledgerBytes = await readFile(ledgerPath);
  const ledger = JSON.parse(ledgerBytes.toString('utf8'));
  if (!Array.isArray(ledger) || ledger.length === 0)
    throw new Error('Historical room ledger must be nonempty');
  auditHistoricalRoomInventory(ledger, [], []);

  const runId = safeRunId(now);
  const directory = join(root, runId);
  const batch = await captureChatBackupBatch(directory, passphrase, captures, exercise);
  const inventory = await audit(join(directory, 'chat'), ledgerPath, passphrase, ledger);
  const currentLedger = await readFile(ledgerPath);
  const ledgerUnchanged = currentLedger.equals(ledgerBytes);
  // Historical room coverage cannot be proven yet and is reported on every run; every
  // other recovery issue, or a D1 postflight mismatch, is an integrity failure.
  const blockingIssues = (batch.report.issues ?? []).filter(
    (code) => !ACCEPTED_LIMITATIONS.has(code),
  );
  const integrityPassed =
    blockingIssues.length === 0 && batch.d1Postflight?.state === 'chat-tables-matched';
  const result = {
    format: '0xnullai-chat-backup-scheduled-v1',
    runId,
    state: !ledgerUnchanged
      ? 'ledger-changed'
      : !inventory.inventoryMatched
        ? 'inventory-mismatch'
        : !integrityPassed
          ? 'integrity-failed'
          : 'captured-unverified',
    blockingIssues,
    batchState: batch.state,
    recoveryPassed: batch.report.passed,
    historicalCoverage: 'unverified',
    ledgerUnchanged,
    inventory,
  };
  await writeFile(join(directory, 'scheduled-result.json'), JSON.stringify(result), {
    flag: 'wx',
    mode: 0o600,
  });
  return result;
}
