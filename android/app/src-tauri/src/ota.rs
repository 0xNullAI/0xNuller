//! Signed Web-bundle hot updates.
//!
//! The APK embeds one copy of the Web UI. A newer UI can arrive later as a
//! bundle: a manifest signed with the release key, listing every file with its
//! SHA-256. Bundles are served through Tauri's own asset protocol, so the page
//! keeps the `tauri.localhost` origin and with it every byte of local storage.
//!
//! Safety rules, all enforced here rather than in the page:
//! - only manifests signed by the release key compiled into this APK are read;
//! - a bundle must be built for exactly this native API, and must be newer
//!   than both the embedded UI and anything already installed;
//! - a bundle replaces the running UI only at the next start (or when the page
//!   asks to restart into it), and stays on probation until the page confirms
//!   it rendered; after [`MAX_UNCONFIRMED_BOOTS`] starts without a confirm the
//!   previous UI comes back and the bundle is never installed again;
//! - a bundle on probation is re-hashed against its signed manifest at every
//!   start, so a file torn by a power loss never serves.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ed25519_dalek::{Signature, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::Write as _;
use std::path::{Component, Path, PathBuf};
use std::sync::{Mutex, RwLock};

/// Bumped whenever the Rust, Kotlin, plugin or permission surface the page
/// relies on changes. A bundle runs only on the exact native API it was built
/// for; `scripts/native-fingerprint.mjs` keeps this honest in CI.
pub const NATIVE_API: u32 = 3;

/// The release public key (raw 32 bytes, base64). The private half lives only
/// in the release pipeline's secrets.
pub const RELEASE_PUBLIC_KEY: &str = include_str!("../ota-public-key.txt");

/// Starts allowed before a bundle that never confirmed itself is rolled back.
pub const MAX_UNCONFIRMED_BOOTS: u8 = 3;

const MANIFEST_SCHEMA: u32 = 1;
const MAX_FILES: usize = 2_000;
const MAX_BUNDLE_BYTES: u64 = 40 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OtaError {
    pub code: &'static str,
    pub message: String,
}

impl OtaError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<std::io::Error> for OtaError {
    fn from(error: std::io::Error) -> Self {
        Self::new("io", error.to_string())
    }
}

pub type OtaResult<T> = Result<T, OtaError>;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ManifestFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32,
    pub version: String,
    pub build_id: String,
    pub native_api: u32,
    pub files: Vec<ManifestFile>,
    #[serde(default)]
    pub revoked: Vec<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct Slot {
    build_id: String,
    version: String,
    native_api: u32,
    confirmed: bool,
    attempts: u8,
    #[serde(default)]
    notes: Option<String>,
}

