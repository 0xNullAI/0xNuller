import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');
const generated = join(root, 'android/app/src-tauri/gen/android/app');
const gradlePath = join(generated, 'build.gradle.kts');
const manifestPath = join(generated, 'src/main/AndroidManifest.xml');
const generatedJavaPath = join(generated, 'src/main/java');
const mainActivityPath = join(generatedJavaPath, 'ai/nullai/dgagent/MainActivity.kt');
const generatedAssetsPath = join(generated, 'src/main/assets');
const provenancePath = join(generatedAssetsPath, '0xnuller-build.json');
const resourcesPath = join(generated, 'src/main/res');
const signingTemplatePath = join(root, 'android/app/signing.gradle.kts.template');
const manifestTemplatePath = join(root, 'android/app/AndroidManifest.template.xml');
const mainActivityTemplatePath = join(root, 'android/app/MainActivity.template.kt');
const proguardTemplatePath = join(root, 'android/app/proguard-rules.pro.template');
const proguardPath = join(generated, 'proguard-rules.pro');
const thirdPartyNoticePath = join(root, 'android/app/THIRD_PARTY_NOTICES.md');
const btleplugLicensePath = join(root, 'android/app/licenses/btleplug-0.12.0-LICENSE.md');
const cargoManifestPath = join(root, 'android/app/src-tauri/Cargo.toml');
const tauriPath = join(root, 'android/app/src-tauri/tauri.conf.json');
const iconPath = join(root, 'android/app/src-tauri/icons/icon.png');
const tauriCliPath = join(
  root,
  'node_modules/.bin',
  process.platform === 'win32' ? 'tauri.cmd' : 'tauri',
);
const releaseBuild = process.argv.includes('--release');

for (const path of [gradlePath, manifestPath, mainActivityPath]) {
  if (!existsSync(path)) {
    throw new Error(`missing generated Android project; run npm run android:init first (${path})`);
  }
}

const mainActivityTemplate = readFileSync(mainActivityTemplatePath, 'utf8');
if (readFileSync(mainActivityPath, 'utf8') !== mainActivityTemplate) {
  writeFileSync(mainActivityPath, mainActivityTemplate);
}

// btleplug 0.12's Android backend is hybrid Rust/Java. Resolve the source via
// Cargo metadata so the Java copied into the generated project is exactly the
// registry package selected by Cargo.lock; generated sources remain untracked.
const btleplugRoot = lockedCargoPackage('btleplug', '0.12.0');
const btleplugJavaPath = join(btleplugRoot, 'src/droidplug/java/src/main/java');
if (!existsSync(btleplugJavaPath)) {
  throw new Error(`locked btleplug package has no Android Java sources: ${btleplugJavaPath}`);
}
for (const packagePath of ['com/nonpolynomial/btleplug', 'io/github/gedgygedgy']) {
  rmSync(join(generatedJavaPath, packagePath), { recursive: true, force: true });
}
cpSync(btleplugJavaPath, generatedJavaPath, { recursive: true, force: true });
cpSync(proguardTemplatePath, proguardPath, { force: true });

function attribute(node, name) {
  return node.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? null;
}

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function lockedCargoPackage(name, version) {
  const metadata = JSON.parse(
    execFileSync(
      'cargo',
      ['metadata', '--locked', '--format-version', '1', '--manifest-path', cargoManifestPath],
      {
        cwd: root,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    ),
  );
  const cargoPackage = metadata.packages.find(
    (candidate) => candidate.name === name && candidate.version === version,
  );
  if (!cargoPackage || !cargoPackage.source?.startsWith('registry+')) {
    throw new Error(`Cargo.lock must resolve registry package ${name} ${version}`);
  }
  return dirname(cargoPackage.manifest_path);
}

function kotlinBlocks(source, name) {
  const blocks = [];
  const pattern = new RegExp(`\\b${name}\\s*\\{`, 'g');
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      if (depth === 0) {
        blocks.push({ start, end: index + 1, text: source.slice(start, index + 1) });
        break;
      }
    }
  }
  return blocks;
}

