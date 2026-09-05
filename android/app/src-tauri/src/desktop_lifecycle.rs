use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, RunEvent, WindowEvent};
static EXIT_CONFIRMED: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub async fn desktop_finish_exit(app: AppHandle) -> Result<(), String> {
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    { let _ = app; return Err("desktop command unavailable".into()); }
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        // The UI has awaited all DG session stops. Confirm the native embedded backend too.
        #[cfg(feature = "experimental-buttplug-gate0")]
        crate::buttplug::stop_for_exit(&app).await?;
        if let Ok(handler) = tauri_plugin_blec::get_handler() {
            handler.stop_scan().await.map_err(|error| error.to_string())?;
        }
        EXIT_CONFIRMED.store(true, Ordering::Release);
        app.exit(0);
        Ok(())
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
pub fn handle_event(app: &AppHandle, event: &RunEvent) {
    match event {
        RunEvent::WindowEvent { event: WindowEvent::CloseRequested { api, .. }, .. } if !EXIT_CONFIRMED.load(Ordering::Acquire) => {
            api.prevent_close();
            let _ = app.emit("app://close-requested", ());
        }
        RunEvent::ExitRequested { api, .. } if !EXIT_CONFIRMED.load(Ordering::Acquire) => {
            api.prevent_exit();
            let _ = app.emit("app://close-requested", ());
        }
        RunEvent::WindowEvent { event: WindowEvent::Focused(false), .. } => {
            let _ = app.emit("app://paused", ());
            #[cfg(feature = "experimental-buttplug-gate0")]
            crate::buttplug::pause_desktop(app);
        }
        _ => {}
    }
}
