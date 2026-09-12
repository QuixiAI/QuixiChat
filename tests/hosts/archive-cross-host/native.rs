//! Opt-in cross-host restore qualification: the production native host and
//! WebView restore a web-exported portable archive; the shell never touches
//! the database and only relays the page's bounded report.
#[path = "../../../apps/desktop/src-tauri/src/host/mod.rs"]
mod host;
#[path = "../../../apps/desktop/src-tauri/src/registered_destinations.rs"]
mod registered_destinations;
#[cfg(feature = "host-proof")]
#[path = "../../../apps/desktop/src-tauri/src/host_proof.rs"]
mod host_proof;

use std::sync::{Arc, Mutex};
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[derive(Clone)]
struct ProofState { profile: String, csp: String, checkpoint: Arc<Mutex<serde_json::Value>> }

#[tauri::command]
fn archive_cross_host_checkpoint(state: tauri::State<'_, ProofState>, report: String) -> Result<(), String> {
    if report.len() > 65_536 { return Err("Checkpoint exceeds its bound".into()); }
    let value: serde_json::Value = serde_json::from_str(&report).map_err(|error| error.to_string())?;
    println!("QUIXI_ARCHIVE_PROOF_CHECKPOINT={}", value.get("stage").unwrap_or(&serde_json::Value::Null));
    *state.checkpoint.lock().map_err(|_| "Checkpoint lock failed")? = value;
    Ok(())
}

#[tauri::command]
fn archive_cross_host_report(app: tauri::AppHandle, state: tauri::State<'_, ProofState>, report: String, success: bool) -> Result<(), String> {
    if report.len() > 262_144 { return Err("Report exceeds its bound".into()); }
    let webview: serde_json::Value = serde_json::from_str(&report).map_err(|error| error.to_string())?;
    println!("QUIXI_ARCHIVE_PROOF={}", serde_json::json!({ "profile": state.profile, "configuredCsp": state.csp, "webview": webview }));
    app.exit(if success { 0 } else { 1 });
    Ok(())
}

fn main() {
    #[cfg(not(target_os = "macos"))]
    panic!("This native cross-host proof qualifies isolated macOS WKWebView only");
    let profile = std::env::var("QUIXI_ARCHIVE_PROOF_PROFILE").expect("Explicit random UUID profile is required");
    let profile_id = uuid::Uuid::parse_str(&profile).expect("Synthetic profile must be a UUID");
    assert_eq!(profile_id.get_version_num(), 4, "Synthetic profile must be a random UUID v4");
    let keychain_service = format!("ai.quixi.chat.archive-cross-host-proof.{profile}");
    let native = host::NativeHost::new(registered_destinations::destinations(), keychain_service).expect("Production destination registry must remain valid");
    let mut context = tauri::generate_context!("../../../tests/hosts/archive-cross-host/build/tauri.conf.json");
    assert_eq!(context.config().identifier, "ai.quixi.chat.archive-cross-host-proof");
    context.config_mut().app.windows.clear();
    let csp = context.config().app.security.csp.as_ref().expect("Production CSP required").to_string();
    let state = ProofState { profile: profile.clone(), csp, checkpoint: Arc::new(Mutex::new(serde_json::Value::Null)) };
    let timeout_state = state.clone();
    let initialization = format!("window.__QUIXI_ARCHIVE_PROOF__={};", serde_json::json!({ "profile": profile }));
    let app = host::builder(native)
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            host::native_host_open, host::native_host_call, host::native_host_write_chunk, host::native_host_read_chunk,
            archive_cross_host_report, archive_cross_host_checkpoint,
        ])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Quixi synthetic native cross-host restore")
                .visible(true)
                .data_store_identifier(*profile_id.as_bytes())
                .initialization_script(&initialization)
                .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(240));
                println!("QUIXI_ARCHIVE_PROOF={}", serde_json::json!({
                    "profile": timeout_state.profile, "configuredCsp": timeout_state.csp,
                    "webview": { "success": false, "error": "Native watchdog expired", "lastCheckpoint": *timeout_state.checkpoint.lock().unwrap() },
                }));
                handle.exit(2);
            });
            Ok(())
        })
        .build(context).expect("Native cross-host proof WebView failed");
    let exit_code = Arc::new(std::sync::atomic::AtomicI32::new(2));
    let observed_exit = exit_code.clone();
    app.run_return(move |_, event| {
        if let tauri::RunEvent::ExitRequested { code: Some(code), .. } = event { observed_exit.store(code, std::sync::atomic::Ordering::SeqCst); }
    });
    std::process::exit(exit_code.load(std::sync::atomic::Ordering::SeqCst));
}
