//! Feature-only synthetic acceptance harness in the real bundled WebView.
use crate::host::{self, Binding, Destination, NativeHost, Route};
use tauri::webview::PageLoadEvent;

#[tauri::command]
pub fn native_host_proof_report(
    app: tauri::AppHandle,
    report: String,
    success: bool,
) -> Result<(), String> {
    if report.len() > 64 * 1024 {
        return Err("Native host proof report exceeds its bound".into());
    }
    println!("QUIXI_NATIVE_HOST_PROOF={report}");
    app.exit(if success { 0 } else { 1 });
    Ok(())
}
pub fn run() {
    let namespace =
        std::env::var("QUIXI_HOST_PROOF_NAMESPACE").expect("synthetic namespace required");
    assert!(uuid::Uuid::parse_str(&namespace).is_ok());
    let service = format!("ai.quixi.chat.host-proof.{namespace}");
    let origin =
        std::env::var("QUIXI_HOST_PROOF_ORIGIN").unwrap_or_else(|_| "http://127.0.0.1:1".into());
    let url: reqwest::Url = origin.parse().expect("valid fixture origin required");
    assert!(url.scheme() == "http" && url.host_str() == Some("127.0.0.1"));
    let binding = Binding {
        provider_id: "synthetic".into(),
        account_id: "synthetic-account".into(),
        destination_id: "synthetic-local".into(),
        transport_id: "native-proof".into(),
    };
    let destination = Destination {
        binding,
        origin: url,
        routes: ["/echo", "/stream", "/slow", "/idle", "/error", "/redirect"]
            .into_iter()
            .map(|path| Route {
                path: path.into(),
                methods: vec!["GET".into(), "POST".into()],
                headers: vec!["content-type".into()],
                query: vec![],
            })
            .collect(),
        credential_header: "Authorization".into(),
        credential_prefix: "Bearer ".into(),
        privacy: "local".into(),
        allow_loopback_http: true,
    };
    let mut destinations = vec![destination];
    if let Ok(origin) = std::env::var("QUIXI_PROVIDER_PROOF_ORIGIN") {
        let origin: reqwest::Url = origin.parse().expect("valid provider fixture origin");
        assert!(origin.scheme() == "http" && origin.host_str() == Some("127.0.0.1"));
        for protocol in ["openai-compatible", "anthropic"] {
            destinations.push(Destination {
                binding: Binding {
                    provider_id: protocol.into(),
                    account_id: "synthetic-account".into(),
                    destination_id: protocol.into(),
                    transport_id: "native-provider-proof".into(),
                },
                origin: origin.clone(),
                routes: vec![
                    Route {
                        path: "/v1/models".into(),
                        methods: vec!["GET".into()],
                        headers: vec!["anthropic-version".into()],
                        query: vec!["after_id".into(), "before_id".into(), "limit".into()],
                    },
                    Route {
                        path: if protocol == "anthropic" {
                            "/v1/messages"
                        } else {
                            "/v1/chat/completions"
                        }
                        .into(),
                        methods: vec!["POST".into()],
                        headers: vec!["content-type".into(), "anthropic-version".into()],
                        query: vec![],
                    },
                    Route {
                        path: "/v1/messages/count_tokens".into(),
                        methods: vec!["POST".into()],
                        headers: vec!["content-type".into(), "anthropic-version".into()],
                        query: vec![],
                    },
                ],
                credential_header: if protocol == "anthropic" {
                    "x-api-key"
                } else {
                    "Authorization"
                }
                .into(),
                credential_prefix: if protocol == "anthropic" {
                    ""
                } else {
                    "Bearer "
                }
                .into(),
                privacy: "local".into(),
                allow_loopback_http: true,
            });
        }
    }
    if std::env::var("QUIXI_HOST_PROOF_PHASE").as_deref() == Ok("regions") {
        // Keep real registry metadata unchanged. Separate loopback clones have
        // distinct bindings and deliberately receive no regional evidence.
        for production in crate::registered_destinations::destinations() {
            if crate::registered_destinations::regional_processing(&production).is_some() {
                let mut fixture = production.clone();
                fixture.binding.destination_id.push_str("-loopback-proof");
                fixture.binding.transport_id.push_str("-loopback-proof");
                fixture.origin = origin.parse().expect("validated loopback fixture origin");
                fixture.privacy = "local".into();
                fixture.allow_loopback_http = true;
                destinations.push(fixture);
            }
            destinations.push(production);
        }
    }
    let native = NativeHost::new(destinations, service).expect("valid synthetic host config");
    if std::env::args().any(|arg| arg == "--cleanup-host-proof") {
        #[cfg(target_os = "macos")]
        native
            .secrets
            .cleanup_proof_service()
            .expect("synthetic credential cleanup failed");
        return;
    }
    let phase = std::env::var("QUIXI_HOST_PROOF_PHASE").expect("proof phase required");
    assert!(
        phase == "write"
            || phase == "retarget"
            || phase == "restart"
            || phase == "dialogs"
            || phase == "providers"
            || phase == "regions"
    );
    let credential: serde_json::Value = serde_json::from_str(
        &std::env::var("QUIXI_HOST_PROOF_CREDENTIAL").unwrap_or_else(|_| "null".into()),
    )
    .expect("valid synthetic handle metadata");
    let initialization = format!(
        "window.__QUIXI_HOST_PROOF__={};\n{}",
        serde_json::json!({"phase":phase,"credential":credential,"fileFixture":std::env::var("QUIXI_HOST_FILE_PROOF_SHA256").ok().map(|hash|serde_json::json!({"sha256":hash,"bytes":268435456}))}),
        include_str!("../../tests/build/host-proof.js")
    );
    host::builder(native)
        .on_page_load(move |webview, payload| {
            if payload.event() == PageLoadEvent::Finished {
                webview
                    .eval(&initialization)
                    .expect("could not start native host proof");
            }
        })
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if std::env::var("QUIXI_HOST_PROOF_PHASE").as_deref() == Ok("dialogs") {
                let app = app.handle().clone();
                std::thread::spawn(move || {
                    for _ in 0..120 {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        let _ = app.run_on_main_thread(cancel_fixture_dialog);
                    }
                });
            }
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let seconds = if std::env::var_os("QUIXI_HOST_FILE_PROOF_SHA256").is_some() {
                    180
                } else {
                    90
                };
                std::thread::sleep(std::time::Duration::from_secs(seconds));
                eprintln!("Native host proof exceeded its bounded deadline");
                handle.exit(2);
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("native host proof WebView failed");
}

