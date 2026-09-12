//! Opt-in synthetic PDF qualification. Never uses the application's default
//! WKWebsiteDataStore: macOS 14+ and an explicit random UUID profile are required.
use std::sync::{Arc, Mutex};
use tauri::{WebviewUrl, WebviewWindowBuilder};

#[derive(Clone)]
struct ProofState {
    profile: String,
    phase: String,
    csp: String,
    resources: Arc<Mutex<Vec<serde_json::Value>>>,
    checkpoint: Arc<Mutex<serde_json::Value>>,
}

#[tauri::command]
fn document_proof_checkpoint(
    state: tauri::State<'_, ProofState>,
    report: String,
) -> Result<(), String> {
    if report.len() > 64 * 1024 {
        return Err("PDF checkpoint exceeds its bound".into());
    }
    let value: serde_json::Value =
        serde_json::from_str(&report).map_err(|error| error.to_string())?;
    println!(
        "QUIXI_DOCUMENT_CHECKPOINT={}",
        value.get("stage").unwrap_or(&serde_json::Value::Null)
    );
    *state
        .checkpoint
        .lock()
        .map_err(|_| "Checkpoint lock failed")? = value;
    Ok(())
}

#[tauri::command]
fn document_proof_report(
    app: tauri::AppHandle,
    state: tauri::State<'_, ProofState>,
    report: String,
    success: bool,
) -> Result<(), String> {
    if report.len() > 64 * 1024 {
        return Err("PDF proof report exceeds its bound".into());
    }
    let webview: serde_json::Value =
        serde_json::from_str(&report).map_err(|error| error.to_string())?;
    let result = serde_json::json!({
        "profile": state.profile, "phase": state.phase, "configuredCsp": state.csp,
        "resources": *state.resources.lock().map_err(|_| "Resource observation lock failed")?,
        "webview": webview,
    });
    println!("QUIXI_DOCUMENT_PROOF={result}");
    app.exit(if success { 0 } else { 1 });
    Ok(())
}

fn main() {
    #[cfg(not(target_os = "macos"))]
    panic!("This native PDF proof currently qualifies isolated macOS WKWebView only");
    let profile = std::env::var("QUIXI_DOCUMENT_PROOF_PROFILE")
        .expect("Explicit synthetic UUID profile required");
    let profile_id = uuid::Uuid::parse_str(&profile).expect("Synthetic profile must be a UUID");
    let phase = std::env::var("QUIXI_DOCUMENT_PROOF_PHASE").expect("Explicit proof phase required");
    assert!(matches!(phase.as_str(), "write" | "restart" | "cleanup"));
    let mut context =
        tauri::generate_context!("../../../tests/hosts/document-proof/build/tauri.conf.json");
    assert_eq!(context.config().identifier, "ai.quixi.chat.document-proof");
    context.config_mut().app.windows.clear();
    let csp = context
        .config()
        .app
        .security
        .csp
        .as_ref()
        .expect("Production CSP required")
        .to_string();
    let state = ProofState {
        profile: profile.clone(),
        phase: phase.clone(),
        csp,
        resources: Arc::new(Mutex::new(Vec::new())),
        checkpoint: Arc::new(Mutex::new(serde_json::Value::Null)),
    };
    let observation = state.resources.clone();
    let timeout_state = state.clone();
    let initialization = format!(
        "window.__QUIXI_DOCUMENT_PROOF__={};",
        serde_json::json!({ "profile": profile, "phase": phase })
    );
    tauri::Builder::default()
        .manage(state)
        .invoke_handler(tauri::generate_handler![document_proof_report, document_proof_checkpoint])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "document-proof", WebviewUrl::App("index.html".into()))
                .title("Quixi synthetic PDF qualification")
                .visible(true)
                .data_store_identifier(*profile_id.as_bytes())
                .initialization_script(&initialization)
                .on_web_resource_request(move |request, response| {
                    // Observe actual bundled URL, status and effective CSP; never
                    // alter the response, headers or production security policy.
                    if let Ok(mut records) = observation.lock() {
                        if records.len() < 512 {
                            records.push(serde_json::json!({
                                "url": request.uri().to_string().chars().take(2048).collect::<String>(),
                                "status": response.status().as_u16(),
                                "bytes": response.body().len(),
                                "csp": response.headers().get("Content-Security-Policy").and_then(|value| value.to_str().ok()),
                            }));
                        }
                    }
                })
                .build()?;
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(240));
                eprintln!("Native PDF proof exceeded its 240-second phase deadline");
                println!("QUIXI_DOCUMENT_PROOF={}", serde_json::json!({
                    "profile": timeout_state.profile, "phase": timeout_state.phase,
                    "configuredCsp": timeout_state.csp,
                    "resources": *timeout_state.resources.lock().unwrap(),
                    "webview": { "success": false, "error": "Native phase watchdog expired", "lastCheckpoint": *timeout_state.checkpoint.lock().unwrap() },
                }));
                handle.exit(2);
            });
            Ok(())
        })
        .run(context)
        .expect("Native PDF proof WebView failed");
}