/// A build that must never be installed again: revoked by a signed manifest,
/// rolled back after failed starts, or dropped by a reset.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", from = "BadEntry")]
struct BadBuild {
    build_id: String,
    /// Known once a signed manifest for the build has been seen; lets the
    /// entry be pruned when the build can no longer qualify anyway.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

/// `state.json` from before versions were recorded holds bare build ids.
#[derive(Deserialize)]
#[serde(untagged)]
enum BadEntry {
    Id(String),
    #[serde(rename_all = "camelCase")]
    Build {
        build_id: String,
        #[serde(default)]
        version: Option<String>,
    },
}

impl From<BadEntry> for BadBuild {
    fn from(entry: BadEntry) -> Self {
        match entry {
            BadEntry::Id(build_id) => Self {
                build_id,
                version: None,
            },
            BadEntry::Build { build_id, version } => Self { build_id, version },
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct State {
    current: Option<Slot>,
    previous: Option<Slot>,
    pending: Option<Slot>,
    #[serde(default)]
    bad: Vec<BadBuild>,
}

impl State {
    fn is_bad(&self, build_id: &str) -> bool {
        self.bad.iter().any(|entry| entry.build_id == build_id)
    }
}

/// The signed manifest kept beside an installed bundle, so the bundle can be
/// re-checked file by file before it serves.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestRecord {
    manifest: String,
    signature: String,
}

/// What the asset protocol serves while this process runs.
#[derive(Debug)]
pub struct ActiveBundle {
    pub build_id: String,
    pub version: String,
    dir: PathBuf,
    script_hashes: Vec<String>,
}

impl ActiveBundle {
    pub fn script_hashes(&self) -> &[String] {
        &self.script_hashes
    }
}

struct Staging {
    manifest: Manifest,
    record: ManifestRecord,
    dir: PathBuf,
    written: HashSet<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundleInfo {
    pub build_id: String,
    pub version: String,
    pub notes: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OtaStatus {
    /// `false` when this run could not set hot updates up (no data directory
    /// or no usable release key): the APK's own UI serves and every install
    /// command fails with code `unavailable`.
    pub available: bool,
    pub native_api: u32,
    pub embedded_version: String,
    /// The bundle this process serves; `None` means the APK's own UI.
    pub active: Option<BundleInfo>,
    /// A verified bundle that takes over on the next start.
    pub pending: Option<BundleInfo>,
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BeginAction {
    /// Nothing newer for this APK.
    UpToDate,
    /// The newest UI needs a different native layer; only a new APK helps.
    NativeMismatch,
    /// Fetch `missing` and hand each file to [`OtaStore::write`].
    Download,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BeginResult {
    pub action: BeginAction,
    pub build_id: String,
    pub version: String,
    pub missing: Vec<String>,
    /// The running bundle was revoked; reloading brings back the previous UI.
    pub reload_required: bool,
}

pub struct OtaStore {
    root: PathBuf,
    embedded: Version,
    /// `None` is the explicit "OTA disabled" mode; there is no stand-in key.
    key: Option<VerifyingKey>,
    inner: Mutex<Inner>,
    active: RwLock<Option<&'static ActiveBundle>>,
    /// The bundle the page was loaded from before [`OtaStore::apply_now`]
    /// switched: still answers for files the new bundle lacks (an old lazy
    /// chunk requested before the reload lands) until the new page confirms.
    retiring: RwLock<Option<&'static ActiveBundle>>,
}

struct Inner {
    state: State,
    staging: Option<Staging>,
}

pub fn release_key() -> OtaResult<VerifyingKey> {
    let bytes = STANDARD
        .decode(RELEASE_PUBLIC_KEY.trim())
        .map_err(|_| OtaError::new("key", "release public key is not base64"))?;
    let bytes: [u8; 32] = bytes
        .try_into()
        .map_err(|_| OtaError::new("key", "release public key must be 32 bytes"))?;
    let key = VerifyingKey::from_bytes(&bytes)
        .map_err(|_| OtaError::new("key", "invalid release key"))?;
    if key.is_weak() {
        return Err(OtaError::new("key", "release key is a weak point"));
    }
    Ok(key)
}

fn unavailable() -> OtaError {
    OtaError::new(
        "unavailable",
        "hot updates are disabled in this run; the APK's own UI serves",
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn valid_build_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// A bundle-relative path that cannot leave its directory.
fn safe_relative(path: &str) -> Option<PathBuf> {
    if path.is_empty()
        || path.len() > 240
        || path.contains('\\')
        || path.contains('\0')
        || path.starts_with('/')
    {
        return None;
    }
    let relative = Path::new(path);
    let mut out = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => out.push(part),
            _ => return None,
        }
    }
    (!out.as_os_str().is_empty()).then_some(out)
}

/// The CSP hashes Tauri would have computed for this page's inline scripts at
/// build time (`tauri-codegen`'s `inject_script_hashes`).
pub fn inline_script_hashes(html: &str) -> Vec<String> {
    let lower = html.to_ascii_lowercase();
    let mut hashes = Vec::new();
    let mut cursor = 0;
    while let Some(start) = lower[cursor..].find("<script") {
        let tag_start = cursor + start;
        let Some(tag_end) = lower[tag_start..].find('>').map(|i| tag_start + i + 1) else {
            break;
        };
        let Some(close) = lower[tag_end..].find("</script").map(|i| tag_end + i) else {
            break;
        };
        let attributes = &lower[tag_start + "<script".len()..tag_end - 1];
        let body = &html[tag_end..close];
        if !attributes.contains("src=") && !body.is_empty() {
            let normalized = body.replace("\r\n", "\n").replace('\r', "\n");
            let digest = Sha256::digest(normalized.as_bytes());
            hashes.push(format!("'sha256-{}'", STANDARD.encode(digest)));
        }
        cursor = close + "</script".len();
    }
    hashes
}

/// Makes renames and new entries in `dir` survive a power loss. Android and
/// Linux need this on top of the file's own fsync; elsewhere it is a no-op.
fn sync_dir(dir: &Path) -> OtaResult<()> {
    #[cfg(unix)]
    fs::File::open(dir)?.sync_all()?;
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

fn write_atomic(path: &Path, bytes: &[u8]) -> OtaResult<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, path)?;
    if let Some(parent) = path.parent() {
        sync_dir(parent)?;
    }
    Ok(())
}

impl Slot {
    fn info(&self) -> BundleInfo {
        BundleInfo {
            build_id: self.build_id.clone(),
            version: self.version.clone(),
            notes: self.notes.clone(),
        }
    }
}

impl OtaStore {
    /// Opens the store at process start and decides which UI this run serves.
    pub fn boot(root: PathBuf, embedded: Version, key: VerifyingKey) -> Self {
        let store = Self::new(root, embedded, Some(key));
        if let Err(error) = store.boot_inner() {
            // Any failure here means the APK's own UI, never a half-read bundle.
            log::error!(
                "OTA boot failed, serving the embedded UI: {}",
                error.message
            );
        }
        store
    }

    /// Hot updates off for this run (no data directory or no usable release
    /// key): the embedded UI serves, status says `available: false`, and every
    /// install command fails with code `unavailable`. Nothing touches disk.
    pub fn disabled(embedded: Version) -> Self {
        Self::new(PathBuf::new(), embedded, None)
    }

    fn new(root: PathBuf, embedded: Version, key: Option<VerifyingKey>) -> Self {
        Self {
            root,
            embedded,
            key,
            inner: Mutex::new(Inner {
                state: State::default(),
                staging: None,
            }),
            active: RwLock::new(None),
            retiring: RwLock::new(None),
        }
    }

    fn require_enabled(&self) -> OtaResult<&VerifyingKey> {
        self.key.as_ref().ok_or_else(unavailable)
    }

    fn bundles_dir(&self) -> PathBuf {
        self.root.join("bundles")
    }

    fn manifests_dir(&self) -> PathBuf {
        self.root.join("manifests")
    }

    fn staging_root(&self) -> PathBuf {
        self.root.join("staging")
    }

    fn state_path(&self) -> PathBuf {
        self.root.join("state.json")
    }

    fn bundle_dir(&self, build_id: &str) -> PathBuf {
        self.bundles_dir().join(build_id)
    }

    fn manifest_path(&self, build_id: &str) -> PathBuf {
        self.manifests_dir().join(format!("{build_id}.json"))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn boot_inner(&self) -> OtaResult<()> {
        fs::create_dir_all(self.bundles_dir())?;
        fs::create_dir_all(self.manifests_dir())?;
        // A download interrupted by the last exit starts over.
        let _ = fs::remove_dir_all(self.staging_root());
        let mut inner = self.lock();
        inner.state = match fs::read(self.state_path()) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_default(),
            Err(_) => State::default(),
        };
        prune_bad(&mut inner.state, &self.embedded);
        promote_pending(&mut inner.state);
        while let Some(current) = inner.state.current.clone() {
            if !self.slot_usable(&current, &inner.state) {
                inner.state.current = inner.state.previous.take();
                continue;
            }
            if !current.confirmed {
                if current.attempts >= MAX_UNCONFIRMED_BOOTS {
                    log::error!(
                        "OTA bundle {} never confirmed; rolling back",
                        current.build_id
                    );
                    remember_bad(&mut inner.state, &current.build_id, Some(&current.version));
                    inner.state.current = inner.state.previous.take();
                    continue;
                }
                if let Err(error) = self.check_intact(&current) {
                    // Storage damage, not a bad build: it is not remembered as
                    // bad, so the next check downloads it again.
                    log::error!(
                        "OTA bundle {} failed its integrity check: {}",
                        current.build_id,
                        error.message
                    );
                    inner.state.current = inner.state.previous.take();
                    continue;
                }
                if let Some(slot) = inner.state.current.as_mut() {
                    slot.attempts += 1;
                }
            }
            break;
        }
        if let Some(previous) = inner.state.previous.clone() {
            if !self.slot_usable(&previous, &inner.state) {
                inner.state.previous = None;
            }
        }
        self.save(&inner.state)?;
        self.collect_garbage(&inner.state);
        let current = inner.state.current.clone();
        drop(inner);
        self.activate(current.as_ref(), None);
        Ok(())
    }

    fn slot_usable(&self, slot: &Slot, state: &State) -> bool {
        slot.native_api == NATIVE_API
            && !state.is_bad(&slot.build_id)
            && Version::parse(&slot.version).is_ok_and(|v| v > self.embedded)
            && valid_build_id(&slot.build_id)
            && self.bundle_dir(&slot.build_id).join("index.html").is_file()
    }

    /// Re-hashes every file of an installed bundle against the signed manifest
    /// stored at commit.
    ///
    /// Runs only for a bundle that has not confirmed yet (each probation start
    /// and `apply_now`), so the cost is bounded: at most
    /// [`MAX_UNCONFIRMED_BOOTS`] + 1 passes over at most [`MAX_BUNDLE_BYTES`]
    /// per bundle, then never again once the page confirms. A confirmed bundle
    /// was fsynced and verified before it ever served.
    fn check_intact(&self, slot: &Slot) -> OtaResult<()> {
        let record: ManifestRecord = fs::read(self.manifest_path(&slot.build_id))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .ok_or_else(|| OtaError::new("corrupt", "the stored manifest is missing"))?;
        let manifest = self.verify(&record.manifest, &record.signature)?;
        if manifest.build_id != slot.build_id
            || manifest.version != slot.version
            || manifest.native_api != slot.native_api
        {
            return Err(OtaError::new(
                "corrupt",
                "the stored manifest is for another build",
            ));
        }
        let dir = self.bundle_dir(&slot.build_id);
        for file in &manifest.files {
            let relative = safe_relative(&file.path).expect("verified above");
            let intact = fs::read(dir.join(relative)).is_ok_and(|bytes| {
                bytes.len() as u64 == file.size && sha256_hex(&bytes) == file.sha256
            });
            if !intact {
                return Err(OtaError::new(
                    "corrupt",
                    format!("{} does not match the manifest", file.path),
                ));
            }
        }
        Ok(())
    }

    fn save(&self, state: &State) -> OtaResult<()> {
        let bytes = serde_json::to_vec_pretty(state)
            .map_err(|error| OtaError::new("state", error.to_string()))?;
        write_atomic(&self.state_path(), &bytes)
    }

    fn collect_garbage(&self, state: &State) {
        // What this process serves stays on disk until the next start, even if
        // the state no longer points at it.
        let serving: Vec<String> = [self.active(), self.retiring()]
            .into_iter()
            .flatten()
            .map(|bundle| bundle.build_id.clone())
            .collect();
        let keep: HashSet<&str> = [&state.current, &state.previous, &state.pending]
            .into_iter()
            .flatten()
            .map(|slot| slot.build_id.as_str())
            .chain(serving.iter().map(String::as_str))
            .collect();
        if let Ok(entries) = fs::read_dir(self.bundles_dir()) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if !keep.contains(name.to_string_lossy().as_ref()) {
                    let _ = fs::remove_dir_all(entry.path());
                }
            }
        }
        if let Ok(entries) = fs::read_dir(self.manifests_dir()) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                let id = name.strip_suffix(".json").unwrap_or(&name);
                if !keep.contains(id) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    /// Serves `slot` from now on; `retiring` keeps answering for files the new
    /// bundle lacks until the page confirms (see [`OtaStore::apply_now`]).
    fn activate(&self, slot: Option<&Slot>, retiring: Option<&'static ActiveBundle>) {
        let bundle = slot.and_then(|slot| {
            let dir = self.bundle_dir(&slot.build_id);
            let html = fs::read_to_string(dir.join("index.html")).ok()?;
            Some(&*Box::leak(Box::new(ActiveBundle {
                build_id: slot.build_id.clone(),
                version: slot.version.clone(),
                script_hashes: inline_script_hashes(&html),
                dir,
            })))
        });
        // Each activation leaks one small record; a process sees at most a few.
        *self
            .retiring
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = retiring;
        *self
            .active
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = bundle;
    }

    pub fn active(&self) -> Option<&'static ActiveBundle> {
        *self
            .active
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn retiring(&self) -> Option<&'static ActiveBundle> {
        *self
            .retiring
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Reads one file of the active bundle; `None` means "serve the embedded UI".
    ///
    /// Right after `apply_now`, a file the new bundle lacks comes from the
    /// bundle the old page was loaded from, so that page's lazy chunks keep
    /// loading until it reloads. Vite names chunks by content hash, so a name
    /// present in both bundles has the same bytes in both.
    pub fn read_active(&self, key: &str) -> Option<(&'static ActiveBundle, Vec<u8>)> {
        let bundle = self.active()?;
        let relative = safe_relative(key.trim_start_matches('/'))?;
        [Some(bundle), self.retiring()]
            .into_iter()
            .flatten()
            .find_map(|bundle| {
                fs::read(bundle.dir.join(&relative))
                    .ok()
                    .map(|bytes| (bundle, bytes))
            })
    }

    pub fn status(&self) -> OtaStatus {
        let inner = self.lock();
        let active = self.active();
        OtaStatus {
            available: self.key.is_some(),
            native_api: NATIVE_API,
            embedded_version: self.embedded.to_string(),
            active: active.map(|bundle| BundleInfo {
                build_id: bundle.build_id.clone(),
                version: bundle.version.clone(),
                notes: inner
                    .state
                    .current
                    .as_ref()
                    .filter(|slot| slot.build_id == bundle.build_id)
                    .and_then(|slot| slot.notes.clone()),
            }),
            pending: inner.state.pending.as_ref().map(Slot::info),
            confirmed: match (active, inner.state.current.as_ref()) {
                (None, _) => true,
                (Some(bundle), Some(slot)) => slot.build_id == bundle.build_id && slot.confirmed,
                (Some(_), None) => false,
            },
        }
    }

    fn verify(&self, manifest_text: &str, signature: &str) -> OtaResult<Manifest> {
        let key = self.require_enabled()?;
        let signature = STANDARD
            .decode(signature.trim())
            .map_err(|_| OtaError::new("signature", "signature is not base64"))?;
        let signature = Signature::from_slice(&signature)
            .map_err(|_| OtaError::new("signature", "signature has the wrong length"))?;
        // Strict: rejects weak keys and non-canonical / small-order signatures
        // that plain `verify` would let through.
        key.verify_strict(manifest_text.as_bytes(), &signature)
            .map_err(|_| OtaError::new("signature", "manifest signature does not verify"))?;
        let manifest: Manifest = serde_json::from_str(manifest_text)
            .map_err(|error| OtaError::new("manifest", error.to_string()))?;
        if manifest.schema != MANIFEST_SCHEMA {
            return Err(OtaError::new("manifest", "unsupported manifest schema"));
        }
        if !valid_build_id(&manifest.build_id) {
            return Err(OtaError::new("manifest", "invalid build id"));
        }
        Version::parse(&manifest.version)
            .map_err(|_| OtaError::new("manifest", "invalid version"))?;
        if manifest.files.is_empty() || manifest.files.len() > MAX_FILES {
            return Err(OtaError::new("manifest", "bad file count"));
        }
        let mut seen = HashSet::new();
        let mut total = 0u64;
        for file in &manifest.files {
            if safe_relative(&file.path).is_none() || !seen.insert(file.path.as_str()) {
                return Err(OtaError::new("manifest", format!("bad path {}", file.path)));
            }
            if file.sha256.len() != 64 || !file.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(OtaError::new("manifest", "bad file hash"));
            }
            total = total.saturating_add(file.size);
        }
        if !seen.contains("index.html") {
            return Err(OtaError::new("manifest", "bundle has no index.html"));
        }
        if total > MAX_BUNDLE_BYTES {
            return Err(OtaError::new("manifest", "bundle too large"));
        }
        Ok(manifest)
    }

    /// Starts installing the release described by a signed manifest.
    pub fn begin(&self, manifest_text: &str, signature: &str) -> OtaResult<BeginResult> {
        let manifest = self.verify(manifest_text, signature)?;
        let mut inner = self.lock();
        let reload_required = self.apply_revocations(&mut inner.state, &manifest.revoked)?;
        let result = |action, missing| BeginResult {
            action,
            build_id: manifest.build_id.clone(),
            version: manifest.version.clone(),
            missing,
            reload_required,
        };
        if manifest.native_api != NATIVE_API {
            return Ok(result(BeginAction::NativeMismatch, Vec::new()));
        }
        let version = Version::parse(&manifest.version).expect("verified above");
        if inner.state.is_bad(&manifest.build_id) {
            // The signed manifest tells us the build's version, which lets the
            // entry be pruned once an APK update makes it moot.
            let entry = inner
                .state
                .bad
                .iter_mut()
                .find(|entry| entry.build_id == manifest.build_id && entry.version.is_none());
            if let Some(entry) = entry {
                entry.version = Some(manifest.version.clone());
                self.save(&inner.state)?;
            }
            inner.staging = None;
            return Ok(result(BeginAction::UpToDate, Vec::new()));
        }
        let installed = [&inner.state.current, &inner.state.pending]
            .into_iter()
            .flatten()
            .filter_map(|slot| Version::parse(&slot.version).ok())
            .max();
        let newest = installed.map_or(self.embedded.clone(), |v| v.max(self.embedded.clone()));
        if version <= newest {
            inner.staging = None;
            return Ok(result(BeginAction::UpToDate, Vec::new()));
        }

        // Resume a download of the same build; anything else starts fresh.
        let same = inner
            .staging
            .as_ref()
            .is_some_and(|staging| staging.manifest.build_id == manifest.build_id);
        if !same {
            let dir = self.staging_root().join(&manifest.build_id);
            let _ = fs::remove_dir_all(self.staging_root());
            fs::create_dir_all(&dir)?;
            let mut written = HashSet::new();
            // Unchanged files are copied from the running bundle instead of downloaded.
            if let Some(active) = self.active() {
                for file in &manifest.files {
                    let relative = safe_relative(&file.path).expect("verified above");
                    if let Ok(bytes) = fs::read(active.dir.join(&relative)) {
                        if bytes.len() as u64 == file.size && sha256_hex(&bytes) == file.sha256 {
                            write_file(&dir, &relative, &bytes)?;
                            written.insert(file.path.clone());
                        }
                    }
                }
            }
            inner.staging = Some(Staging {
                manifest: manifest.clone(),
                record: ManifestRecord {
                    manifest: manifest_text.to_string(),
                    signature: signature.to_string(),
                },
                dir,
                written,
            });
        }
        let staging = inner.staging.as_ref().expect("set above");
        let missing = manifest
            .files
            .iter()
            .filter(|file| !staging.written.contains(&file.path))
            .map(|file| file.path.clone())
            .collect();
        Ok(result(BeginAction::Download, missing))
    }

    fn apply_revocations(&self, state: &mut State, revoked: &[String]) -> OtaResult<bool> {
        if revoked.is_empty() {
            return Ok(false);
        }
        let mut changed = false;
        for id in revoked {
            if valid_build_id(id) && !state.is_bad(id) {
                // The installed slot, if any, knows the revoked build's version.
                let version = [&state.current, &state.previous, &state.pending]
                    .into_iter()
                    .flatten()
                    .find(|slot| &slot.build_id == id)
                    .map(|slot| slot.version.clone());
                remember_bad(state, id, version.as_deref());
                changed = true;
            }
        }
        if state
            .pending
            .as_ref()
            .is_some_and(|slot| state.is_bad(&slot.build_id))
        {
            state.pending = None;
        }
        if state
            .previous
            .as_ref()
            .is_some_and(|slot| state.is_bad(&slot.build_id))
        {
            state.previous = None;
        }
        let mut reload = false;
        if state
            .current
            .as_ref()
            .is_some_and(|slot| state.is_bad(&slot.build_id))
        {
            state.current = state.previous.take();
            reload = true;
        }
        if changed {
            self.save(state)?;
        }
        if reload {
            let current = state.current.clone();
            // A revoked bundle stops answering at once, even for old chunks.
            self.activate(current.as_ref(), None);
        }
        Ok(reload)
    }

    /// Stores one downloaded file after checking it against the manifest.
    pub fn write(&self, build_id: &str, path: &str, bytes: &[u8]) -> OtaResult<()> {
        self.require_enabled()?;
        let mut inner = self.lock();
        let staging = inner
            .staging
            .as_mut()
            .filter(|staging| staging.manifest.build_id == build_id)
            .ok_or_else(|| OtaError::new("staging", "no download in progress for this build"))?;
        let file = staging
            .manifest
            .files
            .iter()
            .find(|file| file.path == path)
            .ok_or_else(|| OtaError::new("staging", format!("{path} is not in the manifest")))?;
        if bytes.len() as u64 != file.size || sha256_hex(bytes) != file.sha256 {
            return Err(OtaError::new(
                "hash",
                format!("{path} does not match the manifest"),
            ));
        }
        let relative = safe_relative(path).expect("verified above");
        write_file(&staging.dir, &relative, bytes)?;
        staging.written.insert(file.path.clone());
        Ok(())
    }

    /// Finishes the download: the bundle becomes pending for the next start.
    ///
    /// Order matters for power loss: every file and directory of the bundle is
    /// fsynced, then the bundle is renamed into place, then its signed
    /// manifest is stored, and only then does `state.json` name it pending.
    pub fn commit(&self, build_id: &str) -> OtaResult<BundleInfo> {
        self.require_enabled()?;
        let mut inner = self.lock();
        let staging = inner
            .staging
            .take()
            .filter(|staging| staging.manifest.build_id == build_id)
            .ok_or_else(|| OtaError::new("staging", "no download in progress for this build"))?;
        let mut dirs = HashSet::new();
        for file in &staging.manifest.files {
            let relative = safe_relative(&file.path).expect("verified above");
            let path = staging.dir.join(&relative);
            let bytes = fs::read(&path).map_err(|_| {
                OtaError::new("staging", format!("{} was not downloaded", file.path))
            })?;
            if bytes.len() as u64 != file.size || sha256_hex(&bytes) != file.sha256 {
                return Err(OtaError::new(
                    "hash",
                    format!("{} changed on disk", file.path),
                ));
            }
            // Each directory between the file and the bundle root holds a new entry.
            let mut parent = path.parent();
            while let Some(dir) = parent.filter(|dir| dir.starts_with(&staging.dir)) {
                if !dirs.insert(dir.to_path_buf()) {
                    break;
                }
                parent = dir.parent();
            }
        }
        for dir in &dirs {
            sync_dir(dir)?;
        }
        let target = self.bundle_dir(build_id);
        let _ = fs::remove_dir_all(&target);
        fs::create_dir_all(self.bundles_dir())?;
        fs::rename(&staging.dir, &target)?;
        sync_dir(&self.bundles_dir())?;
        let _ = fs::remove_dir_all(self.staging_root());
        fs::create_dir_all(self.manifests_dir())?;
        let record = serde_json::to_vec(&staging.record)
            .map_err(|error| OtaError::new("state", error.to_string()))?;
        write_atomic(&self.manifest_path(build_id), &record)?;
        let slot = Slot {
            build_id: staging.manifest.build_id.clone(),
            version: staging.manifest.version.clone(),
            native_api: staging.manifest.native_api,
            confirmed: false,
            attempts: 0,
            notes: staging.manifest.notes.clone(),
        };
        inner.state.pending = Some(slot.clone());
        self.save(&inner.state)?;
        self.collect_garbage(&inner.state);
        Ok(slot.info())
    }

    /// Switches this process to the pending bundle; the page reloads itself next.
    ///
    /// The page that asked is still loaded from the old bundle until that
    /// reload, so the old bundle keeps answering for files the new one lacks
    /// (see [`OtaStore::read_active`]) until the new page confirms.
    pub fn apply_now(&self) -> OtaResult<bool> {
        self.require_enabled()?;
        let mut inner = self.lock();
        let Some(pending) = inner.state.pending.clone() else {
            return Ok(false);
        };
        // The pending bundle may come from an earlier run that lost power.
        if let Err(error) = self.check_intact(&pending) {
            inner.state.pending = None;
            self.save(&inner.state)?;
            self.collect_garbage(&inner.state);
            return Err(error);
        }
        promote_pending(&mut inner.state);
        if let Some(slot) = inner.state.current.as_mut() {
            slot.attempts = 1; // This run counts as its first start.
        }
        self.save(&inner.state)?;
        let current = inner.state.current.clone();
        // Activate before collecting garbage, so the retiring bundle is kept.
        self.activate(current.as_ref(), self.active());
        self.collect_garbage(&inner.state);
        drop(inner);
        Ok(true)
    }

    /// The page calls this once the bundle it was built as has rendered.
    pub fn confirm(&self, build_id: &str) -> OtaResult<bool> {
        let mut inner = self.lock();
        let Some(slot) = inner.state.current.as_mut() else {
            return Ok(false);
        };
        let running = self
            .active()
            .is_some_and(|bundle| bundle.build_id == build_id);
        if slot.build_id != build_id || !running {
            return Ok(false);
        }
        // The page now runs from the new bundle; the old one stops answering.
        *self
            .retiring
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        if !slot.confirmed {
            slot.confirmed = true;
            slot.attempts = 0;
            self.save(&inner.state)?;
        }
        Ok(true)
    }

    /// Drops every installed bundle; the APK's own UI serves after a reload.
    pub fn reset(&self) -> OtaResult<()> {
        self.require_enabled()?;
        let mut inner = self.lock();
        let mut state = State {
            bad: std::mem::take(&mut inner.state.bad),
            ..State::default()
        };
        // A reset bundle must not come straight back on the next check.
        for slot in [&inner.state.current, &inner.state.pending]
            .into_iter()
            .flatten()
        {
            remember_bad(&mut state, &slot.build_id, Some(&slot.version));
        }
        inner.state = state;
        inner.staging = None;
        let _ = fs::remove_dir_all(self.staging_root());
        self.save(&inner.state)?;
        self.activate(None, None);
        self.collect_garbage(&inner.state);
        drop(inner);
        Ok(())
    }
}

/// Writes one bundle file durably: its bytes are fsynced before the rename,
/// and [`OtaStore::commit`] fsyncs the directories before the bundle counts.
fn write_file(dir: &Path, relative: &Path, bytes: &[u8]) -> OtaResult<()> {
    let target = dir.join(relative);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = target.with_extension("part");
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, &target)?;
    Ok(())
}

fn promote_pending(state: &mut State) {
    let Some(pending) = state.pending.take() else {
        return;
    };
    match state.current.take() {
        // Only a bundle that proved itself is worth falling back to.
        Some(current) if current.confirmed => state.previous = Some(current),
        _ => {}
    }
    state.current = Some(pending);
}

/// Never forgets a build on its own: entries leave only through
/// [`prune_bad`], once the build could not be installed anyway. The list only
/// grows from signed revocations and this device's own failed or reset
/// installs, so its size follows the release history, not an attacker.
fn remember_bad(state: &mut State, build_id: &str, version: Option<&str>) {
    match state
        .bad
        .iter_mut()
        .find(|entry| entry.build_id == build_id)
    {
        Some(entry) => {
            if entry.version.is_none() {
                entry.version = version.map(str::to_string);
            }
        }
        None => state.bad.push(BadBuild {
            build_id: build_id.to_string(),
            version: version.map(str::to_string),
        }),
    }
}

/// Drops entries for builds no newer than the embedded UI: `begin` and
/// `slot_usable` refuse those regardless, and the embedded version only rises
/// (with an APK update). The floor is deliberately not the installed bundle's
/// version, which can fall again on a rollback or revocation. Entries whose
/// version is unknown are kept.
fn prune_bad(state: &mut State, embedded: &Version) {
    state.bad.retain(|entry| {
        entry
            .version
            .as_deref()
            .and_then(|version| Version::parse(version).ok())
            .is_none_or(|version| version > *embedded)
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    const KEY: [u8; 32] = [7; 32];

    fn signer() -> SigningKey {
        SigningKey::from_bytes(&KEY)
    }

    fn temp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nuller-ota-test-{name}-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn store(root: &Path) -> OtaStore {
        OtaStore::boot(
            root.to_path_buf(),
            Version::parse("7.1.0").unwrap(),
            signer().verifying_key(),
        )
    }

    struct Release {
        text: String,
        signature: String,
        files: Vec<(String, Vec<u8>)>,
    }

    fn release(version: &str, build_id: &str, native_api: u32, revoked: &[&str]) -> Release {
        release_with(version, build_id, native_api, revoked, &[])
    }

    fn release_with(
        version: &str,
        build_id: &str,
        native_api: u32,
        revoked: &[&str],
        extra: &[(&str, &[u8])],
    ) -> Release {
        let mut files = vec![
            (
                "index.html".to_string(),
                format!("<html><script>var v='{version}'</script><script src=\"/assets/app.js\"></script></html>")
                    .into_bytes(),
            ),
            ("assets/app.js".to_string(), format!("console.log('{version}')").into_bytes()),
            ("assets/shared.css".to_string(), b"body{}".to_vec()),
        ];
        files.extend(
            extra
                .iter()
                .map(|(path, bytes)| (path.to_string(), bytes.to_vec())),
        );
        let entries: Vec<_> = files
            .iter()
            .map(|(path, bytes)| {
                serde_json::json!({ "path": path, "sha256": sha256_hex(bytes), "size": bytes.len() })
            })
            .collect();
        let text = serde_json::json!({
            "schema": 1,
            "version": version,
            "buildId": build_id,
            "nativeApi": native_api,
            "files": entries,
            "revoked": revoked,
            "notes": "test",
        })
        .to_string();
        let signature = STANDARD.encode(signer().sign(text.as_bytes()).to_bytes());
        Release {
            text,
            signature,
            files,
        }
    }

    fn install(store: &OtaStore, release: &Release) -> BeginResult {
        let begin = store.begin(&release.text, &release.signature).unwrap();
        if begin.action == BeginAction::Download {
            for path in &begin.missing {
                let bytes = &release.files.iter().find(|(p, _)| p == path).unwrap().1;
                store.write(&begin.build_id, path, bytes).unwrap();
            }
            store.commit(&begin.build_id).unwrap();
        }
        begin
    }

    fn served(store: &OtaStore) -> Option<String> {
        store
            .read_active("/assets/app.js")
            .map(|(_, bytes)| String::from_utf8(bytes).unwrap())
    }

    #[test]
    fn installs_on_next_start_and_survives_after_confirm() {
        let root = temp_root("happy");
        let first = store(&root);
        assert_eq!(served(&first), None);
        install(&first, &release("7.1.1", "b1", NATIVE_API, &[]));
        // The running process keeps the UI it started with.
        assert_eq!(served(&first), None);
        assert_eq!(first.status().pending.unwrap().version, "7.1.1");

        let second = store(&root);
        assert_eq!(served(&second).as_deref(), Some("console.log('7.1.1')"));
        assert!(!second.status().confirmed);
        assert!(second.confirm("b1").unwrap());
        assert!(second.status().confirmed);

        for _ in 0..5 {
            assert_eq!(
                served(&store(&root)).as_deref(),
                Some("console.log('7.1.1')")
            );
        }
    }

    #[test]
    fn rolls_back_a_bundle_that_never_confirms() {
        let root = temp_root("rollback");
        install(&store(&root), &release("7.1.1", "good", NATIVE_API, &[]));
        store(&root).confirm("good").unwrap();
        install(&store(&root), &release("7.1.2", "broken", NATIVE_API, &[]));
        for _ in 0..MAX_UNCONFIRMED_BOOTS {
            assert_eq!(
                served(&store(&root)).as_deref(),
                Some("console.log('7.1.2')")
            );
        }
        // Next start: back to the last confirmed bundle, and the broken one stays out.
        let restored = store(&root);
        assert_eq!(served(&restored).as_deref(), Some("console.log('7.1.1')"));
        let again = install(&restored, &release("7.1.2", "broken", NATIVE_API, &[]));
        assert_eq!(again.action, BeginAction::UpToDate);
    }

    #[test]
    fn rejects_forged_tampered_old_and_foreign_native_bundles() {
        let root = temp_root("reject");
        let store = store(&root);
        let good = release("7.1.1", "b1", NATIVE_API, &[]);

        let tampered = good.text.replace("7.1.1", "7.9.9");
        assert_eq!(
            store.begin(&tampered, &good.signature).unwrap_err().code,
            "signature"
        );

        let other = SigningKey::from_bytes(&[9; 32]);
        let forged = STANDARD.encode(other.sign(good.text.as_bytes()).to_bytes());
        assert_eq!(
            store.begin(&good.text, &forged).unwrap_err().code,
            "signature"
        );

        let old = release("7.1.0", "old", NATIVE_API, &[]);
        assert_eq!(
            store.begin(&old.text, &old.signature).unwrap().action,
            BeginAction::UpToDate
        );

        let native = release("7.2.0", "n2", NATIVE_API + 1, &[]);
        assert_eq!(
            store.begin(&native.text, &native.signature).unwrap().action,
            BeginAction::NativeMismatch
        );

        let begin = store.begin(&good.text, &good.signature).unwrap();
        assert_eq!(
            store
                .write("b1", "assets/app.js", b"evil")
                .unwrap_err()
                .code,
            "hash"
        );
        assert_eq!(store.commit(&begin.build_id).unwrap_err().code, "staging");
    }

    #[test]
    fn rejects_paths_that_escape_the_bundle() {
        for bad in ["../x", "/etc/passwd", "a/../../b", "a\\b", "", "./a/../.."] {
            assert!(safe_relative(bad).is_none(), "{bad}");
        }
        assert!(safe_relative("assets/index-C6frYRNB.js").is_some());

        let root = temp_root("paths");
        let store = store(&root);
        let text = serde_json::json!({
            "schema": 1, "version": "7.1.1", "buildId": "p1", "nativeApi": NATIVE_API,
            "files": [
                { "path": "index.html", "sha256": "0".repeat(64), "size": 1 },
                { "path": "../../escape", "sha256": "0".repeat(64), "size": 1 },
            ],
        })
        .to_string();
        let signature = STANDARD.encode(signer().sign(text.as_bytes()).to_bytes());
        assert_eq!(store.begin(&text, &signature).unwrap_err().code, "manifest");
        assert!(store.read_active("/../state.json").is_none());
    }

    #[test]
    fn a_newer_apk_retires_older_bundles() {
        let root = temp_root("apk");
        install(&store(&root), &release("7.1.1", "b1", NATIVE_API, &[]));
        let newer_apk = OtaStore::boot(
            root.clone(),
            Version::parse("7.2.0").unwrap(),
            signer().verifying_key(),
        );
        assert_eq!(served(&newer_apk), None);
        assert!(!root.join("bundles/b1").exists());
    }

    #[test]
    fn revocation_drops_the_running_bundle() {
        let root = temp_root("revoke");
        install(&store(&root), &release("7.1.1", "ok", NATIVE_API, &[]));
        store(&root).confirm("ok").unwrap();
        install(&store(&root), &release("7.1.2", "bad", NATIVE_API, &[]));
        let running = store(&root);
        running.confirm("bad").unwrap();
        assert_eq!(served(&running).as_deref(), Some("console.log('7.1.2')"));

        let fix = release("7.1.3", "fix", NATIVE_API, &["bad"]);
        let begin = running.begin(&fix.text, &fix.signature).unwrap();
        assert!(begin.reload_required);
        assert_eq!(served(&running).as_deref(), Some("console.log('7.1.1')"));
        // Unchanged files come from the running bundle, so only changed ones download.
        assert!(!begin.missing.contains(&"assets/shared.css".to_string()));
    }

    #[test]
    fn apply_now_switches_and_reset_restores_the_embedded_ui() {
        let root = temp_root("apply");
        let running = store(&root);
        install(&running, &release("7.1.1", "b1", NATIVE_API, &[]));
        assert!(running.apply_now().unwrap());
        assert_eq!(served(&running).as_deref(), Some("console.log('7.1.1')"));
        assert!(running.confirm("b1").unwrap());

        running.reset().unwrap();
        assert_eq!(served(&running), None);
        assert_eq!(served(&store(&root)), None);
        let again = install(&store(&root), &release("7.1.1", "b1", NATIVE_API, &[]));
        assert_eq!(again.action, BeginAction::UpToDate);
    }

    #[test]
    fn confirm_ignores_a_page_from_another_build() {
        let root = temp_root("confirm");
        install(&store(&root), &release("7.1.1", "b1", NATIVE_API, &[]));
        let running = store(&root);
        assert!(!running.confirm("embedded-build").unwrap());
        assert!(!running.status().confirmed);
    }

    #[test]
    fn hashes_inline_scripts_like_tauri_codegen() {
        let html = "<script>a\r\nb</script><script type=\"module\" src=\"/x.js\"></script><SCRIPT>c</SCRIPT><script></script>";
        let expected: Vec<String> = ["a\nb", "c"]
            .iter()
            .map(|body| {
                format!(
                    "'sha256-{}'",
                    STANDARD.encode(Sha256::digest(body.as_bytes()))
                )
            })
            .collect();
        assert_eq!(inline_script_hashes(html), expected);
    }

    fn corrupt(root: &Path, build_id: &str) {
        fs::write(
            root.join("bundles").join(build_id).join("assets/app.js"),
            b"torn",
        )
        .unwrap();
    }

    #[test]
    fn a_torn_bundle_on_probation_never_serves_and_downloads_again() {
        let root = temp_root("torn");
        install(&store(&root), &release("7.1.1", "b1", NATIVE_API, &[]));
        assert!(root.join("manifests/b1.json").is_file());
        corrupt(&root, "b1");
        let booted = store(&root);
        assert_eq!(served(&booted), None);
        // Storage damage is not a bad build: the next check fetches it again.
        let again = install(&booted, &release("7.1.1", "b1", NATIVE_API, &[]));
        assert_eq!(again.action, BeginAction::Download);
        assert_eq!(
            served(&store(&root)).as_deref(),
            Some("console.log('7.1.1')")
        );
    }

    #[test]
    fn a_torn_bundle_falls_back_to_the_last_confirmed_one() {
        let root = temp_root("torn-previous");
        install(&store(&root), &release("7.1.1", "good", NATIVE_API, &[]));
        store(&root).confirm("good").unwrap();
        install(&store(&root), &release("7.1.2", "next", NATIVE_API, &[]));
        corrupt(&root, "next");
        assert_eq!(
            served(&store(&root)).as_deref(),
            Some("console.log('7.1.1')")
        );
    }

    #[test]
    fn a_bundle_without_its_signed_manifest_does_not_serve() {
        let root = temp_root("no-manifest");
        install(&store(&root), &release("7.1.1", "b1", NATIVE_API, &[]));
        fs::remove_file(root.join("manifests/b1.json")).unwrap();
        assert_eq!(served(&store(&root)), None);
    }

    #[test]
    fn apply_now_refuses_a_torn_pending_bundle() {
        let root = temp_root("torn-apply");
        let running = store(&root);
        install(&running, &release("7.1.1", "b1", NATIVE_API, &[]));
        corrupt(&root, "b1");
        assert_eq!(running.apply_now().unwrap_err().code, "corrupt");
        assert_eq!(served(&running), None);
        assert_eq!(running.status().pending, None);
        assert_eq!(served(&store(&root)), None);
    }

    #[test]
    fn a_disabled_store_serves_the_embedded_ui_and_refuses_installs() {
        let disabled = OtaStore::disabled(Version::parse("7.1.0").unwrap());
        let status = disabled.status();
        assert!(!status.available);
        assert_eq!(status.embedded_version, "7.1.0");
        assert_eq!(status.active, None);
        let good = release("7.1.1", "b1", NATIVE_API, &[]);
        let code = |result: OtaResult<()>| result.unwrap_err().code;
        assert_eq!(
            code(disabled.begin(&good.text, &good.signature).map(drop)),
            "unavailable"
        );
        assert_eq!(
            code(disabled.write("b1", "index.html", b"x")),
            "unavailable"
        );
        assert_eq!(code(disabled.commit("b1").map(drop)), "unavailable");
        assert_eq!(code(disabled.apply_now().map(drop)), "unavailable");
        assert_eq!(code(disabled.reset()), "unavailable");
        assert!(!disabled.confirm("b1").unwrap());
        assert!(disabled.read_active("/index.html").is_none());
        assert!(store(&temp_root("enabled")).status().available);
    }

    #[test]
    fn signatures_are_checked_strictly() {
        use ed25519_dalek::Verifier;
        // The identity point as a public key, with R = identity and s = 0,
        // satisfies the plain verification equation for every message.
        let mut identity = [0u8; 32];
        identity[0] = 1;
        let weak = VerifyingKey::from_bytes(&identity).unwrap();
        let mut forged = [0u8; 64];
        forged[0] = 1;
        let forged = Signature::from_bytes(&forged);
        let good = release("7.1.1", "b1", NATIVE_API, &[]);
        assert!(weak.verify(good.text.as_bytes(), &forged).is_ok());

        let root = temp_root("strict");
        let store = OtaStore::boot(root, Version::parse("7.1.0").unwrap(), weak);
        let signature = STANDARD.encode(forged.to_bytes());
        assert_eq!(
            store.begin(&good.text, &signature).unwrap_err().code,
            "signature"
        );
    }

    #[test]
    fn revoked_builds_are_not_forgotten_past_the_old_cap() {
        let root = temp_root("many-bad");
        let ids: Vec<String> = (0..40).map(|i| format!("r{i}")).collect();
        let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
        install(&store(&root), &release("7.1.1", "fix", NATIVE_API, &ids));
        let rebooted = store(&root);
        for id in ["r0", "r39"] {
            let replay = install(&rebooted, &release("7.9.0", id, NATIVE_API, &[]));
            assert_eq!(replay.action, BeginAction::UpToDate, "{id}");
        }
    }

    #[test]
    fn bad_builds_are_pruned_only_below_the_embedded_ui() {
        let root = temp_root("prune");
        fs::create_dir_all(&root).unwrap();
        // Legacy state: bare build ids next to versioned entries.
        fs::write(
            root.join("state.json"),
            r#"{"current":null,"previous":null,"pending":null,"bad":["legacy",{"buildId":"old","version":"7.1.1"},{"buildId":"new","version":"7.3.0"}]}"#,
        )
        .unwrap();
        let newer_apk = OtaStore::boot(
            root.clone(),
            Version::parse("7.2.0").unwrap(),
            signer().verifying_key(),
        );
        let state: State =
            serde_json::from_slice(&fs::read(root.join("state.json")).unwrap()).unwrap();
        let kept: Vec<&str> = state.bad.iter().map(|b| b.build_id.as_str()).collect();
        assert_eq!(kept, ["legacy", "new"]);
        for id in ["legacy", "new"] {
            let replay = install(&newer_apk, &release("7.4.0", id, NATIVE_API, &[]));
            assert_eq!(replay.action, BeginAction::UpToDate, "{id}");
        }
    }

    #[test]
    fn apply_now_keeps_the_old_pages_chunks_until_the_new_page_confirms() {
        let root = temp_root("apply-chunks");
        let first = release_with(
            "7.1.1",
            "a",
            NATIVE_API,
            &[],
            &[("assets/chunk-a.js", b"a")],
        );
        install(&store(&root), &first);
        // "a" is still on probation, so the state alone would not keep it.
        let running = store(&root);
        install(&running, &release("7.1.2", "b", NATIVE_API, &[]));
        assert!(running.apply_now().unwrap());
        let index = running.read_active("/index.html").unwrap().1;
        assert!(String::from_utf8(index).unwrap().contains("7.1.2"));
        assert_eq!(served(&running).as_deref(), Some("console.log('7.1.2')"));
        assert_eq!(running.read_active("/assets/chunk-a.js").unwrap().1, b"a");
        assert!(root.join("bundles/a").is_dir());

        assert!(running.confirm("b").unwrap());
        assert!(running.read_active("/assets/chunk-a.js").is_none());
        store(&root);
        assert!(!root.join("bundles/a").exists());
    }

    #[test]
    fn the_release_key_is_well_formed() {
        release_key().unwrap();
    }
}
