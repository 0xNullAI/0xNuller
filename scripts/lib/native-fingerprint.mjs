import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The native surface a hot-update bundle depends on. When any of it changes, installed APKs can
 * no longer run a new UI safely, so the native API must be bumped and the release ships an APK.
 */
export const NATIVE_PATHS = [
  'android/app/src-tauri/src',
  'android/app/src-tauri/build.rs',
  'android/app/src-tauri/capabilities',
  'android/app/src-tauri/icons',
  'android/app/src-tauri/ota-public-key.txt',
  'android/app/src-tauri/Cargo.toml',
  'android/app/src-tauri/Cargo.lock',
  'android/app/src-tauri/tauri.conf.json',
  'android/app/AndroidManifest.template.xml',
  'android/app/MainActivity.template.kt',
  'android/app/proguard-rules.pro.template',
  'android/app/signing.gradle.kts.template',
  'brand/icon',
  'scripts/prepare-android-release.mjs',
];

/** npm packages whose JS half talks to native code shipped in the APK. */
export const NATIVE_NPM_PACKAGES = [
  'node_modules/@tauri-apps/api',
  'node_modules/@tauri-apps/cli',
  'node_modules/@tauri-apps/plugin-opener',
  'node_modules/@mnlphlp/plugin-blec',
];

export const NATIVE_API_FILE = 'android/native-api.json';
export const RUST_OTA_FILE = 'android/app/src-tauri/src/ota.rs';

/** The product version changes every release without changing what the native layer can do. */
function normalize(path, text) {
  if (path.endsWith('tauri.conf.json')) {
    const config = JSON.parse(text);
    delete config.version;
    if (config.bundle?.android) delete config.bundle.android.versionCode;
    return JSON.stringify(config);
  }
  if (path.endsWith('Cargo.toml')) return text.replace(/^version = ".*"$/m, 'version = ""');
  if (path.endsWith('Cargo.lock')) {
    return text.replace(/(name = "nuller-app"\nversion = )".*"/, '$1""');
  }
  return text;
}

export function nativeFingerprint(root, ref = null) {
  const hash = createHash('sha256');
  const files = execFileSync(
    'git',
    ref
      ? ['ls-tree', '-r', '--name-only', ref, '--', ...NATIVE_PATHS]
      : ['ls-files', '--', ...NATIVE_PATHS],
    { cwd: root, encoding: 'utf8' },
  )
    .split('\n')
    .filter(Boolean)
    .sort();
  for (const path of files) {
    const bytes = ref
      ? execFileSync('git', ['show', `${ref}:${path}`], { cwd: root, maxBuffer: 64 << 20 })
      : readFileSync(join(root, path));
    const binary = /\.(png|jpg|webp|ico|icns)$/i.test(path);
    hash.update(`${path}\0`);
    hash.update(binary ? bytes : normalize(path, bytes.toString('utf8')));
    hash.update('\0');
  }
  const lockText = ref
    ? execFileSync('git', ['show', `${ref}:package-lock.json`], {
        cwd: root,
        maxBuffer: 256 << 20,
      }).toString('utf8')
    : readFileSync(join(root, 'package-lock.json'), 'utf8');
  const lock = JSON.parse(lockText);
  for (const name of NATIVE_NPM_PACKAGES) {
    const entry = lock.packages?.[name];
    hash.update(`${name}\0${entry?.version ?? ''}\0${entry?.resolved ?? ''}\0`);
  }
  return hash.digest('hex');
}

export function rustNativeApi(source) {
  const match = /pub const NATIVE_API: u32 = (\d+);/.exec(source);
  if (!match) throw new Error(`${RUST_OTA_FILE} must declare pub const NATIVE_API: u32`);
  return Number(match[1]);
}
