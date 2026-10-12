// Packs the Android Web UI as a signed hot-update bundle next to the Web build.
//
//   OTA_SIGNING_KEY=<PKCS#8 PEM> node scripts/ota-bundle.mjs \
//     --version=7.1.1 --build-id=<sha> [--dist=android/app/dist] [--out=apps/web/dist/ota/android]
//
// Output: <out>/<build-id>/<files> and <out>/latest.json = { manifest, signature }, where the
// signature covers the exact manifest string. Source maps stay out of the bundle.
import { createPrivateKey, sign } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, sep } from 'node:path';
import { NATIVE_API_FILE } from './lib/native-fingerprint.mjs';
import {
  OTA_MANIFEST_SCHEMA,
  releasePublicKey,
  releaseSummary,
  sha256Hex,
  verifyLatest,
} from './lib/ota-bundle.mjs';

const root = join(import.meta.dirname, '..');
const arg = (name, fallback) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const version = arg('version');
const buildId = arg('build-id');
const dist = join(root, arg('dist', 'android/app/dist'));
const out = join(root, arg('out', 'apps/web/dist/ota/android'));
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error('--version=x.y.z is required');
if (!/^[A-Za-z0-9_-]{1,64}$/.test(buildId ?? '')) throw new Error('--build-id is required');
if (!existsSync(join(dist, 'index.html'))) throw new Error(`no Android build at ${dist}`);
const pem = process.env.OTA_SIGNING_KEY;
if (!pem) throw new Error('OTA_SIGNING_KEY is not set');

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

const files = walk(dist)
  .map((path) => relative(dist, path).split(sep).join('/'))
  .filter((path) => !path.endsWith('.map'))
  .sort()
  .map((path) => {
    const bytes = readFileSync(join(dist, path));
    return { path, sha256: sha256Hex(bytes), size: bytes.length };
  });

const nativeApi = JSON.parse(readFileSync(join(root, NATIVE_API_FILE), 'utf8')).nativeApi;
const revokedPath = join(root, 'android/ota-revoked.json');
const revoked = existsSync(revokedPath) ? JSON.parse(readFileSync(revokedPath, 'utf8')) : [];
const notesPath = join(root, `docs/releases/${version}.md`);
const notes = existsSync(notesPath) ? releaseSummary(readFileSync(notesPath, 'utf8')) : null;

const manifest = JSON.stringify({
  schema: OTA_MANIFEST_SCHEMA,
  version,
  buildId,
  nativeApi,
  files,
  revoked,
  notes,
});
const signature = sign(null, Buffer.from(manifest, 'utf8'), createPrivateKey(pem)).toString(
  'base64',
);
const latest = { manifest, signature };

// Never publish a bundle the APK would reject.
const publicKey = releasePublicKey(
  readFileSync(join(root, 'android/app/src-tauri/ota-public-key.txt'), 'utf8'),
);
verifyLatest(latest, publicKey);

const target = join(out, buildId);
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
for (const file of files) {
  mkdirSync(join(target, file.path, '..'), { recursive: true });
  cpSync(join(dist, file.path), join(target, file.path));
}
writeFileSync(join(out, 'latest.json'), `${JSON.stringify(latest)}\n`);
const bytes = files.reduce((sum, file) => sum + file.size, 0);
console.log(
  `OTA bundle ${version} (${buildId.slice(0, 12)}): ${files.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB, native API ${nativeApi}`,
);
