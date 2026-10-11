import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createChatBackupBundle, verifyChatBackupBundle } from './chat-backup-bundle.mjs';

test('encrypted bundle verifies and restores D1, room, and media exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-backup-test-'));
  try {
    const source = join(root, 'source');
    const backup = join(root, 'backup');
    const recovered = join(root, 'recovered');
    await mkdir(join(source, 'chat', 'rooms'), { recursive: true });
    await mkdir(join(source, 'chat', 'media'), { recursive: true });
    await writeFile(join(source, 'auth-d1.sql'), "INSERT INTO secret VALUES ('private AI chat');");
    await writeFile(join(source, 'chat', 'rooms', 'one.json'), '{"body":"human DM"}');
    await writeFile(join(source, 'chat', 'media', 'empty'), '');
    expect(
      await createChatBackupBundle(source, backup, 'this is a long test-only passphrase'),
    ).toEqual({ files: 3 });
    expect((await readFile(join(backup, 'manifest.enc'))).includes(Buffer.from('one.json'))).toBe(
      false,
    );
    expect(
      (await verifyChatBackupBundle(backup, 'this is a long test-only passphrase')).files,
    ).toBe(3);
    await verifyChatBackupBundle(backup, 'this is a long test-only passphrase', recovered);
    expect(await readFile(join(recovered, 'chat', 'rooms', 'one.json'), 'utf8')).toBe(
      '{"body":"human DM"}',
    );
    await expect(
      verifyChatBackupBundle(backup, 'wrong passphrase that is still long enough'),
    ).rejects.toThrow();
    const blob = join(backup, '00000000.enc');
    const bytes = await readFile(blob);
    bytes[15] ^= 1;
    await writeFile(blob, bytes);
    await expect(
      verifyChatBackupBundle(backup, 'this is a long test-only passphrase'),
    ).rejects.toThrow();
    await expect(
      verifyChatBackupBundle(
        backup,
        'this is a long test-only passphrase',
        join(root, 'bad-restore'),
      ),
    ).rejects.toThrow();
    await expect(readFile(join(root, 'bad-restore', 'auth-d1.sql'))).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('rejects symlinks and destinations nested inside the source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-backup-test-'));
  try {
    await writeFile(join(root, 'data'), 'private');
    await expect(
      createChatBackupBundle(root, join(root, 'backup'), 'this is a long test-only passphrase'),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