let manifest = readFileSync(manifestPath, 'utf8');
const manifestTemplate = readFileSync(manifestTemplatePath, 'utf8');
const requiredNodes = manifestTemplate.match(/<uses-(?:permission|feature)\b[\s\S]*?\/>/g) ?? [];
const missingNodes = requiredNodes.filter((node) => {
  const androidName = attribute(node, 'android:name');
  return androidName && !manifest.includes(`android:name="${androidName}"`);
});
if (missingNodes.length > 0) {
  const insertion = missingNodes.map((node) => `    ${node.replace(/\n\s*/g, ' ')}`).join('\n');
  manifest = manifest.replace(/\n\s*<application\b/, `\n\n${insertion}\n\n    <application`);
}
if (!manifest.includes('android:roundIcon="@mipmap/ic_launcher_round"')) {
  manifest = manifest.replace(
    /(<application\s*\n)/,
    '$1        android:roundIcon="@mipmap/ic_launcher_round"\n',
  );
}
writeFileSync(manifestPath, manifest);

// `tauri android init` leaves Android Studio's green robot launchers in the
// generated project. Generate every density and adaptive-icon resource from
// the canonical 0xNuller icon, then overlay those resources after each init.
const generatedIcons = mkdtempSync(join(tmpdir(), '0xnuller-icons-'));
try {
  execFileSync(tauriCliPath, ['icon', iconPath, '--output', generatedIcons], {
    cwd: join(root, 'android/app'),
    stdio: 'pipe',
  });
  cpSync(join(generatedIcons, 'android'), resourcesPath, { recursive: true, force: true });
} finally {
  rmSync(generatedIcons, { recursive: true, force: true });
}

let gradle = readFileSync(gradlePath, 'utf8');
if (!/\bminSdk\s*=\s*\d+/.test(gradle)) throw new Error('generated Gradle file has no minSdk');
gradle = gradle.replace(/\bminSdk\s*=\s*\d+/, 'minSdk = 26');

