use jni::sys::JNI_TRUE;
use jni::{
    objects::JObject,
    sys::{jboolean, JNI_FALSE},
    JNIEnv,
};
#[cfg(feature = "experimental-buttplug-gate0")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{Arc, OnceLock},
};

#[cfg(feature = "experimental-buttplug-gate0")]
static READY: AtomicBool = AtomicBool::new(false);
static LIFECYCLE_STOP: OnceLock<Arc<dyn Fn() + Send + Sync>> = OnceLock::new();

#[cfg(feature = "experimental-buttplug-gate0")]
pub(crate) fn ready() -> bool {
    READY.load(Ordering::Acquire)
}

pub(crate) fn install_lifecycle_stop_handler(handler: impl Fn() + Send + Sync + 'static) {
    if LIFECYCLE_STOP.set(Arc::new(handler)).is_err() {
        log::error!("Buttplug lifecycle stop handler was registered more than once");
    }
}

/// Initializes btleplug's Android JNI bridge after Tauri has loaded the Rust library.
///
/// The symbol remains present in ordinary builds so the checked-in Activity template
/// never depends on a Gradle-time feature switch. Without the experimental feature it
/// returns false and performs no BLE work.
#[no_mangle]
pub extern "system" fn Java_ai_nullai_dgagent_MainActivity_initializeButtplugGate0(
    env: JNIEnv,
    _activity: JObject,
) -> jboolean {
    #[cfg(feature = "experimental-buttplug-gate0")]
    {
        let initialized = catch_unwind(AssertUnwindSafe(|| btleplug::platform::init(&env)));
        match initialized {
            Ok(Ok(())) => {
                READY.store(true, Ordering::Release);
                JNI_TRUE
            }
            Ok(Err(error)) => {
                log::error!("Buttplug Android JNI initialization failed: {error}");
                JNI_FALSE
            }
            Err(_) => {
                log::error!("Buttplug Android JNI initialization panicked");
                JNI_FALSE
            }
        }
    }

    #[cfg(not(feature = "experimental-buttplug-gate0"))]
    {
        let _ = env;
        JNI_FALSE
    }
}

/// Schedules native output stop and scanner cleanup before Android suspends
/// the WebView. Default builds stop/release plugin-blec scans; feature builds
/// additionally stop and tear down the experimental backend.
///
/// The callback never blocks Android's main thread. A failed scanner stop
/// retains ownership so the competing backend continues to fail closed.
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