#[tauri::command]
pub fn native_host_proof_stats(
    host: tauri::State<'_, std::sync::Arc<NativeHost>>,
) -> serde_json::Value {
    let mut stats = host.proof_file_stats();
    stats["nativePanelsCancelled"] =
        serde_json::json!(PANELS_CANCELLED.load(std::sync::atomic::Ordering::SeqCst));
    stats
}

pub fn file_selection(name: Option<&str>) -> Option<Result<Vec<std::path::PathBuf>, String>> {
    let directory = std::env::var("QUIXI_HOST_FILE_PROOF_DIR").ok()?;
    let path = std::path::PathBuf::from(directory);
    if !path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with("quixi-native-file-proof-"))
    {
        return Some(Err("Invalid fixture directory".into()));
    }
    let name = match name {
        None => "input.bin",
        Some("cancel.bin") => return Some(Ok(Vec::new())),
        Some(name @ ("export.bin" | "preserved.bin")) => name,
        Some(_) => return Some(Err("Unregistered fixture filename".into())),
    };
    Some(Ok(vec![path.join(name)]))
}

static PANELS_CANCELLED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(target_os = "macos")]
fn cancel_fixture_dialog() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSModalResponseCancel, NSSavePanel};
    let Some(marker) = MainThreadMarker::new() else {
        return;
    };
    let app = NSApplication::sharedApplication(marker);
    for window in app.windows().iter() {
        if window.downcast_ref::<NSSavePanel>().is_some() && window.isVisible() {
            if let Some(parent) = window.sheetParent() {
                parent.endSheet_returnCode(&window, NSModalResponseCancel);
                window.orderOut(None);
                PANELS_CANCELLED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
    }
}
