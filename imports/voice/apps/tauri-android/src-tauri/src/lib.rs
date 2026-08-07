use tauri::{Emitter, RunEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_blec::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application")
    .run(|app, event| {
      // Emit `app://paused` on exit so the JS lifecycle-safety wrapper can
      // fire emergencyStop before the webview tears down. Android's onPause
      // is reliably picked up by `document.visibilitychange` inside the
      // WebView; we don't need a dedicated Tauri mobile event for it.
      if let RunEvent::ExitRequested { .. } = event {
        let _ = app.emit("app://paused", ());
      }
    });
}
