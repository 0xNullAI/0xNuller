use jni::sys::JNI_TRUE;
use jni::{
    objects::JObject,
    sys::{jboolean, JNI_FALSE},
    JNIEnv,
};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{Arc, OnceLock},
};

static LIFECYCLE_STOP: OnceLock<Arc<dyn Fn() + Send + Sync>> = OnceLock::new();

pub(crate) fn install_lifecycle_stop_handler(handler: impl Fn() + Send + Sync + 'static) {
    if LIFECYCLE_STOP.set(Arc::new(handler)).is_err() {
        log::error!("Android lifecycle stop handler was registered more than once");
    }
}

/// Writes every connected device's registered stop packet through plugin-blec, ahead of any
/// queued write, without waiting for the page. The page registered those packets after each
/// connect (`set_safety_stop`); a device it never registered is left to the page's own stop.
// Only Android lifecycle hooks call this; host builds compile it for tests.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn request_native_output_stop() {
    tauri::async_runtime::spawn(async {
        let handler = match tauri_plugin_blec::get_handler() {
            Ok(handler) => handler,
            Err(error) => {
                log::error!("plugin-blec native output stop unavailable: {error}");
                return;
            }
        };
        match handler.safety_stop_all().await {
            Ok(outcomes) => {
                for outcome in outcomes.iter().filter(|outcome| !outcome.ok) {
                    log::error!("native output stop failed for one device: {:?}", outcome.error);
                }
            }
            Err(error) => log::error!("native output stop failed: {error}"),
        }
    });
}

/// Stops output natively and schedules plugin-blec scanner cleanup before Android suspends the
/// WebView.
///
/// The callback never blocks Android's main thread. A failed scanner stop
/// retains ownership so a later scan cannot start over uncertain radio state.
#[no_mangle]
pub extern "system" fn Java_ai_nullai_dgagent_MainActivity_requestNativeLifecycleSafety(
    _env: JNIEnv,
    _activity: JObject,
) -> jboolean {
    let Some(handler) = LIFECYCLE_STOP.get().cloned() else {
        return JNI_FALSE;
    };
    match catch_unwind(AssertUnwindSafe(|| handler())) {
        Ok(()) => JNI_TRUE,
        Err(_) => {
            log::error!("Android lifecycle safety scheduling panicked");
            JNI_FALSE
        }
    }
}
