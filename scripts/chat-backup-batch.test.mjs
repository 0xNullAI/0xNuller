import { expect, test } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureChatBackupBatch, verifyChatBackupBatch } from './chat-backup-batch.mjs';

test('captures all three components in one reserved batch and keeps unverified coverage explicit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-batch-test-'));
  const destination = join(root, 'batch');
  const calls = [];
  const capture = (name) => async (path) => {
    calls.push(name);
    await mkdir(path);
    await writeFile(join(path, 'encrypted.bin'), name);
  };
  const exercise = async (d1, chat, authMedia, passphrase) => {
    for (const path of [d1, chat, authMedia]) expect((await stat(path)).isDirectory()).toBe(true);
    expect(passphrase).toBe('test-only-long-backup-passphrase');
    return { passed: false, issues: ['historical_room_coverage_unverified'], rooms: 1 };
  };
  try {
    const captured = await captureChatBackupBatch(
      destination,
      'test-only-long-backup-passphrase',
      {
        d1: capture('d1'),
        chat: capture('chat'),
        authMedia: capture('authMedia'),
      },
      exercise,
    );
    expect(calls).toEqual(['d1', 'chat', 'authMedia']);
    expect(captured.state).toBe('captured-unverified');
    expect(
      await verifyChatBackupBatch(destination, 'test-only-long-backup-passphrase', exercise),
    ).toMatchObject({ state: 'captured-unverified', report: captured.report });
    await expect(
      captureChatBackupBatch(
        destination,
        'test-only-long-backup-passphrase',
        {
          d1: capture('d1'),
          chat: capture('chat'),
          authMedia: capture('authMedia'),
        },
        exercise,
      ),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed capture remains marked incomplete and cannot be verified as a backup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-batch-failure-'));
  const destination = join(root, 'batch');
  try {
    await expect(
      captureChatBackupBatch(destination, 'test-only-long-backup-passphrase', {
        d1: async () => {
          throw new Error('source changed');
        },
        chat: async () => {
          throw new Error('must not run');
        },
        authMedia: async () => {
          throw new Error('must not run');
        },
      }),
    ).rejects.toThrow('source changed');
    expect(JSON.parse(await readFile(join(destination, 'batch-state.json'), 'utf8')).state).toBe(
      'capturing',
    );
    await expect(
      verifyChatBackupBatch(destination, 'test-only-long-backup-passphrase'),
    ).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('postflight D1 disagreement leaves the batch incomplete before recovery exercise', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-batch-postflight-'));
  const destination = join(root, 'batch');
  const capture = async (path) => {
    await mkdir(path);
    await writeFile(join(path, 'encrypted.bin'), 'ciphertext');
  };
  try {
    await expect(
      captureChatBackupBatch(
        destination,
        'test-only-long-backup-passphrase',
        {
          d1: capture,
          chat: capture,
          authMedia: capture,
          d1Postflight: async (first) => {
            expect(first).toBe(join(destination, 'auth-d1'));
            throw new Error('Auth chat state changed during backup capture');
          },
        },
        async () => {
          throw new Error('exercise must not run');
        },
      ),
    ).rejects.toThrow('Auth chat state changed during backup capture');
    await expect(
      verifyChatBackupBatch(destination, 'test-only-long-backup-passphrase'),
    ).rejects.toThrow('incomplete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a passed exercise is not verified when Auth D1 postflight was not run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-batch-no-postflight-'));
  const capture = async (path) => {
    await mkdir(path);
    await writeFile(join(path, 'encrypted.bin'), 'ciphertext');
  };
  try {
    const result = await captureChatBackupBatch(
      join(root, 'batch'),
      'test-only-long-backup-passphrase',
      { d1: capture, chat: capture, authMedia: capture },
      async () => ({ passed: true, issues: [] }),
    );
    expect(result).toMatchObject({
      state: 'captured-unverified',
      d1Postflight: { state: 'not-run' },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a matched Auth D1 postflight is retained across batch verification', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-batch-matched-postflight-'));
  const capture = async (path) => {
    await mkdir(path);
    await writeFile(join(path, 'encrypted.bin'), 'ciphertext');
  };
  const exercise = async () => ({ passed: true, issues: [] });
  try {
    const destination = join(root, 'batch');
    const result = await captureChatBackupBatch(
      destination,
      'test-only-long-backup-passphrase',
      {
        d1: capture,
        chat: capture,
        authMedia: capture,
        d1Postflight: async () => ({ state: 'chat-tables-matched', tables: 9 }),
      },
      exercise,
    );
    expect(result).toMatchObject({
      state: 'verified',
      d1Postflight: { state: 'chat-tables-matched', tables: 9 },
    });
    await expect(
      verifyChatBackupBatch(destination, 'test-only-long-backup-passphrase', exercise),
    ).resolves.toMatchObject({ state: 'verified', d1Postflight: result.d1Postflight });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verification rejects a changed recovery report', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-batch-tamper-'));
  const destination = join(root, 'batch');
  const capture = async (path) => {
    await mkdir(path);
    await writeFile(join(path, 'encrypted.bin'), 'same-count-content');
  };
  const exercise = async () => ({ passed: true, issues: [], rooms: 1 });
  try {
    await captureChatBackupBatch(
      destination,
      'test-only-long-backup-passphrase',
      {
        d1: capture,
        chat: capture,
        authMedia: capture,
      },
      exercise,
    );
    const path = join(destination, 'batch-result.json');
    const result = JSON.parse(await readFile(path, 'utf8'));
    result.report.rooms = 2;
    await writeFile(path, JSON.stringify(result));
    await expect(
      verifyChatBackupBatch(destination, 'test-only-long-backup-passphrase', exercise),
    ).rejects.toThrow('recovery report changed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verification rejects a replaced component even when the recovery report is unchanged', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-batch-component-swap-'));
  const destination = join(root, 'batch');
  const capture = async (path) => {
    await mkdir(path);
    await writeFile(join(path, 'encrypted.bin'), 'original');
  };
  const exercise = async () => ({
    passed: false,
    issues: ['historical_room_coverage_unverified'],
    rooms: 1,
  });
  try {
    await captureChatBackupBatch(
      destination,
      'test-only-long-backup-passphrase',
      {
        d1: capture,
        chat: capture,
        authMedia: capture,
      },
      exercise,
    );
    await writeFile(join(destination, 'chat', 'encrypted.bin'), 'swapped!');
    await expect(
      verifyChatBackupBatch(destination, 'test-only-long-backup-passphrase', exercise),
    ).rejects.toThrow('component changed');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('capture remains incomplete if an exercise changes a component after its first fingerprint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'chat-batch-exercise-mutation-'));
  const destination = join(root, 'batch');
  const capture = async (path) => {
    await mkdir(path);
    await writeFile(join(path, 'encrypted.bin'), 'original');
  };
  try {
    await expect(
      captureChatBackupBatch(
        destination,
        'test-only-long-backup-passphrase',
        {
          d1: capture,
          chat: capture,
          authMedia: capture,
        },
        async (_d1, chat) => {
          await writeFile(join(chat, 'encrypted.bin'), 'changed!');
          return { passed: true, issues: [] };
        },
      ),
    ).rejects.toThrow('component changed during exercise');
    await expect(
      verifyChatBackupBatch(destination, 'test-only-long-backup-passphrase'),
    ).rejects.toThrow('Backup batch is incomplete');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
