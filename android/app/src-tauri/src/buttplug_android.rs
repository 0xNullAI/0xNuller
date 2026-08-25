#[cfg(feature = "experimental-buttplug-gate0")]
use jni::sys::JNI_TRUE;
use jni::{
    objects::JObject,
    sys::{jboolean, JNI_FALSE},
    JNIEnv,
};
#[cfg(feature = "experimental-buttplug-gate0")]
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    sync::atomic::{AtomicBool, Ordering},
};

#[cfg(feature = "experimental-buttplug-gate0")]
static READY: AtomicBool = AtomicBool::new(false);

#[cfg(feature = "experimental-buttplug-gate0")]
pub(crate) fn ready() -> bool {
    READY.load(Ordering::Acquire)
}

/// Initializes btleplug's Android JNI bridge after Tauri has loaded the Rust library.
///
/// The symbol remains present in ordinary builds so the checked-in Activity template
/// never depends on a Gradle-time feature switch. Without Gate 0 it returns false and
/// performs no BLE work.
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
                log::error!("Buttplug Gate 0 JNI initialization failed: {error}");
                JNI_FALSE
            }
            Err(_) => {
                log::error!("Buttplug Gate 0 JNI initialization panicked");
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
