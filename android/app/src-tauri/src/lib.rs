use std::borrow::Cow;
use std::sync::{Arc, OnceLock};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Emitter, Manager, RunEvent, Runtime, State, WebviewWindowBuilder};

mod android_lifecycle;
mod ota;
mod scan_coordinator;

use ota::{BeginResult, BundleInfo, OtaError, OtaStatus, OtaStore};

/// Serves the installed hot-update bundle when there is one, the APK's own UI
/// otherwise. Both answer on the same `tauri.localhost` origin.
struct OtaAssets<R: Runtime> {
    embedded: Box<dyn Assets<R>>,
    store: Arc<OnceLock<Arc<OtaStore>>>,
}

impl<R: Runtime> Assets<R> for OtaAssets<R> {
    fn setup(&self, app: &tauri::App<R>) {
        self.embedded.setup(app);
        let embedded = app.package_info().version.to_string();
        let embedded = semver::Version::parse(&embedded).expect("Tauri package version is semver");
        let store = match (app.path().app_data_dir(), ota::release_key()) {
            (Ok(dir), Ok(key)) => OtaStore::boot(dir.join("ota"), embedded, key),
            (dir, key) => {
                log::error!(
                    "OTA unavailable (data dir: {}, key: {})",
                    dir.is_ok(),
                    key.is_ok()
                );
                // Hot updates stay off for this run: the APK's own UI serves,
                // status reports `available: false`, install commands fail.
                OtaStore::disabled(embedded)
            }
        };
        let store = Arc::new(store);
        let _ = self.store.set(store.clone());
        app.manage(store);
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        if let Some(store) = self.store.get() {
            if store.active().is_some() {
                if let Some((_, bytes)) = store.read_active(key.as_ref()) {
                    return Some(Cow::Owned(bytes));
                }
                // The APK's own page can still be loading its lazy chunks in the moment between
                // `apply_now` switching bundles and the reload. Content-hashed build output only
                // ever names one build's files, so serving the APK's copy cannot mix builds.
                if !is_hashed_build_asset(key.as_ref()) {
                    return None;
                }
            }
        }
        self.embedded.get(key)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.embedded.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        let embedded = self.embedded.csp_hashes(html_path);
        let bundle = self
            .store
            .get()
            .and_then(|store| store.active())
            .filter(|_| html_path.as_ref().ends_with(".html"));
        match bundle {
            Some(bundle) => Box::new(
                embedded.chain(
                    bundle
                        .script_hashes()
                        .iter()
                        .map(|hash| CspHash::Script(hash.as_str())),
                ),
            ),
            None => embedded,
        }
    }
}

type Store<'a> = State<'a, Arc<OtaStore>>;

#[tauri::command]
fn ota_status(store: Store<'_>) -> OtaStatus {
    store.status()
}

#[tauri::command]
fn ota_begin(
    store: Store<'_>,
    manifest: String,
    signature: String,
) -> Result<BeginResult, OtaError> {
    store.begin(&manifest, &signature)
}

/// One downloaded file, base64 in JSON: Android's IPC bridge carries JSON, not raw bytes.
#[tauri::command]
fn ota_write(
    store: Store<'_>,
    build_id: String,
    path: String,
    data: String,
) -> Result<(), OtaError> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| OtaError::new("request", "file data is not base64"))?;
    store.write(&build_id, &path, &bytes)
}

#[tauri::command]
fn ota_commit(store: Store<'_>, build_id: String) -> Result<BundleInfo, OtaError> {
    store.commit(&build_id)
}

#[tauri::command]
fn ota_apply_now(store: Store<'_>) -> Result<bool, OtaError> {
    store.apply_now()
}

#[tauri::command]
fn ota_confirm(store: Store<'_>, build_id: String) -> Result<bool, OtaError> {
    store.confirm(&build_id)
}

#[tauri::command]
fn ota_reset(store: Store<'_>) -> Result<(), OtaError> {
    store.reset()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_blec::init())
        .plugin(tauri_plugin_opener::init());

    let builder = scan_coordinator::register(builder).invoke_handler(tauri::generate_handler![
        scan_coordinator::dg_blec_claim_scanner,
        scan_coordinator::dg_blec_release_scanner,
        ota_status,
        ota_begin,
        ota_write,
        ota_commit,
        ota_apply_now,
        ota_confirm,
        ota_reset,
    ]);

    let mut context = tauri::generate_context!();
    let store = Arc::new(OnceLock::new());
    let embedded = context.set_assets(Box::new(OtaAssetsPlaceholder));
    context.set_assets(Box::new(OtaAssets {
        embedded,
        store: store.clone(),
    }));

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // The window is created here, after the asset provider has chosen which
            // UI this run serves (`create: false` in tauri.conf.json); Tauri would
            // otherwise open it before `Assets::setup` runs.
            for config in app.config().app.windows.clone() {
                WebviewWindowBuilder::from_config(app.handle(), &config)?.build()?;
            }
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app, event| {
            // Emit an `app://paused` event to the webview on exit so the JS
            // lifecycle-safety wrapper can fire emergencyStop. Android's native
            // onPause is not a stable Tauri 2.10 RunEvent variant; backgrounding
            // is covered by the JS-side `visibilitychange` listener instead,
            // which Android WebView fires reliably when its host activity
            // transitions to onPause.
            if let RunEvent::ExitRequested { .. } = event {
                let _ = app.emit("app://paused", ());
            }
        });
}

/// Vite's content-hashed output (`/assets/<name>-<hash>.<ext>`).
fn is_hashed_build_asset(key: &str) -> bool {
    key.trim_start_matches('/').starts_with("assets/")
}

/// Momentary stand-in while the embedded assets move into [`OtaAssets`].
struct OtaAssetsPlaceholder;

impl<R: Runtime> Assets<R> for OtaAssetsPlaceholder {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
