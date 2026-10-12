import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { releasePublicKey, releaseSummary, verifyLatest } from './ota-bundle.mjs';

function keyPair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');
  return { raw, privateKey };
}

describe('OTA bundle signing', () => {
  it('verifies a manifest signed by the release key, as the APK does', () => {
    const { raw, privateKey } = keyPair();
    const manifest = JSON.stringify({ schema: 1, version: '7.1.1' });
    const signature = sign(null, Buffer.from(manifest), privateKey).toString('base64');
    expect(verifyLatest({ manifest, signature }, releasePublicKey(raw)).version).toBe('7.1.1');
  });

  it('rejects another key and a changed manifest', () => {
    const release = keyPair();
    const other = keyPair();
    const manifest = JSON.stringify({ schema: 1, version: '7.1.1' });
    const signature = sign(null, Buffer.from(manifest), other.privateKey).toString('base64');
    expect(() => verifyLatest({ manifest, signature }, releasePublicKey(release.raw))).toThrow();
    const own = sign(null, Buffer.from(manifest), release.privateKey).toString('base64');
    expect(() =>
      verifyLatest(
        { manifest: manifest.replace('7.1.1', '9.9.9'), signature: own },
        releasePublicKey(release.raw),
      ),
    ).toThrow();
  });

  it('takes the summary paragraph of the release notes', () => {
    expect(releaseSummary('# 猫愿 7.1.1\n\n修复了**登录**问题。\n\n## 细节\n\n- 一条')).toBe(
      '修复了登录问题。',
    );
    expect(releaseSummary('# 只有标题\n\n- 列表')).toBeNull();
  });
});
