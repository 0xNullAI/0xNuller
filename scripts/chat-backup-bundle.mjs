import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  open,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform, Writable } from 'node:stream';

const scrypt = promisify(scryptCallback);
const FORMAT = '0xnullai-chat-backup-v1';
const MAX_MANIFEST = 16 * 1024 * 1024;

function safePath(path) {
  if (
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    path.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new Error('Unsafe backup path');
  return path;
}

async function listFiles(root, folder = root) {
  const files = [];
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const full = join(folder, entry.name);
    if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))
      throw new Error('Backup source must contain only ordinary files and directories');
    if (entry.isDirectory()) files.push(...(await listFiles(root, full)));
    else files.push(safePath(relative(root, full).split(sep).join('/')));
  }
  return files.sort();
}

async function deriveKey(passphrase, salt) {
  if (typeof passphrase !== 'string' || passphrase.length < 20)
    throw new Error('A backup passphrase of at least 20 characters is required');
  return scrypt(passphrase, salt, 32);
}

function hashingStream(hash, counter) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk);
      counter.bytes += chunk.length;
      callback(null, chunk);
    },
  });
}

async function sealFile(source, target, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const hash = createHash('sha256');
  const counter = { bytes: 0 };
  const output = createWriteStream(target, { flags: 'wx', mode: 0o600 });
  output.write(iv);
  await pipeline(createReadStream(source), hashingStream(hash, counter), cipher, output);
  const tag = cipher.getAuthTag();
  const { appendFile } = await import('node:fs/promises');
  await appendFile(target, tag);
  return { bytes: counter.bytes, sha256: hash.digest('hex') };
}

async function openFile(source, target, key, expected) {
  const size = (await stat(source)).size;
  if (size < 28) throw new Error('Truncated encrypted backup file');
  const handle = await open(source, 'r');
  const iv = Buffer.alloc(12);
  const tag = Buffer.alloc(16);
  try {
    await handle.read(iv, 0, 12, 0);
    await handle.read(tag, 0, 16, size - 16);
  } finally {
    await handle.close();
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const hash = createHash('sha256');
  const counter = { bytes: 0 };
  if (target) await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const partial = target ? `${target}.partial` : null;
  try {
    await pipeline(
      size === 28 ? Readable.from([]) : createReadStream(source, { start: 12, end: size - 17 }),
      decipher,
      hashingStream(hash, counter),
      partial
        ? createWriteStream(partial, { flags: 'wx', mode: 0o600 })
        : new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
    );
    if (expected && (counter.bytes !== expected.bytes || hash.digest('hex') !== expected.sha256))
      throw new Error('Backup digest mismatch');
    if (partial) await rename(partial, target);
  } catch (error) {
    if (partial) await rm(partial, { force: true });
    throw error;
  }
}

function sealBytes(bytes, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([iv, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]);
}

function openBytes(bytes, key) {
  if (bytes.length < 28) throw new Error('Truncated encrypted backup manifest');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]);
}

/** Bundle already-exported D1, Chat DO and R2 files without sending private content to another service. */
export async function createChatBackupBundle(sourceDirectory, destinationDirectory, passphrase) {
  const source = resolve(sourceDirectory);
  const destination = resolve(destinationDirectory);
  if (destination === source || destination.startsWith(`${source}${sep}`))
    throw new Error('Backup destination cannot be inside its source');
  const paths = await listFiles(source);
  if (paths.length === 0) throw new Error('No source files to back up');
  const salt = randomBytes(32);
  const key = await deriveKey(passphrase, salt);
  await mkdir(destination, { mode: 0o700 });
  if ((await readdir(destination)).length) throw new Error('Backup destination must be empty');
  const manifest = { format: FORMAT, createdAt: new Date().toISOString(), files: [] };
  for (const [index, path] of paths.entries()) {
    const sourceFile = join(source, path);
    if (!(await lstat(sourceFile)).isFile())
      throw new Error('Backup source changed during capture');
    const blob = `${String(index).padStart(8, '0')}.enc`;
    const integrity = await sealFile(sourceFile, join(destination, blob), key);
    manifest.files.push({ path, blob, ...integrity });
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  if (manifestBytes.length > MAX_MANIFEST) throw new Error('Backup manifest too large');
  await writeFile(join(destination, 'manifest.enc'), sealBytes(manifestBytes, key), {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(
    join(destination, 'meta.json'),
    JSON.stringify({ format: FORMAT, salt: salt.toString('base64') }),
    {
      flag: 'wx',
      mode: 0o600,
    },
  );
  return { files: paths.length };
}

async function loadManifest(directory, passphrase) {
  const meta = JSON.parse(await readFile(join(directory, 'meta.json'), 'utf8'));
  if (meta.format !== FORMAT || typeof meta.salt !== 'string')
    throw new Error('Unknown backup format');
  const key = await deriveKey(passphrase, Buffer.from(meta.salt, 'base64'));
  const encryptedManifest = await readFile(join(directory, 'manifest.enc'));
  if (encryptedManifest.length > MAX_MANIFEST + 28) throw new Error('Backup manifest too large');
  const data = openBytes(encryptedManifest, key);
  const manifest = JSON.parse(data.toString('utf8'));
  if (manifest.format !== FORMAT || !Array.isArray(manifest.files))
    throw new Error('Invalid backup manifest');
  const paths = new Set();
  for (const [index, file] of manifest.files.entries()) {
    safePath(file.path);
    if (
      paths.has(file.path) ||
      file.blob !== `${String(index).padStart(8, '0')}.enc` ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('Invalid backup manifest entry');
    paths.add(file.path);
  }
  return { key, manifest };
}

/** Verify every ciphertext and plaintext digest; optionally recover into an empty isolated directory. */
export async function verifyChatBackupBundle(directory, passphrase, restoreDirectory) {
  const backup = resolve(directory);
  const { key, manifest } = await loadManifest(backup, passphrase);
  const restore = restoreDirectory ? resolve(restoreDirectory) : null;
  const staging = restore ? `${restore}.partial-${randomBytes(8).toString('hex')}` : null;
  if (restore) {
    if (restore === backup || restore.startsWith(`${backup}${sep}`))
      throw new Error('Restore destination cannot be inside the backup');
    try {
      await lstat(restore);
      throw new Error('Restore destination must not exist');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await mkdir(staging, { mode: 0o700 });
  }
  try {
    for (const file of manifest.files) {
      await openFile(join(backup, file.blob), staging ? join(staging, file.path) : null, key, file);
    }
    if (restore) await rename(staging, restore);
  } catch (error) {
    if (staging) await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return { files: manifest.files.length, createdAt: manifest.createdAt };
}
