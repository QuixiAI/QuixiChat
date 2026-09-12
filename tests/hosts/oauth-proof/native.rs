//! Feature-gated installed callback qualification. Only the production host
//! plugin handles RunEvent::Opened; this harness never calls its URL handler.
#[path = "../../../apps/desktop/src-tauri/src/host/mod.rs"]
mod host;
#[path = "../../../apps/desktop/src-tauri/src/registered_destinations.rs"]
mod registered_destinations;
#[cfg(feature = "host-proof")]
#[path = "../../../apps/desktop/src-tauri/src/host_proof.rs"]
mod host_proof;
use serde::Deserialize;
use std::{path::{Path, PathBuf}, sync::{Arc, Mutex, atomic::{AtomicUsize, AtomicI32, Ordering}}};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configuration { profile: String, phase: String, scheme: String, tls_port: u16, tls_ca: PathBuf, http_port: u16, control_directory: PathBuf }
#[derive(Clone)]
struct ProofState { config: Configuration, csp: String, keychain_service: String, authorizations: Arc<AtomicUsize>, resources: Arc<Mutex<Vec<serde_json::Value>>> }
fn private_json(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let bytes = serde_json::to_vec(value).map_err(|_| "Proof JSON encoding failed")?;
    if bytes.len() > 262_144 { return Err("Proof control/report exceeds its bound".into()); }
    let temporary = path.with_extension("pending");
    let mut file = std::fs::OpenOptions::new().create(true).truncate(true).write(true).mode(0o600).open(&temporary).map_err(|_| "Proof control file unavailable")?;
    file.write_all(&bytes).map_err(|_| "Proof control write failed")?; file.sync_all().map_err(|_| "Proof control sync failed")?;
    std::fs::rename(temporary, path).map_err(|_| "Proof control publication failed".into())
}
#[tauri::command]
fn oauth_proof_snapshot(state: tauri::State<'_, ProofState>, native: tauri::State<'_, Arc<host::NativeHost>>) -> serde_json::Value {
    let token_requests = std::fs::read(state.config.control_directory.join("token-observed.json")).ok().filter(|bytes|bytes.len()<1024).and_then(|bytes|serde_json::from_slice::<serde_json::Value>(&bytes).ok()).and_then(|value|value.get("tokenRequests").and_then(|count|count.as_u64())).unwrap_or(0);
    serde_json::json!({"pid":std::process::id(),"authorizations":state.authorizations.load(Ordering::SeqCst),"oauth":native.oauth_proof_stats(),"tokenRequests":token_requests,"committing":state.config.control_directory.join("commit-entered.json").is_file()})
}
#[tauri::command]
fn oauth_proof_stage(state: tauri::State<'_, ProofState>, stage: String) -> Result<(), String> {
    if stage.len() > 96 || !stage.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') { return Err("Invalid bounded proof stage".into()); }
    private_json(&state.config.control_directory.join("stage.json"), &serde_json::json!({"pid":std::process::id(),"phase":state.config.phase,"stage":stage}))
}
#[tauri::command]
async fn oauth_proof_report(app: tauri::AppHandle, state: tauri::State<'_, ProofState>, native: tauri::State<'_, Arc<host::NativeHost>>, report: String, success: bool) -> Result<(), String> {
    if report.len() > 65_536 { return Err("OAuth proof report exceeds its bound".into()); }
    let webview: serde_json::Value = serde_json::from_str(&report).map_err(|_| "Invalid bounded proof report")?;
    let result = serde_json::json!({"profile":state.config.profile,"phase":state.config.phase,"pid":std::process::id(),"configuredCsp":state.csp,"keychainService":state.keychain_service,"authorizations":state.authorizations.load(Ordering::SeqCst),"oauth":native.oauth_proof_stats(),"resources":*state.resources.lock().map_err(|_| "Resource lock failed")?,"webview":webview});
    private_json(&state.config.control_directory.join("result.json"), &result)?;
    println!("QUIXI_OAUTH_PROOF_RESULT={}", if success {"passed"} else {"failed"});
    app.exit(if success {0} else {1}); Ok(())
}
fn main() {
    assert!(cfg!(target_os = "macos"), "OAuth installed proof requires macOS");
    let version = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().expect("macOS version unavailable");
    assert!(version.status.success() && String::from_utf8(version.stdout).unwrap().trim().split('.').next().unwrap().parse::<u32>().unwrap() >= 14, "An isolated WKWebView UUID store requires macOS14+");
    let executable = std::env::current_exe().expect("Installed executable unavailable");
    let resource = executable.parent().unwrap().parent().unwrap().join("Resources/proof-config.json");
    assert!(std::fs::metadata(&resource).unwrap().len() <= 8192, "Proof config exceeds its bound");
    let mut config: Configuration = serde_json::from_slice(&std::fs::read(resource).unwrap()).expect("Explicit installed proof configuration required");
    let profile = uuid::Uuid::parse_str(&config.profile).expect("Proof UUID invalid");
    assert_eq!(profile.get_version_num(), 4); assert_eq!(profile.to_string(), config.profile);
    assert_eq!(config.scheme, format!("ai.quixi.chat.oauth-proof.{}",config.profile));
    assert!(config.tls_port > 0 && config.http_port > 0);
    assert_eq!(config.control_directory.file_name().unwrap().to_str().unwrap(), format!("quixi-oauth-proof-{}",config.profile));
    assert!(config.control_directory.is_dir() && config.control_directory.is_absolute());
    let phase_bytes=std::fs::read(config.control_directory.join("phase.json")).expect("Proof phase unavailable");
    assert!(phase_bytes.len()<1024);config.phase=serde_json::from_slice::<serde_json::Value>(&phase_bytes).unwrap().get("phase").and_then(|value|value.as_str()).unwrap().to_string();
    assert!(["cold","success","bad-state","bad-issuer","bad-path","duplicate-query","denied","expired","duplicate-callback","cancel","dispose","reload","cancel-token","commit-cancel","overload","oversize-token","invalid-token","malformed-token","redirect-token","auxiliary-tokens","cleanup"].contains(&config.phase.as_str()));
    let binding = host::Binding { provider_id:"oauth-fixture".into(),account_id:"primary".into(),destination_id:"oauth-fixture-api".into(),transport_id:"oauth-fixture-native".into() };
    let destination = |binding: host::Binding| host::Destination { binding,origin:format!("http://127.0.0.1:{}/",config.http_port).parse().unwrap(),routes:vec![host::Route{path:"/v1/models".into(),methods:vec!["GET".into()],headers:vec![],query:vec![]}],credential_header:"Authorization".into(),credential_prefix:"Bearer ".into(),privacy:"direct_provider".into(),allow_loopback_http:true };
    let oauth = |id: &str, binding:host::Binding, timeout_ms| host::OAuthConfiguration { id:id.into(),binding,authorization_endpoint:"https://oauth.synthetic.invalid/authorize".into(),token_endpoint:"https://oauth.synthetic.invalid/token".into(),redirect_uri:format!("{}://oauth/callback",config.scheme),issuer:"https://oauth.synthetic.invalid".into(),client_id:"quixi-native-oauth-proof".into(),allowed_scopes:vec!["profile".into()],timeout_ms };
    let mut bindings=vec![binding.clone()];
    let mut configurations=vec![oauth("synthetic",binding.clone(),10000),oauth("expiry",binding.clone(),300)];
    for index in 0..5 {let mut extra=binding.clone();extra.account_id=format!("overload-{index}");extra.destination_id=format!("oauth-fixture-api-{index}");extra.transport_id=format!("oauth-fixture-native-{index}");configurations.push(oauth(&format!("overload-{index}"),extra.clone(),10000));bindings.push(extra);}
    let service = format!("ai.quixi.chat.oauth-proof.{}",config.profile);
    let counter = Arc::new(AtomicUsize::new(0)); let opening_count = counter.clone(); let opening_directory = config.control_directory.clone();
    let opener = Arc::new(move |url: &str| -> Result<(), String> {
        if url.len() > 8192 { return Err("Proof authorization URL exceeds its bound".into()); }
        let sequence = opening_count.fetch_add(1,Ordering::SeqCst) + 1;
        if sequence > 8 { return Err("Proof opener exceeded its bound".into()); }
        private_json(&opening_directory.join(format!("authorization-{sequence}.json")),&serde_json::json!({"url":url}))
    });
    let pem = std::fs::read(&config.tls_ca).expect("Ephemeral CA unavailable");
    let commit_config=config.clone();
    let committing=Arc::new(move || {if commit_config.phase=="commit-cancel" {
        private_json(&commit_config.control_directory.join("commit-entered.json"),&serde_json::json!({"entered":true})).expect("Commit proof control unavailable");
        let deadline=std::time::Instant::now()+std::time::Duration::from_secs(15);
        while !commit_config.control_directory.join("commit-release.json").is_file() && std::time::Instant::now()<deadline {std::thread::sleep(std::time::Duration::from_millis(10));}
    }});
    let native = host::NativeHost::new(bindings.clone().into_iter().map(destination).collect(),service.clone()).unwrap()
        .with_oauth_configurations(configurations).unwrap()
        .with_oauth_proof(config.tls_port,&pem,opener).unwrap()
        .with_oauth_commit_proof(committing).unwrap();
    let mut context = tauri::generate_context!("../../../tests/hosts/oauth-proof/build/tauri.conf.json");
    assert_eq!(context.config().identifier, config.scheme); context.config_mut().app.windows.clear();
    let csp = context.config().app.security.csp.as_ref().unwrap().to_string();
    let state = ProofState {config:config.clone(),csp,keychain_service:service,authorizations:counter,resources:Arc::new(Mutex::new(Vec::new()))};
    let observation = state.resources.clone(); let deadline_config = config.clone();
    let initialization = format!("window.__QUIXI_OAUTH_PROOF__={};",serde_json::json!({"profile":config.profile,"phase":config.phase,"binding":binding,"allBindings":bindings}));
    let app = host::builder(native).manage(state)
        .invoke_handler(tauri::generate_handler![host::native_host_open,host::native_host_call,host::native_host_write_chunk,host::native_host_read_chunk,oauth_proof_snapshot,oauth_proof_stage,oauth_proof_report])
        .setup(move |app| {
            WebviewWindowBuilder::new(app,"main",WebviewUrl::App("index.html".into())).title("Quixi synthetic native OAuth qualification").visible(true).data_store_identifier(*profile.as_bytes()).initialization_script(&initialization)
                .on_web_resource_request(move |request,response| { if let Ok(mut values)=observation.lock() { if values.len()<256 { values.push(serde_json::json!({"url":request.uri().to_string().chars().take(2048).collect::<String>(),"status":response.status().as_u16(),"bytes":response.body().len(),"csp":response.headers().get("Content-Security-Policy").and_then(|value|value.to_str().ok())})); } } }).build()?;
            private_json(&deadline_config.control_directory.join("ready.json"),&serde_json::json!({"pid":std::process::id(),"profile":deadline_config.profile,"phase":deadline_config.phase})).map_err(std::io::Error::other)?;
            let app_handle=app.handle().clone(); std::thread::spawn(move || {std::thread::sleep(std::time::Duration::from_secs(45));app_handle.exit(2);}); Ok(())
        }).build(context).expect("OAuth proof WebView failed");
    let code=Arc::new(AtomicI32::new(2)); let exit=code.clone();
    app.run_return(move |_,event| {if let tauri::RunEvent::ExitRequested{code,..}=event {if let Some(value)=code {exit.store(value,Ordering::SeqCst);}}});
    let final_code=code.load(Ordering::SeqCst);
    let _=private_json(&config.control_directory.join("exit.json"),&serde_json::json!({"pid":std::process::id(),"phase":config.phase,"code":final_code,"runReturned":true}));
    std::process::exit(final_code);
}
