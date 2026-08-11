import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

const root = resolve(import.meta.dirname, '..');
const tauri = JSON.parse(readFileSync(join(root, 'android/app/src-tauri/tauri.conf.json'), 'utf8'));
const defaultApk = join(
  root,
  'android/app/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk',
);
const apk = resolve(process.argv[2] ?? defaultApk);
const expectedCertificate = '1d847c1ea8dc89a2a07bc8c5194a0f43645907223174c1ea394eb522c7a49491';
const requiredPermissions = [
  'android.permission.INTERNET',
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.BLUETOOTH',
  'android.permission.BLUETOOTH_ADMIN',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
];

function fail(message) {
  throw new Error(message);
}

function numericVersion(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] ?? 0) !== (b[index] ?? 0)) return (a[index] ?? 0) - (b[index] ?? 0);
  }
  return 0;
}

function androidTool(name) {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (!sdk) fail('ANDROID_HOME or ANDROID_SDK_ROOT is required');
  const buildTools = join(sdk, 'build-tools');
  const versions = readdirSync(buildTools)
    .filter((entry) => /^\d+(?:\.\d+)*$/.test(entry))
    .sort(numericVersion)
    .reverse();
  for (const version of versions) {
    const candidate = join(buildTools, version, name);
    if (existsSync(candidate)) return candidate;
  }
  fail(`${name} was not found under ${buildTools}`);
}

function run(tool, args) {
  return execFileSync(tool, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
}

function runCombined(tool, args) {
  const result = spawnSync(tool, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) fail(`${tool} exited with status ${result.status}`);
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function requireMatch(text, pattern, message) {
  const match = text.match(pattern);
  if (!match) fail(message);
  return match;
}

function readZipEntry(zip, wantedName) {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const localSignature = 0x04034b50;
  let eocd = -1;
  for (let index = zip.length - 22; index >= Math.max(0, zip.length - 65_557); index -= 1) {
    if (zip.readUInt32LE(index) === eocdSignature) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) fail('APK has no ZIP end-of-central-directory record');

  const entryCount = zip.readUInt16LE(eocd + 10);
  let central = zip.readUInt32LE(eocd + 16);
  for (let entry = 0; entry < entryCount; entry += 1) {
    if (zip.readUInt32LE(central) !== centralSignature) fail('APK central directory is invalid');
    const method = zip.readUInt16LE(central + 10);
    const compressedSize = zip.readUInt32LE(central + 20);
    const uncompressedSize = zip.readUInt32LE(central + 24);
    const nameLength = zip.readUInt16LE(central + 28);
    const extraLength = zip.readUInt16LE(central + 30);
    const commentLength = zip.readUInt16LE(central + 32);
    const localOffset = zip.readUInt32LE(central + 42);
    const name = zip.subarray(central + 46, central + 46 + nameLength).toString('utf8');
    if (name === wantedName) {
      if (zip.readUInt32LE(localOffset) !== localSignature) fail(`APK entry ${name} is invalid`);
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(dataStart, dataStart + compressedSize);
      const value = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
      if (!value) fail(`APK entry ${name} uses unsupported compression method ${method}`);
      if (value.length !== uncompressedSize) fail(`APK entry ${name} has an invalid size`);
      return value;
    }
    central += 46 + nameLength + extraLength + commentLength;
  }
  fail(`APK is missing ${wantedName}`);
}

if (!existsSync(apk)) fail(`APK not found: ${apk}`);

const badging = run(androidTool('aapt'), ['dump', 'badging', apk]);
const signature = runCombined(
  androidTool(process.platform === 'win32' ? 'apksigner.bat' : 'apksigner'),
  ['verify', '--verbose', '--print-certs', apk],
);
const packageLine = requireMatch(
  badging,
  /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/m,
  'aapt did not report package metadata',
);
const label = requireMatch(
  badging,
  /^application-label:'([^']+)'/m,
  'aapt did not report the application label',
)[1];
const minSdk = Number(
  requireMatch(badging, /^sdkVersion:'(\d+)'/m, 'aapt did not report minSdk')[1],
);
const certificate = requireMatch(
  signature,
  /^\s*Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]+)\s*$/im,
  'apksigner did not report the signing certificate digest',
)[1]
  .replaceAll(':', '')
  .toLowerCase();

const expectedCode = String(tauri.bundle.android.versionCode);
if (packageLine[1] !== tauri.identifier) {
  fail(`package is ${packageLine[1]}, expected upgrade identity ${tauri.identifier}`);
}
if (packageLine[2] !== expectedCode || packageLine[3] !== tauri.version) {
  fail(
    `APK version is ${packageLine[3]} (${packageLine[2]}), expected ${tauri.version} (${expectedCode})`,
  );
}
if (label !== tauri.productName)
  fail(`application label is ${label}, expected ${tauri.productName}`);
if (minSdk !== 26) fail(`minSdk is ${minSdk}, expected 26`);
if (!/^native-code: .*'arm64-v8a'/m.test(badging)) fail('APK does not contain arm64-v8a');
if (!badging.includes("uses-feature: name='android.hardware.bluetooth_le'")) {
  fail('APK does not declare android.hardware.bluetooth_le');
}
for (const permission of requiredPermissions) {
  if (!badging.includes(`uses-permission: name='${permission}'`)) {
    fail(`APK is missing ${permission}`);
  }
}
if (!/^Verified using v2 scheme \(APK Signature Scheme v2\): true$/m.test(signature)) {
  fail('APK Signature Scheme v2 verification did not pass');
}
if (certificate !== expectedCertificate) {
  fail(
    `signing certificate is ${certificate}, expected DG-Agent certificate ${expectedCertificate}`,
  );
}

const bytes = readFileSync(apk);
const provenance = JSON.parse(readZipEntry(bytes, 'assets/0xnuller-build.json').toString('utf8'));
const expectedSourceCommit =
  process.env.EXPECTED_SOURCE_COMMIT ?? run('git', ['-C', root, 'rev-parse', 'HEAD']).trim();
if (
  provenance.schemaVersion !== 1 ||
  provenance.product !== tauri.productName ||
  provenance.version !== tauri.version ||
  provenance.sourceCommit !== expectedSourceCommit ||
  provenance.dirty !== false
) {
  fail(
    `APK provenance is ${JSON.stringify(provenance)}, expected clean ${tauri.productName} ${tauri.version} from ${expectedSourceCommit}`,
  );
}
const sha256 = createHash('sha256').update(bytes).digest('hex');
console.log(
  JSON.stringify(
    {
      ok: true,
      apk,
      package: packageLine[1],
      versionName: packageLine[3],
      versionCode: Number(packageLine[2]),
      label,
      minSdk,
      abi: 'arm64-v8a',
      certificateSha256: certificate,
      sourceCommit: provenance.sourceCommit,
      apkSha256: sha256,
      bytes: statSync(apk).size,
    },
    null,
    2,
  ),
);
