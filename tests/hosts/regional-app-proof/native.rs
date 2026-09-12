//! Opt-in shared-app regional qualification. Preserve production origins, native
//! commands and TLS validation; route only reviewed US/EU names to synthetic TLS.
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
struct ProofState {
    profile: String,
    phase: String,
    csp: String,
    keychain_service: String,
    tls_fixture: serde_json::Value,
    resources: Arc<Mutex<Vec<serde_json::Value>>>,
    checkpoint: Arc<Mutex<serde_json::Value>>,
}

#[tauri::command]
fn regional_app_proof_checkpoint(state: tauri::State<'_, ProofState>, report: String) -> Result<(), String> {
    if report.len() > 65_536 { return Err("Regional app checkpoint exceeds its bound".into()); }
    let value: serde_json::Value = serde_json::from_str(&report).map_err(|error| error.to_string())?;
    println!("QUIXI_REGIONAL_APP_CHECKPOINT={}", value.get("stage").unwrap_or(&serde_json::Value::Null));
    *state.checkpoint.lock().map_err(|_| "Checkpoint lock failed")? = value;
    Ok(())
}

#[tauri::command]
fn regional_app_proof_report(app: tauri::AppHandle, state: tauri::State<'_, ProofState>, report: String, success: bool) -> Result<(), String> {
    if report.len() > 65_536 { return Err("Regional app report exceeds its bound".into()); }
    let webview: serde_json::Value = serde_json::from_str(&report).map_err(|error| error.to_string())?;
    println!("QUIXI_REGIONAL_APP_PROOF={}", serde_json::json!({
        "profile": state.profile, "phase": state.phase, "configuredCsp": state.csp,
        "keychainService": state.keychain_service, "tlsFixture": state.tls_fixture,
        "resources": *state.resources.lock().map_err(|_| "Resource observation lock failed")?, "webview": webview,
    }));
    app.exit(if success { 0 } else { 1 });
    Ok(())
}

fn main() {
    #[cfg(not(target_os = "macos"))]
    panic!("This native regional app proof qualifies isolated macOS WKWebView only");
    let os = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().expect("macOS version is required");
    assert!(os.status.success(), "macOS version inspection failed");
    let version = String::from_utf8(os.stdout).expect("macOS version must be UTF-8");
    let major: u32 = version.trim().split('.').next().unwrap().parse().expect("macOS major version is required");
    assert!(major >= 14, "Isolated WKWebsiteDataStore requires macOS 14 or newer");
    let profile = std::env::var("QUIXI_REGIONAL_APP_PROFILE").expect("Explicit random UUID profile is required");
    let profile_id = uuid::Uuid::parse_str(&profile).expect("Synthetic profile must be a UUID");
    assert_eq!(profile_id.get_version_num(), 4, "Synthetic profile must be a random UUID v4");
    assert_eq!(profile_id.to_string(), profile, "Synthetic profile must use canonical UUID spelling");
    let phase = std::env::var("QUIXI_REGIONAL_APP_PHASE").expect("Explicit proof phase is required");
    assert!(matches!(phase.as_str(), "tls-untrusted-ca" | "tls-wrong-hostname" | "write" | "restart" | "cleanup"));
    let port: u16 = std::env::var("QUIXI_REGIONAL_APP_TLS_PORT").expect("Synthetic TLS port required").parse().expect("Synthetic TLS port must be a nonzero u16");
    let ca_path = std::path::PathBuf::from(std::env::var("QUIXI_REGIONAL_APP_TLS_CA").expect("Synthetic TLS CA required"));
    let metadata = std::fs::metadata(&ca_path).expect("Synthetic TLS CA is unavailable");
    assert!(metadata.is_file() && metadata.len() > 0 && metadata.len() <= 65_536, "Synthetic TLS CA must be a bounded PEM file");
    let pem = std::fs::read(ca_path).expect("Synthetic TLS CA could not be read");
    let keychain_service = format!("ai.quixi.chat.regional-app-proof.{profile}");
    let native = host::NativeHost::new(registered_destinations::destinations(), keychain_service.clone())
        .expect("Production destination registry must remain valid")
        .with_regional_app_fixture(port, &pem).expect("Synthetic TLS fixture is invalid");
    let mut context = tauri::generate_context!("../../../tests/hosts/regional-app-proof/build/tauri.conf.json");
    assert_eq!(context.config().identifier, "ai.quixi.chat.regional-app-proof");
    context.config_mut().app.windows.clear();
    let csp = context.config().app.security.csp.as_ref().expect("Production CSP required").to_string();
    let state = ProofState { profile: profile.clone(), phase: phase.clone(), csp,
        keychain_service, tls_fixture: serde_json::json!({ "address": format!("127.0.0.1:{port}"), "hosts": ["us.api.openai.com", "eu.api.openai.com"], "hostnameValidation": true }),
        resources: Arc::new(Mutex::new(Vec::new())), checkpoint: Arc::new(Mutex::new(serde_json::Value::Null)),
    };
    let observation = state.resources.clone();
    let timeout_state = state.clone();
    let initialization = format!("window.__QUIXI_REGIONAL_APP_PROOF__={};", serde_json::json!({ "profile": profile, "phase": phase }));
    let app = host::builder(native)
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            host::native_host_open, host::native_host_call, host::native_host_write_chunk, host::native_host_read_chunk,
            regional_app_proof_report, regional_app_proof_checkpoint,
        ])
        .setup(move |app| {
            // Keep the production native command's main-window admission rule.
            // The distinct app identifier and UUID data store provide isolation.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Quixi synthetic native regional qualification")
                .visible(true)
                .data_store_identifier(*profile_id.as_bytes())
                .initialization_script(&initialization)
                .on_web_resource_request(move |request, response| {
                    if let Ok(mut records) = observation.lock() {
                        if records.len() < 512 { records.push(serde_json::json!({
                            "url": request.uri().to_string().chars().take(2048).collect::<String>(),
                            "status": response.status().as_u16(), "bytes": response.body().len(),
                            "csp": response.headers().get("Content-Security-Policy").and_then(|value| value.to_str().ok()),
                        })); }
                    }
                }).build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(240));
                println!("QUIXI_REGIONAL_APP_PROOF={}", serde_json::json!({
                    "profile": timeout_state.profile, "phase": timeout_state.phase, "configuredCsp": timeout_state.csp,
                    "keychainService": timeout_state.keychain_service, "tlsFixture": timeout_state.tls_fixture,
                    "resources": *timeout_state.resources.lock().unwrap(),
                    "webview": { "success": false, "error": "Native phase watchdog expired", "lastCheckpoint": *timeout_state.checkpoint.lock().unwrap() },
                }));
                handle.exit(2);
            });
            Ok(())
        })
        .build(context).expect("Native regional app proof WebView failed");
    // Pinned Wry emits the requested code but exits Tao with ControlFlow::Exit
    // (zero). Capture the request and let normal Tauri cleanup finish first.
    let exit_code = Arc::new(std::sync::atomic::AtomicI32::new(2));
    let observed_exit = exit_code.clone();
    app.run_return(move |_, event| {
        if let tauri::RunEvent::ExitRequested { code: Some(code), .. } = event {
            observed_exit.store(code, std::sync::atomic::Ordering::SeqCst);
        }
    });
    std::process::exit(exit_code.load(std::sync::atomic::Ordering::SeqCst));
}
