//! JNI entries for the Android activity and the background keep service.
//!
//! Two separate entries, so the keep decision can skip one without the other:
//! - `MainActivity.requestNativeLifecycleSafety` stops the active BLE scan before Android
//!   suspends the WebView. It runs at every onPause/onDestroy, kept or not.
//! - `NativeOutputSafety.requestNativeOutputStop` writes every device's registered stop packet.
//!   MainActivity calls it at onPause unless the user's background keep holds output, and at
//!   onDestroy; the keep service calls it for 急停, its deadline, task removal and teardown.
//!
//! Neither blocks Android's main thread: both only schedule async work.

use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{Arc, OnceLock},
};

type Handler = Arc<dyn Fn() + Send + Sync>;

static LIFECYCLE_CLEANUP: OnceLock<Handler> = OnceLock::new();

// Only Android lifecycle hooks call these; host builds compile them for tests.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn install_lifecycle_cleanup_handler(handler: impl Fn() + Send + Sync + 'static) {
    if LIFECYCLE_CLEANUP.set(Arc::new(handler)).is_err() {
        log::error!("Android lifecycle cleanup handler was registered more than once");
    }
}

/// Runs a scheduling callback from a JNI entry. A panic must never unwind into the JVM; it is
/// reported as "not scheduled" so Kotlin can log it and fall back.
fn run_guarded(work: impl FnOnce() -> bool) -> bool {
    catch_unwind(AssertUnwindSafe(work)).unwrap_or_else(|_| {
        log::error!("Android native safety scheduling panicked");
        false
    })
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn run_registered(slot: &OnceLock<Handler>) -> bool {
    let Some(handler) = slot.get().cloned() else {
        return false;
    };
    run_guarded(|| {
        handler();
        true
    })
}

/// Writes every connected device's registered stop packet through plugin-blec, ahead of any
/// queued write, without waiting for the page. The page registered those packets after each
/// connect (`set_safety_stop`); a device it never registered is left to the page's own stop.
/// False when plugin-blec is not running, so there is nothing native to stop.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn request_native_output_stop() -> bool {
    let handler = match tauri_plugin_blec::get_handler() {
        Ok(handler) => handler,
        Err(error) => {
            log::error!("plugin-blec native output stop unavailable: {error}");
            return false;
        }
    };
    tauri::async_runtime::spawn(async move {
        match handler.safety_stop_all().await {
            Ok(outcomes) => {
                for outcome in outcomes.iter().filter(|outcome| !outcome.ok) {
                    log::error!(
                        "native output stop failed for one device: {:?}",
                        outcome.error
                    );
                }
            }
            Err(error) => log::error!("native output stop failed: {error}"),
        }
    });
    true
}

#[cfg(target_os = "android")]
mod jni_entries {
    use jni::{
        objects::{JClass, JObject},
        sys::{jboolean, JNI_FALSE, JNI_TRUE},
        JNIEnv,
    };

    fn to_jboolean(value: bool) -> jboolean {
        if value {
            JNI_TRUE
        } else {
            JNI_FALSE
        }
    }

    /// Schedules plugin-blec scanner cleanup before Android suspends the WebView. A failed
    /// scanner stop retains ownership so a later scan cannot start over uncertain radio state.
    #[no_mangle]
    pub extern "system" fn Java_ai_nullai_dgagent_MainActivity_requestNativeLifecycleSafety(
        _env: JNIEnv,
        _activity: JObject,
    ) -> jboolean {
        to_jboolean(super::run_registered(&super::LIFECYCLE_CLEANUP))
    }

    /// Output stop only, for the activity and the keep service; no page involved.
    #[no_mangle]
    pub extern "system" fn Java_ai_nullai_dgagent_NativeOutputSafety_requestNativeOutputStop(
        _env: JNIEnv,
        _class: JClass,
    ) -> jboolean {
        to_jboolean(super::run_guarded(super::request_native_output_stop))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn a_panicking_callback_reports_not_scheduled() {
        assert!(!run_guarded(|| panic!("boom")));
        assert!(run_guarded(|| true));
        assert!(!run_guarded(|| false));
    }

    #[test]
    fn nothing_registered_reports_not_scheduled() {
        let slot: OnceLock<Handler> = OnceLock::new();
        assert!(!run_registered(&slot));
    }

    #[test]
    fn the_registered_cleanup_runs_each_time() {
        let calls = Arc::new(AtomicUsize::new(0));
        let slot: OnceLock<Handler> = OnceLock::new();
        let counter = calls.clone();
        let _ = slot.set(Arc::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        }));
        assert!(run_registered(&slot));
        assert!(run_registered(&slot));
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn a_panicking_cleanup_does_not_unwind() {
        let slot: OnceLock<Handler> = OnceLock::new();
        let _ = slot.set(Arc::new(|| panic!("boom")));
        assert!(!run_registered(&slot));
    }

    #[test]
    fn output_stop_without_plugin_blec_reports_unavailable() {
        // No Tauri app (and so no plugin-blec handler) runs in unit tests.
        assert!(!request_native_output_stop());
    }
}
