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

/// Schedules plugin-blec scanner cleanup before Android suspends the WebView.
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
