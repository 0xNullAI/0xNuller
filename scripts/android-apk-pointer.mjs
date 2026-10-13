// Writes the APK pointer the Android update check reads from our own domain, so it does not
// depend on api.github.com being reachable:
//   node scripts/android-apk-pointer.mjs --version=7.2.0 --sha256=<hex> [--out=apps/web/dist/ota/android]
// Output: <out>/apk.json = { version, apkUrl, releaseUrl, sha256 }. The APK itself stays on
// GitHub Releases (the site cannot host files that large). Every product release writes it:
// for a UI-only release it points at the latest APK release, which is still current.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO = 'https://github.com/0xNullAI/0xNuller';
const arg = (name, fallback) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const version = arg('version');
const sha256 = arg('sha256', '');
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('--version must be x.y.z');
if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('--sha256 must be the APK SHA-256 in hex');

const out = resolve(join(import.meta.dirname, '..'), arg('out', 'apps/web/dist/ota/android'));
mkdirSync(out, { recursive: true });
const pointer = {
  version,
  apkUrl: `${REPO}/releases/download/v${version}/maoyuan-v${version}.apk`,
  releaseUrl: `${REPO}/releases/tag/v${version}`,
  sha256,
};
writeFileSync(join(out, 'apk.json'), `${JSON.stringify(pointer, null, 2)}\n`);
console.log(`APK pointer: v${version}`);
