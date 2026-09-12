//! Opt-in host acceptance runner, excluded from ordinary desktop builds.

use tauri::webview::PageLoadEvent;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[cfg(not(feature = "custom-protocol"))]
compile_error!("The storage-proof feature requires bundled custom-protocol assets");

#[tauri::command]
fn storage_proof_report(
    app: tauri::AppHandle,
    report: String,
    success: bool,
) -> Result<(), String> {
    if report.len() > 64 * 1024 {
        return Err("Host proof report exceeds its bound".into());
    }
    println!("QUIXI_STORAGE_PROOF={report}");
    app.exit(if success { 0 } else { 1 });
    Ok(())
}

#[tauri::command]
fn storage_proof_open_follower(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window("proof-follower").is_some() {
        return Err("The proof follower already exists".into());
    }
    let namespace = std::env::var("QUIXI_PROOF_NAMESPACE").map_err(|e| e.to_string())?;
    let phase = std::env::var("QUIXI_PROOF_PHASE").map_err(|e| e.to_string())?;
    WebviewWindowBuilder::new(
        &app,
        "proof-follower",
        WebviewUrl::App(
            format!("storage-proof?namespace={namespace}&phase={phase}&role=follower").into(),
        ),
    )
    .title("Quixi storage proof follower")
    .visible(false)
    .build()
    .map(|_| ())
    .map_err(|e| e.to_string())
}

pub fn run() {
    let namespace = std::env::var("QUIXI_PROOF_NAMESPACE").expect("QUIXI_PROOF_NAMESPACE required");
    assert!(!namespace.is_empty() && namespace.len() <= 64);
    assert!(
        namespace
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    );
    let phase = std::env::var("QUIXI_PROOF_PHASE").expect("QUIXI_PROOF_PHASE required");
    assert!(phase == "write" || phase == "restart");
    let mut context = tauri::generate_context!();
    context.config_mut().app.windows[0].url =
        tauri::WebviewUrl::App(format!("storage-proof?namespace={namespace}&phase={phase}").into());
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            storage_proof_report,
            storage_proof_open_follower
        ])
        .on_page_load(|webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                webview
                    .eval(include_str!(
                        "../../../../tests/hosts/tauri-storage-proof.js"
                    ))
                    .expect("could not start bundled WebView proof");
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(90));
                eprintln!("Tauri storage proof exceeded 90 seconds");
                handle.exit(2);
            });
            Ok(())
        })
        .run(context)
        .expect("failed to run bundled Tauri storage proof");
}