const signingTemplate = readFileSync(signingTemplatePath, 'utf8').trimEnd();
const signingMarker = '// 0XNULLER_RELEASE_SIGNING';
const releaseSigningBlocks = kotlinBlocks(gradle, 'signingConfigs').filter((block) =>
  block.text.includes('create("release")'),
);
const hardenedSigningBlock = releaseSigningBlocks.find((block) =>
  gradle
    .slice(Math.max(0, block.start - signingMarker.length - 80), block.start)
    .includes(signingMarker),
);
if (hardenedSigningBlock) {
  for (const block of releaseSigningBlocks.toReversed()) {
    if (block.start !== hardenedSigningBlock.start) {
      gradle = `${gradle.slice(0, block.start)}${gradle.slice(block.end)}`;
    }
  }
} else if (releaseSigningBlocks.length > 0) {
  const [first, ...duplicates] = releaseSigningBlocks;
  for (const block of duplicates.toReversed()) {
    gradle = `${gradle.slice(0, block.start)}${gradle.slice(block.end)}`;
  }
  gradle = `${gradle.slice(0, first.start)}${signingTemplate}${gradle.slice(first.end)}`;
} else {
  gradle = gradle.replace(/^(\s*)buildTypes\s*\{/m, `${signingTemplate}\n\n$1buildTypes {`);
}
const releaseBlock = /(getByName\("release"\)\s*\{\n)(?!\s*signingConfig)/;
if (!gradle.includes('signingConfig = signingConfigs.getByName("release")')) {
  if (!releaseBlock.test(gradle))
    throw new Error('generated Gradle file has no release build type');
  gradle = gradle.replace(
    releaseBlock,
    '$1            signingConfig = signingConfigs.getByName("release")\n',
  );
}
const normalizedReleaseSigningBlocks = kotlinBlocks(gradle, 'signingConfigs').filter((block) =>
  block.text.includes('create("release")'),
);
if (normalizedReleaseSigningBlocks.length !== 1) {
  throw new Error('generated Gradle file must contain exactly one release signing config');
}
writeFileSync(gradlePath, gradle);

const sourceCommit = git('rev-parse', 'HEAD');
const worktreeChanges = git('status', '--porcelain', '--untracked-files=all');
if (releaseBuild && worktreeChanges) {
  throw new Error('release APK must be built from a clean worktree');
}
const tauri = JSON.parse(readFileSync(tauriPath, 'utf8'));
mkdirSync(generatedAssetsPath, { recursive: true });
cpSync(thirdPartyNoticePath, join(generatedAssetsPath, 'THIRD_PARTY_NOTICES.md'));
cpSync(btleplugLicensePath, join(generatedAssetsPath, 'btleplug-0.12.0-LICENSE.md'));
writeFileSync(
  provenancePath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      product: tauri.productName,
      version: tauri.version,
      sourceCommit,
      dirty: Boolean(worktreeChanges),
    },
    null,
    2,
  )}\n`,
);

for (const required of [
  'android.permission.BLUETOOTH_SCAN',
  'android.permission.BLUETOOTH_CONNECT',
  'android.hardware.bluetooth_le',
]) {
  if (!manifest.includes(required)) throw new Error(`Android manifest is missing ${required}`);
}
if (!gradle.includes('minSdk = 26') || !gradle.includes(signingMarker)) {
  throw new Error('generated Android Gradle configuration is incomplete');
}
for (const required of [
  'mipmap-anydpi-v26/ic_launcher.xml',
  'mipmap-mdpi/ic_launcher.png',
  'mipmap-xxxhdpi/ic_launcher_foreground.png',
]) {
  if (!existsSync(join(resourcesPath, required))) {
    throw new Error(`Android project is missing generated 0xNuller launcher icon: ${required}`);
  }
}
if (!manifest.includes('android:roundIcon="@mipmap/ic_launcher_round"')) {
  throw new Error('Android manifest is missing the branded round launcher icon');
}
const mainActivity = readFileSync(mainActivityPath, 'utf8');
for (const required of [
  'WindowInsetsCompat.Type.systemBars()',
  'WindowInsetsCompat.Type.displayCutout()',
  'WindowInsetsCompat.Type.ime()',
  'maxOf(insets.bottom, imeInsets.bottom)',
  'webView.addJavascriptInterface(AndroidSystemBridge()',
  'initializeButtplugGate0()',
]) {
  if (!mainActivity.includes(required)) {
    throw new Error(`Android MainActivity is missing native inset handling: ${required}`);
  }
}
for (const required of ['THIRD_PARTY_NOTICES.md', 'btleplug-0.12.0-LICENSE.md']) {
  if (!existsSync(join(generatedAssetsPath, required))) {
    throw new Error(`Android project is missing packaged third-party notice: ${required}`);
  }
}
for (const required of [
  'com/nonpolynomial/btleplug/android/impl/Adapter.java',
  'io/github/gedgygedgy/rust/future/Future.java',
]) {
  if (!existsSync(join(generatedJavaPath, required))) {
    throw new Error(`Android project is missing locked btleplug Java source: ${required}`);
  }
}
const proguard = readFileSync(proguardPath, 'utf8');
for (const required of [
  '-keep class com.nonpolynomial.**',
  '-keep class io.github.gedgygedgy.**',
]) {
  if (!proguard.includes(required)) {
    throw new Error(`Android project is missing btleplug Proguard rule: ${required}`);
  }
}

console.log(
  `Android project prepared: 0xNuller launcher icons, BLE permissions, native system-bar insets, locked btleplug 0.12 Java, minSdk 26, fail-closed release signing, source ${sourceCommit}`,
);
