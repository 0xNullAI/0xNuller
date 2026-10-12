// Keeps android/native-api.json in step with the native layer.
//   node scripts/native-fingerprint.mjs                 verify the recorded fingerprint
//   node scripts/native-fingerprint.mjs --against=v7.1.0
//       also require a NATIVE_API bump when the native layer differs from that APK release
//   node scripts/native-fingerprint.mjs --write         record the current fingerprint
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  NATIVE_API_FILE,
  RUST_OTA_FILE,
  nativeFingerprint,
  rustNativeApi,
} from './lib/native-fingerprint.mjs';

const root = join(import.meta.dirname, '..');
const rustApi = rustNativeApi(readFileSync(join(root, RUST_OTA_FILE), 'utf8'));
const fingerprint = nativeFingerprint(root);

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (process.argv.includes('--write')) {
  writeFileSync(
    join(root, NATIVE_API_FILE),
    `${JSON.stringify({ nativeApi: rustApi, fingerprint }, null, 2)}\n`,
  );
  console.log(`recorded native API ${rustApi} (${fingerprint.slice(0, 12)})`);
  process.exit(0);
}

const recorded = JSON.parse(readFileSync(join(root, NATIVE_API_FILE), 'utf8'));
if (recorded.nativeApi !== rustApi) {
  fail(
    `${NATIVE_API_FILE} says native API ${recorded.nativeApi}; ${RUST_OTA_FILE} says ${rustApi}.`,
  );
}
if (recorded.fingerprint !== fingerprint) {
  fail(
    `The Android native layer changed since ${NATIVE_API_FILE} was recorded. If installed APKs ` +
      `cannot run UI built against it, bump NATIVE_API in ${RUST_OTA_FILE}; then run ` +
      'node scripts/native-fingerprint.mjs --write',
  );
}

const against = process.argv.find((argument) => argument.startsWith('--against='))?.slice(10);
if (against) {
  let released = null;
  try {
    released = JSON.parse(
      execFileSync('git', ['show', `${against}:${NATIVE_API_FILE}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    // Released before hot updates existed: this release ships an APK anyway.
  }
  if (released && released.fingerprint !== fingerprint && released.nativeApi === rustApi) {
    fail(
      `The native layer differs from APK release ${against} but NATIVE_API is still ${rustApi}. ` +
        `Bump it in ${RUST_OTA_FILE} and run node scripts/native-fingerprint.mjs --write, so ` +
        'this release ships an APK and older APKs keep the UI they can run.',
    );
  }
  console.log(
    released && released.nativeApi === rustApi
      ? `native API ${rustApi} matches APK release ${against}: UI-only release`
      : `native API ${rustApi} is new since ${against}: this release ships an APK`,
  );
}
console.log(`native API ${rustApi} OK (${fingerprint.slice(0, 12)})`);
