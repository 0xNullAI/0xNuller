import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PRODUCT_FILES = {
  root: 'package.json',
  androidPackage: 'android/app/package.json',
  tauri: 'android/app/src-tauri/tauri.conf.json',
  cargo: 'android/app/src-tauri/Cargo.toml',
  lock: 'package-lock.json',
};
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function fail(message) {
  throw new Error(message);
}

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function stableParts(version, label) {
  const match = STABLE_VERSION.exec(version);
  if (!match) fail(`${label} must be a stable x.y.z version, got ${JSON.stringify(version)}`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  const a = stableParts(left, 'current version');
  const b = stableParts(right, 'base version');
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function cargoPackageVersion() {
  const cargo = readFileSync(PRODUCT_FILES.cargo, 'utf8');
  const packageStart = cargo.indexOf('[package]');
  if (packageStart < 0) fail(`${PRODUCT_FILES.cargo} has no [package] section`);
  const afterHeader = cargo.slice(packageStart + '[package]'.length);
  const nextSection = afterHeader.search(/^\[/m);
  const packageBlock = nextSection < 0 ? afterHeader : afterHeader.slice(0, nextSection);
  const version = packageBlock.match(/^version\s*=\s*"([^"]+)"\s*$/m)?.[1];
  if (!version) fail(`${PRODUCT_FILES.cargo} has no [package] version`);
  return version;
}

function verifyProductMetadata() {
  const root = json(PRODUCT_FILES.root);
  const androidPackage = json(PRODUCT_FILES.androidPackage);
  const tauri = json(PRODUCT_FILES.tauri);
  const lock = json(PRODUCT_FILES.lock);
  const versions = new Map([
    [PRODUCT_FILES.root, root.version],
    [PRODUCT_FILES.androidPackage, androidPackage.version],
    [PRODUCT_FILES.tauri, tauri.version],
    [PRODUCT_FILES.cargo, cargoPackageVersion()],
    [`${PRODUCT_FILES.lock} root`, lock.packages?.['']?.version],
    [`${PRODUCT_FILES.lock} android/app`, lock.packages?.['android/app']?.version],
  ]);
  stableParts(root.version, PRODUCT_FILES.root);
  for (const [label, version] of versions) {
    if (version !== root.version) {
      fail(
        `product version drift: ${label} is ${JSON.stringify(version)}, expected ${root.version}`,
      );
    }
  }

  const [major, minor, patch] = stableParts(root.version, PRODUCT_FILES.root);
  if (minor > 999 || patch > 999) fail('minor and patch must fit the Android versionCode mapping');
  const expectedCode = major * 1_000_000 + minor * 1_000 + patch;
  if (tauri.bundle?.android?.versionCode !== expectedCode) {
    fail(
      `android versionCode is ${tauri.bundle?.android?.versionCode}, expected ${expectedCode} for ${root.version}`,
    );
  }
  if (tauri.productName !== '0xNuller') fail('Tauri productName must remain 0xNuller');
  if (tauri.identifier !== 'ai.nullai.dgagent') {
    fail('Android identifier must remain ai.nullai.dgagent for upgrade compatibility');
  }
  if (root.private !== true || androidPackage.private !== true) {
    fail('the root product and Android shell must remain private npm packages');
  }
  for (const path of ['android/app/README.md', 'docs/android-release.md']) {
    if (!readFileSync(path, 'utf8').includes(`v${root.version}`)) {
      fail(`${path} must document the current v${root.version} release tag`);
    }
  }

  const releaseWorkflow = readFileSync('.github/workflows/release.yml', 'utf8');
  const androidReleaseWorkflow = readFileSync('.github/workflows/android-release.yml', 'utf8');
  const updateChecker = readFileSync('android/app/src/services/update-checker.ts', 'utf8');
  if (!androidReleaseWorkflow.includes('tag="v$version"')) {
    fail('product release must create the unified source/product tag v<version>');
  }
  if (!updateChecker.includes("DEFAULT_TAG_PREFIX = 'v'")) {
    fail('Android updater must only consume unified v<version> releases');
  }
  if (!updateChecker.includes("APK_ASSET_PREFIX = '0xnuller-v'")) {
    fail('Android updater must require the versioned 0xnuller APK asset');
  }
  for (const required of [
    'setupGitUser: false',
    'GIT_AUTHOR_NAME: 0xNull',
    'GIT_AUTHOR_EMAIL: 271426072+0xNullAI@users.noreply.github.com',
    'GIT_COMMITTER_NAME: 0xNull',
    'GIT_COMMITTER_EMAIL: 271426072+0xNullAI@users.noreply.github.com',
  ]) {
    if (!releaseWorkflow.includes(required)) {
      fail(`release workflow does not enforce commit identity: missing ${required}`);
    }
  }
  if (
    !releaseWorkflow.includes('workflow_dispatch:') ||
    !/push:\s*\n\s+branches: \[dev, main\]/.test(releaseWorkflow)
  ) {
    fail('release must support manual runs and dev/main push after the external cutover');
  }
  if (
    !androidReleaseWorkflow.includes('workflow_dispatch:') ||
    !/workflow_run:\s*\n\s+workflows: \[CI\]/.test(androidReleaseWorkflow) ||
    !androidReleaseWorkflow.includes("github.event.workflow_run.conclusion == 'success'")
  ) {
    fail('Android release must support manual runs and verified main releases');
  }
  if (!androidReleaseWorkflow.includes("should-release == 'true'")) {
    fail('Android release must skip versions that already have a signed release');
  }
  for (const required of [
    '--title "0xNuller $VERSION"',
    '--notes-file "docs/releases/$VERSION.md"',
    '--target "${{ needs.prepare.outputs.source-sha }}"',
    '--latest',
  ]) {
    if (!androidReleaseWorkflow.includes(required)) {
      fail(`Android must own the single product Release: missing ${required}`);
    }
  }

  return root.version;
}

function gitShow(base, path) {
  try {
    return execFileSync('git', ['show', `${base}:${path}`], { encoding: 'utf8' });
  } catch {
    return null;
  }
}

function releasePackagePaths() {
  const output = execFileSync(
    'git',
    ['ls-files', 'package.json', 'apps/*/package.json', 'packages/*/*/package.json'],
    { encoding: 'utf8' },
  );
  return output
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((path) => path === PRODUCT_FILES.root || json(path).private !== true);
}

function verifyBumps(base) {
  const bumps = [];
  for (const path of releasePackagePaths()) {
    const current = json(path).version;
    stableParts(current, path);
    const previousText = gitShow(base, path);
    if (previousText === null) {
      bumps.push(`${path}: new @ ${current}`);
      continue;
    }
    const previous = JSON.parse(previousText).version;
    stableParts(previous, `${base}:${path}`);
    const comparison = compareVersions(current, previous);
    if (comparison < 0) fail(`${path} decreases from ${previous} to ${current}`);
    if (comparison > 0) bumps.push(`${path}: ${previous} -> ${current}`);
  }
  if (bumps.length === 0) fail(`no releasable package version increased relative to ${base}`);
  return bumps;
}

const version = verifyProductMetadata();
const baseFlag = process.argv.find((argument) => argument.startsWith('--base='));
const bumps = baseFlag ? verifyBumps(baseFlag.slice('--base='.length)) : [];
console.log(`release metadata OK: 0xNuller ${version}`);
console.log(`tag boundary OK: unified source/product v${version} with Android APK`);
for (const bump of bumps) console.log(`version bump: ${bump}`);
