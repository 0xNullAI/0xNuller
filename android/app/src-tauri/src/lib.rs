use tauri::{Emitter, RunEvent};

#[cfg(feature = "experimental-buttplug-gate0")]
mod buttplug;

#[cfg(target_os = "android")]
mod buttplug_android;
mod scan_coordinator;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_blec::init())
    .plugin(tauri_plugin_opener::init());

  #[cfg(feature = "experimental-buttplug-gate0")]
  let builder = buttplug::register(builder);
  #[cfg(not(feature = "experimental-buttplug-gate0"))]
  let builder = scan_coordinator::register(builder);

  builder
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
