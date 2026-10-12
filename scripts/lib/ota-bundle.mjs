import { createHash, createPublicKey, verify } from 'node:crypto';

export const OTA_MANIFEST_SCHEMA = 1;

export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The raw 32-byte ed25519 key the APK compiles in, as a Node KeyObject. */
export function releasePublicKey(base64) {
  const raw = Buffer.from(base64.trim(), 'base64');
  if (raw.length !== 32) throw new Error('OTA public key must be 32 raw bytes');
  // SPKI prefix for an Ed25519 public key.
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function verifyLatest(latest, publicKey) {
  if (typeof latest?.manifest !== 'string' || typeof latest?.signature !== 'string') {
    throw new Error('latest.json must hold a manifest string and a signature');
  }
  const ok = verify(
    null,
    Buffer.from(latest.manifest, 'utf8'),
    publicKey,
    Buffer.from(latest.signature, 'base64'),
  );
  if (!ok) throw new Error('latest.json signature does not verify with the release key');
  return JSON.parse(latest.manifest);
}

/** The summary paragraph of docs/releases/X.Y.Z.md, shown in the app's update banner. */
export function releaseSummary(markdown) {
  const paragraph = markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !block.startsWith('#') && !block.startsWith('-'));
  if (!paragraph) return null;
  const text = paragraph.replace(/\s+/g, ' ').replace(/[*_`]/g, '');
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}
