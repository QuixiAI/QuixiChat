//! Privileged host boundary. Canonical persistence remains in StorageWorker.
mod files;
mod models;
mod oauth;
mod secrets;
use bytes::Bytes;
use models::*;
pub use models::{Binding, Destination, Route};
pub use oauth::OAuthConfiguration;
use secrets::Secrets;
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tauri::{Manager, State, WebviewWindow};
use tokio_util::sync::CancellationToken;
use zeroize::Zeroize;

struct Operation {
    token: CancellationToken,
    complete: AtomicBool,
    dispatched: AtomicBool,
    timed_out: AtomicBool,
    secret_id: Option<String>,
    body_bytes: Mutex<usize>,
    transfer_id: Mutex<Option<String>>,
    permit: Mutex<Option<tokio::sync::OwnedSemaphorePermit>>,
}
struct Stage {
    owner: String,
    request_id: String,
    purpose: String,
    chunks: Vec<Vec<u8>>,
    size: usize,
    sequence: u32,
    final_chunk: bool,
    verified: bool,
    expected_bytes: Option<usize>,
    expected_hash: Option<String>,
}
impl Drop for Stage {
    fn drop(&mut self) {
        for bytes in &mut self.chunks {
            bytes.zeroize();
        }
    }
}
struct Source {
    request_id: String,
    response: reqwest::Response,
    remainder: Bytes,
    sequence: u32,
    offset: u64,
    pending: BTreeMap<u32, u64>,
    final_chunk: bool,
    idle_ms: u64,
}
struct Session {
    id: String,
    owner: String,
    closed: AtomicBool,
    operations: Mutex<HashMap<String, Arc<Operation>>>,
    sources: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Source>>>>,
}
#[cfg(feature = "regional-app-proof")]
struct RegionalAppFixture {
    address: std::net::SocketAddr,
    certificate: reqwest::Certificate,
}
#[cfg(all(test, feature = "regional-app-proof"))]
mod regional_app_fixture_tests {
    use super::*;

    #[test]
    fn malformed_fixture_ca_and_unbounded_inputs_are_refused() {
        assert!(RegionalAppFixture::new(0, b"not a certificate").is_err());
        assert!(RegionalAppFixture::new(443, b"").is_err());
        assert!(RegionalAppFixture::new(443, &vec![b'x'; 65_537]).is_err());
        assert!(RegionalAppFixture::new(443, b"not a certificate").is_err());
    }

    #[test]
    fn fixture_dns_override_accepts_only_exact_reviewed_regional_destinations() {
        let destinations = crate::registered_destinations::destinations();
        assert!(destinations[..2].iter().all(|value| !RegionalAppFixture::accepts(value)));
        assert!(destinations[2..].iter().all(RegionalAppFixture::accepts));
        for origin in ["https://api.openai.com/", "https://us.api.openai.com:8443/", "https://unreviewed.example/", "http://127.0.0.1:443/"] {
            let mut altered = destinations[2].clone();
            altered.origin = origin.parse().unwrap();
            assert!(!RegionalAppFixture::accepts(&altered));
        }
        let mut altered = destinations[2].clone();
        altered.binding.account_id = "other".into();
        assert!(!RegionalAppFixture::accepts(&altered));
    }
}
#[cfg(feature = "regional-app-proof")]
impl RegionalAppFixture {
    fn new(port: u16, pem: &[u8]) -> std::result::Result<Self, String> {
        if port == 0 || pem.is_empty() || pem.len() > 65_536 {
            return Err("Regional fixture requires a nonzero loopback port and a bounded PEM CA".into());
        }
        let certificate = reqwest::Certificate::from_pem(pem)
            .map_err(|_| "Regional fixture CA is not a valid PEM certificate".to_string())?;
        Ok(Self { address: ([127, 0, 0, 1], port).into(), certificate })
    }
    fn accepts(destination: &Destination) -> bool {
        crate::registered_destinations::regional_processing(destination).is_some()
    }
    fn client(&self, builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
        // reqwest 0.13.4 resolve() uses this nonzero socket port because the
        // unchanged reviewed HTTPS URLs have no explicit port. SNI and ordinary
        // certificate hostname validation still use the original provider host.
        builder.resolve("us.api.openai.com", self.address)
            .resolve("eu.api.openai.com", self.address)
            .add_root_certificate(self.certificate.clone())
    }
}
pub struct NativeHost {
    destinations: Vec<Destination>,
    pub secrets: Arc<Secrets>,
    files: Arc<files::Files>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    stages: Mutex<HashMap<String, Stage>>,
    buffered: AtomicUsize,
    http_permits: Arc<tokio::sync::Semaphore>,
    secret_permits: Arc<tokio::sync::Semaphore>,
    oauth: Arc<oauth::OAuthManager>,
    #[cfg(feature = "regional-app-proof")]
    regional_app_fixture: Option<RegionalAppFixture>,
}
impl NativeHost {
    pub fn new(
        destinations: Vec<Destination>,
        service: String,
    ) -> std::result::Result<Self, String> {
        for destination in &destinations {
            let url = &destination.origin;
            let loopback = matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"));
            if url.username() != ""
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || url.path() != "/"
                || !(url.scheme() == "https"
                    || url.scheme() == "http" && loopback && destination.allow_loopback_http)
            {
                return Err(
                    "Native destination requires an HTTPS origin or explicit loopback HTTP origin"
                        .into(),
                );
            }
            if destination.privacy == "local" && !loopback
                || ![
                    "local",
                    "direct_provider",
                    "self_hosted_remote",
                    "custom_remote",
                ]
                .contains(&destination.privacy.as_str())
            {
                return Err("Native direct transport has an invalid privacy class".into());
            }
            if [
                &destination.binding.provider_id,
                &destination.binding.account_id,
                &destination.binding.destination_id,
                &destination.binding.transport_id,
            ]
            .iter()
            .any(|field| field.is_empty() || field.len() > 256)
            {
                return Err("Native destination binding is invalid".into());
            }
            for route in &destination.routes {
                let resolved = url
                    .join(&route.path)
                    .map_err(|_| "Invalid registered path")?;
                if !route.path.starts_with('/')
                    || route.path.starts_with("//")
                    || route.path.contains(['\\', '?', '#'])
                    || resolved.path() != route.path
                    || resolved.origin() != url.origin()
                {
                    return Err("Native routes require exact normalized paths".into());
                }
            }
        }
        let oauth = Arc::new(oauth::OAuthManager::new(Vec::new(), &destinations)?);
        Ok(Self {
            destinations,
            secrets: Arc::new(Secrets::new(service)),
            files: Arc::new(files::Files::new()),
            sessions: Mutex::new(HashMap::new()),
            stages: Mutex::new(HashMap::new()),
            buffered: AtomicUsize::new(0),
            http_permits: Arc::new(tokio::sync::Semaphore::new(4)),
            secret_permits: Arc::new(tokio::sync::Semaphore::new(4)),
            oauth,
            #[cfg(feature = "regional-app-proof")]
            regional_app_fixture: None,
        })
    }
    /// Native deployment code owns every OAuth endpoint, client and binding.
    /// The normal application deliberately supplies no provider registrations.
    pub fn with_oauth_configurations(mut self, configurations: Vec<OAuthConfiguration>) -> std::result::Result<Self, String> {
        self.oauth = Arc::new(oauth::OAuthManager::new(configurations, &self.destinations)?);
        Ok(self)
    }
    #[cfg(feature = "oauth-proof")]
    pub fn with_oauth_proof(mut self, port: u16, pem: &[u8], opener: Arc<dyn Fn(&str) -> std::result::Result<(), String> + Send + Sync>) -> std::result::Result<Self, String> {
        let manager = Arc::try_unwrap(self.oauth).map_err(|_| "OAuth proof configuration must precede host ownership".to_string())?;
        self.oauth = Arc::new(manager.with_proof(port, pem, opener)?);
        Ok(self)
    }
    #[cfg(feature = "oauth-proof")]
    pub fn oauth_proof_stats(&self) -> Value { self.oauth.proof_stats() }
    #[cfg(feature = "oauth-proof")]
    pub fn with_oauth_commit_proof(mut self, hook: Arc<dyn Fn() + Send + Sync>) -> std::result::Result<Self, String> {
        let manager=Arc::try_unwrap(self.oauth).map_err(|_|"OAuth commit proof must precede host ownership".to_string())?;
        self.oauth=Arc::new(manager.with_commit_proof(hook)?); Ok(self)
    }
    /// Only the opt-in proof binary reads fixture environment variables. Normal
    /// hosts never load test certificates, alter DNS, or consult that environment.
    #[cfg(feature = "regional-app-proof")]
    pub fn with_regional_app_fixture(mut self, port: u16, pem: &[u8]) -> std::result::Result<Self, String> {
        self.regional_app_fixture = Some(RegionalAppFixture::new(port, pem)?);
        Ok(self)
    }
    fn destination(&self, binding: &Binding, request: &str) -> Result<Destination> {
        self.destinations
            .iter()
            .find(|destination| &destination.binding == binding)
            .cloned()
            .ok_or_else(|| {
                error(
                    "INVALID_REQUEST",
                    "Provider/account/destination is not registered in the native host.",
                    request,
                )
            })
    }
    fn session(&self, session_id: &str, owner: &str) -> Result<Arc<Session>> {
        let session = self
            .sessions
            .lock()
            .expect("sessions poisoned")
            .get(session_id)
            .cloned()
            .ok_or_else(|| {
                error(
                    "CLOSED",
                    "Native host session is absent or closed.",
                    session_id,
                )
            })?;
        if session.owner != owner || session.closed.load(Ordering::SeqCst) {
            return Err(error(
                "CLOSED",
                "Native session belongs to another window or is closed.",
                session_id,
            ));
        }
        Ok(session)
    }
    fn charge(&self, count: usize, request: &str) -> Result<()> {
        self.buffered
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                current
                    .checked_add(count)
                    .filter(|next| *next <= BUFFER_BYTES)
            })
            .map(|_| ())
            .map_err(|_| {
                error(
                    "OVERLOADED",
                    "Native host retained-payload budget reached.",
                    request,
                )
            })
    }
    fn finish(&self, session: &Session, request: &str) {
        let mut operations = session.operations.lock().expect("operations poisoned");
        if let Some(operation) = operations.get(request) {
            if !operation.complete.swap(true, Ordering::SeqCst) {
                operation.token.cancel();
                self.buffered.fetch_sub(
                    std::mem::take(
                        &mut *operation.body_bytes.lock().expect("body budget poisoned"),
                    ),
                    Ordering::SeqCst,
                );
                operation
                    .permit
                    .lock()
                    .expect("HTTP permit poisoned")
                    .take();
            }
        }
        if operations.len() > 64 {
            if let Some(key) = operations
                .iter()
                .find(|(_, operation)| operation.complete.load(Ordering::SeqCst))
                .map(|(id, _)| id.clone())
            {
                operations.remove(&key);
            }
        }
    }
    fn release_source(&self, session: &Session, transfer_id: &str) {
        let source = session
            .sources
            .lock()
            .expect("sources poisoned")
            .remove(transfer_id);
        if source.is_some() {
            let request = session
                .operations
                .lock()
                .expect("operations poisoned")
                .iter()
                .find(|(_, operation)| {
                    operation
                        .transfer_id
                        .lock()
                        .expect("transfer id poisoned")
                        .as_deref()
                        == Some(transfer_id)
                })
                .map(|(id, _)| id.clone());
            if let Some(request) = request {
                self.finish(session, &request);
            }
        }
    }
    fn cancel(&self, session: &Session, request_id: &str) -> Value {
        let mut outcomes = Vec::with_capacity(3);
        if let Some(result) = self.oauth.cancel(&session.id, request_id) { outcomes.push(result); }
        if let Some(result) = self.files.cancel(&session.id, request_id) {
            outcomes.push(result);
        }
        let operation = session
            .operations
            .lock()
            .expect("operations poisoned")
            .get(request_id)
            .cloned();
        let completed = operation
            .as_ref()
            .is_some_and(|op| op.complete.load(Ordering::SeqCst));
        let dispatched = operation
            .as_ref()
            .is_some_and(|op| op.dispatched.load(Ordering::SeqCst));
        if let Some(operation) = &operation {
            operation.token.cancel();
        }
        // Reads observe cancellation without needing their held async reader lock.
        if let Some(operation) = &operation {
            if let Some(transfer_id) = operation
                .transfer_id
                .lock()
                .expect("transfer id poisoned")
                .as_ref()
            {
                session
                    .sources
                    .lock()
                    .expect("sources poisoned")
                    .remove(transfer_id);
            }
        }
        let mut stages = self.stages.lock().expect("stages poisoned");
        let staged_request = stages
            .values()
            .any(|stage| stage.owner == session.id && stage.request_id == request_id);
        let removed: usize = stages
            .values()
            .filter(|stage| stage.owner == session.id && stage.request_id == request_id)
            .map(|stage| stage.size)
            .sum();
        stages.retain(|_, stage| !(stage.owner == session.id && stage.request_id == request_id));
        self.buffered.fetch_sub(removed, Ordering::SeqCst);
        self.finish(session, request_id);
        // OS keychain calls cannot be interrupted once dispatched. An untracked request
        // may be such a call; never claim that cancellation prevented its commit.
        let unknown = operation.is_none() && !staged_request;
        if !unknown || outcomes.is_empty() {
            outcomes.push(json!({"requestId":request_id,"outcome":if completed {"already_completed"} else if unknown {"unknown_outcome"} else {"cancelled"},"externalEffect":if dispatched || unknown {"may_have_occurred"} else {"not_dispatched"}}));
        }
        combine_cancellations(request_id, &outcomes)
    }
    fn cancel_secret(&self, secret_id: &str) {
        let sessions: Vec<_> = self
            .sessions
            .lock()
            .expect("sessions poisoned")
            .values()
            .cloned()
            .collect();
        for session in sessions {
            let requests: Vec<_> = session
                .operations
                .lock()
                .expect("operations poisoned")
                .iter()
                .filter(|(_, operation)| operation.secret_id.as_deref() == Some(secret_id))
                .map(|(id, _)| id.clone())
                .collect();
            for request in requests {
                self.cancel(&session, &request);
            }
        }
    }
    fn close(&self, session_id: &str, owner: &str) -> Result<()> {
        let session = self.session(session_id, owner)?;
        session.closed.store(true, Ordering::SeqCst);
        self.oauth.close(session_id);
        self.files.close(session_id);
        let requests: Vec<_> = session
            .operations
            .lock()
            .expect("operations poisoned")
            .keys()
            .cloned()
            .collect();
        for request in requests {
            self.cancel(&session, &request);
        }
        session.sources.lock().expect("sources poisoned").clear();
        let mut stages = self.stages.lock().expect("stages poisoned");
        let removed: usize = stages
            .values()
            .filter(|stage| stage.owner == session_id)
            .map(|stage| stage.size)
            .sum();
        stages.retain(|_, stage| stage.owner != session_id);
        self.buffered.fetch_sub(removed, Ordering::SeqCst);
        drop(stages);
        self.sessions
            .lock()
            .expect("sessions poisoned")
            .remove(session_id);
        Ok(())
    }
    #[cfg(feature = "host-proof")]
    pub fn proof_file_stats(&self) -> Value {
        self.files.proof_stats()
    }
    fn capabilities(&self) -> Value {
        let unsupported =
            |reason| json!({"available":false,"permission":"not_required","reason":reason});
        json!({"host":"desktop","secretPersistence":"native", "nativeFiles":{"available":true,"permission":"prompt","reason":null},"notifications":unsupported("Native notifications are not implemented."),"oauth":if self.oauth.available() && self.secrets.available {json!({"available":true,"permission":"prompt","reason":null})} else {unsupported("Native OAuth requires a registered provider configuration and an available macOS keychain.")},"providerTransports":self.destinations.iter().map(|destination| {
            let mut transport = json!({"id":destination.binding.transport_id,"kind":"native_direct","privacy":destination.privacy,"endpointOrigin":destination.origin.origin().ascii_serialization(),"relayIdentity":null,"capability":{"available":true,"permission":"not_required","reason":null}});
            if let Some(evidence) = crate::registered_destinations::regional_processing(destination) {
                transport["regionalProcessing"] = evidence;
            }
            transport
        }).collect::<Vec<_>>()})
    }
}

fn combine_cancellations(request_id: &str, outcomes: &[Value]) -> Value {
    let unknown = outcomes.is_empty() || outcomes.iter().any(|value| value["outcome"] == "unknown_outcome");
    let cancelled = outcomes.iter().any(|value| value["outcome"] == "cancelled");
    let external = unknown || outcomes.iter().any(|value| value["externalEffect"] == "may_have_occurred");
    json!({"requestId":request_id,"outcome":if unknown {"unknown_outcome"} else if cancelled {"cancelled"} else {"already_completed"},"externalEffect":if external {"may_have_occurred"} else {"not_dispatched"}})
}

fn local_window(window: &WebviewWindow) -> Result<()> {
    let url = window
        .url()
        .map_err(|_| error("CLOSED", "Could not establish the caller origin.", "origin"))?;
    let bundled = url.scheme() == "tauri" && url.host_str() == Some("localhost")
        || matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost");
    let development = cfg!(debug_assertions) && url.as_str().starts_with("http://127.0.0.1:1420/");
    if window.label() != "main" || !(bundled || development) {
        return Err(error(
            "UNSUPPORTED",
            "Native host commands require the local main application WebView.",
            "origin",
        ));
    }
    Ok(())
}
#[tauri::command]
pub fn native_host_open(window: WebviewWindow, host: State<'_, Arc<NativeHost>>) -> Result<Value> {
    local_window(&window)?;
    let mut sessions = host.sessions.lock().expect("sessions poisoned");
    if sessions.len() >= 4 {
        return Err(error(
            "OVERLOADED",
            "Close an existing native host session first.",
            "open",
        ));
    }
    let session_id = uuid::Uuid::new_v4().to_string();
    sessions.insert(
        session_id.clone(),
        Arc::new(Session {
            id: session_id.clone(),
            owner: window.label().into(),
            closed: AtomicBool::new(false),
            operations: Mutex::new(HashMap::new()),
            sources: Mutex::new(HashMap::new()),
        }),
    );
    Ok(
        json!({"sessionId":session_id,"capabilities":host.capabilities(),"secretStore":{"available":host.secrets.available,"reason":if host.secrets.available {Value::Null} else {json!("This target has no available OS keychain implementation.")}}}),
    )
}
fn decode<T: DeserializeOwned>(payload: Value, request: &str) -> Result<T> {
    serde_json::from_value(payload).map_err(|_| {
        error(
            "INVALID_REQUEST",
            "Invalid native host command arguments.",
            request,
        )
    })
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OpenSecretArgs {
    request_id: String,
    binding: Binding,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct StoreArgs {
    request_id: String,
    binding: Binding,
    value: Vec<u8>,
    replace: Option<SecretHandle>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DeleteArgs {
    request_id: String,
    handle: SecretHandle,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Declaration {
    purpose: String,
    expected_bytes: Option<usize>,
    expected_sha256: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BeginArgs {
    request_id: String,
    declaration: Declaration,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishArgs {
    request_id: String,
    transfer_id: String,
    expected: Expected,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Expected {
    byte_length: usize,
    sha256: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransferArgs {
    request_id: String,
    transfer_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestArgs {
    request_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Ack {
    transfer_id: String,
    sequence: u32,
    committed_offset: u64,
}

#[tauri::command]
pub async fn native_host_call(
    window: WebviewWindow,
    host: State<'_, Arc<NativeHost>>,
    session_id: String,
    operation: String,
    payload: Value,
) -> Result<Value> {
    local_window(&window)?;
    let host = host.inner().clone();
    let session = host.session(&session_id, window.label())?;
    if serde_json::to_vec(&payload).map_or(true, |bytes| bytes.len() > 131_072) {
        return Err(error(
            "INVALID_REQUEST",
            "Native command metadata exceeds its bound.",
            &session_id,
        ));
    }
    match operation.as_str() {
        "capabilities" => Ok(host.capabilities()),
        "startOAuth" => host.oauth.clone().start(host.clone(), session, decode(payload, &session_id)?).await,
        "dispose" => {
            host.close(&session_id, window.label())?;
            Ok(Value::Null)
        }
        "openSecret" => {
            let args: OpenSecretArgs = decode(payload, &session_id)?;
            id(&args.request_id)?;
            let destination = host.destination(&args.binding, &args.request_id)?;
            let authority = json!([destination.origin.as_str(), destination.credential_header.to_ascii_lowercase(), destination.credential_prefix]).to_string();
            let secrets = host.secrets.clone();
            let permit = host.secret_permits.clone().try_acquire_owned().map_err(|_| error("OVERLOADED", "Native keychain actor admission limit reached.", &args.request_id))?;
            let handle = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                secrets.open(&args.binding, &authority, &args.request_id)
            }).await.map_err(|_| error("INTERNAL", "Native credential actor failed.", &session_id))??;
            Ok(json!(handle))
        }
        "storeSecret" => {
            let args: StoreArgs = decode(payload, &session_id)?;
            id(&args.request_id)?;
            let destination = host.destination(&args.binding, &args.request_id)?;
            host.oauth.invalidate_binding(&args.binding, &args.request_id)?;
            let authority = json!([
                destination.origin.as_str(),
                destination.credential_header.to_ascii_lowercase(),
                destination.credential_prefix
            ])
            .to_string();
            if let Some(previous) = &args.replace {
                host.cancel_secret(&previous.id);
            }
            let secrets = host.secrets.clone();
            let permit = host
                .secret_permits
                .clone()
                .try_acquire_owned()
                .map_err(|_| {
                    error(
                        "OVERLOADED",
                        "Native keychain actor admission limit reached.",
                        &args.request_id,
                    )
                })?;
            let oauth = host.oauth.clone();
            let handle = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                secrets.put_guarded(
                    args.binding.clone(),
                    authority,
                    args.value,
                    args.replace,
                    &args.request_id,
                    || oauth.invalidate_binding(&args.binding, &args.request_id),
                )
            })
            .await
            .map_err(|_| error("INTERNAL", "Native credential actor failed.", &session_id))??;
            Ok(json!(handle))
        }
        "deleteSecret" => {
            let args: DeleteArgs = decode(payload, &session_id)?;
            id(&args.request_id)?;
            host.destination(&args.handle.binding, &args.request_id)?;
            host.oauth.invalidate_binding(&args.handle.binding, &args.request_id)?;
            host.cancel_secret(&args.handle.id);
            let secrets = host.secrets.clone();
            let permit = host
                .secret_permits
                .clone()
                .try_acquire_owned()
                .map_err(|_| {
                    error(
                        "OVERLOADED",
                        "Native keychain actor admission limit reached.",
                        &args.request_id,
                    )
                })?;
            let oauth = host.oauth.clone();
            tokio::task::spawn_blocking(move || {
                let _permit = permit;
                secrets.delete_guarded(&args.handle, &args.request_id, || oauth.invalidate_binding(&args.handle.binding, &args.request_id))
            })
            .await
            .map_err(|_| error("INTERNAL", "Native credential actor failed.", &session_id))??;
            Ok(Value::Null)
        }
        "startProviderHttp" => {
            start_http(host, session, session_id, decode(payload, "http")?).await
        }
        "beginTransfer" => {
            let args: BeginArgs = decode(payload, &session_id)?;
            id(&args.request_id)?;
            if !["provider_request", "file_save"].contains(&args.declaration.purpose.as_str())
                || args
                    .declaration
                    .expected_sha256
                    .as_ref()
                    .is_some_and(|hash| !hash_valid(hash))
            {
                return Err(error(
                    "INVALID_REQUEST",
                    "Invalid native transfer declaration.",
                    &args.request_id,
                ));
            }
            if args.declaration.purpose == "file_save" {
                return host
                    .files
                    .begin(
                        session,
                        args.request_id,
                        args.declaration.expected_bytes.map(|size| size as u64),
                        args.declaration.expected_sha256,
                    )
                    .await;
            }
            if args
                .declaration
                .expected_bytes
                .is_some_and(|size| size > STAGE_BYTES)
            {
                return Err(error(
                    "UNSUPPORTED",
                    "Native provider request staging is limited to 8 MiB.",
                    &args.request_id,
                ));
            }
            let mut stages = host.stages.lock().expect("stages poisoned");
            if stages.len() >= 16 {
                return Err(error(
                    "OVERLOADED",
                    "Native staging transfer limit reached.",
                    &args.request_id,
                ));
            }
            let transfer_id = uuid::Uuid::new_v4().to_string();
            stages.insert(
                transfer_id.clone(),
                Stage {
                    owner: session_id,
                    request_id: args.request_id,
                    purpose: args.declaration.purpose,
                    chunks: Vec::new(),
                    size: 0,
                    sequence: 0,
                    final_chunk: false,
                    verified: false,
                    expected_bytes: args.declaration.expected_bytes,
                    expected_hash: args.declaration.expected_sha256,
                },
            );
            Ok(
                json!({"transferId":transfer_id,"maxChunkBytes":CHUNK_BYTES,"maxInFlight":IN_FLIGHT}),
            )
        }
        "finishTransfer" => {
            let args: FinishArgs = decode(payload, &session_id)?;
            id(&args.request_id)?;
            if host.files.has_stage(&session_id, &args.transfer_id) {
                return host
                    .files
                    .finish(
                        session_id,
                        args.transfer_id,
                        args.request_id,
                        args.expected.byte_length as u64,
                        args.expected.sha256,
                    )
                    .await;
            }
            let mut stages = host.stages.lock().expect("stages poisoned");
            let stage = stages
                .get_mut(&args.transfer_id)
                .filter(|stage| stage.owner == session_id)
                .ok_or_else(|| {
                    error(
                        "NOT_FOUND",
                        "Staged transfer does not belong to this session.",
                        &args.request_id,
                    )
                })?;
            if !stage.final_chunk
                || stage.size != args.expected.byte_length
                || stage.expected_bytes.is_some_and(|size| size != stage.size)
                || !hash_valid(&args.expected.sha256)
            {
                return Err(error(
                    "INVALID_REQUEST",
                    "Staged transfer is incomplete or length does not match.",
                    &args.request_id,
                ));
            }
            let mut hasher = Sha256::new();
            for chunk in &stage.chunks {
                hasher.update(chunk);
            }
            let digest = format!("{:x}", hasher.finalize());
            if digest != args.expected.sha256
                || stage
                    .expected_hash
                    .as_ref()
                    .is_some_and(|hash| hash != &digest)
            {
                return Err(error(
                    "INVALID_REQUEST",
                    "Staged transfer digest does not match.",
                    &args.request_id,
                ));
            }
            stage.verified = true;
            Ok(
                json!({"transferId":args.transfer_id,"byteLength":stage.size,"sha256":digest,"state":"verified_staged"}),
            )
        }
        "releaseTransfer" => {
            let args: TransferArgs = decode(payload, &session_id)?;
            id(&args.request_id)?;
            host.files.release(&session_id, &args.transfer_id);
            let mut stages = host.stages.lock().expect("stages poisoned");
            if stages
                .get(&args.transfer_id)
                .is_some_and(|stage| stage.owner == session_id)
            {
                if let Some(stage) = stages.remove(&args.transfer_id) {
                    host.buffered.fetch_sub(stage.size, Ordering::SeqCst);
                }
            }
            drop(stages);
            host.release_source(&session, &args.transfer_id);
            Ok(Value::Null)
        }
        "acknowledgeChunk" => {
            let ack: Ack = decode(payload, &session_id)?;
            if host.files.has_source(&session_id, &ack.transfer_id) {
                return host.files.acknowledge(
                    &session_id,
                    &ack.transfer_id,
                    ack.sequence,
                    ack.committed_offset,
                );
            }
            let source = session
                .sources
                .lock()
                .expect("sources poisoned")
                .get(&ack.transfer_id)
                .cloned()
                .ok_or_else(|| {
                    error(
                        "NOT_FOUND",
                        "Source transfer is absent or belongs to another session.",
                        &ack.transfer_id,
                    )
                })?;
            let mut source = source.try_lock().map_err(|_| {
                error(
                    "CONFLICT",
                    "Source transfer has a pending read.",
                    &ack.transfer_id,
                )
            })?;
            if source.pending.get(&ack.sequence) != Some(&ack.committed_offset) {
                return Err(error(
                    "INVALID_REQUEST",
                    "Acknowledgement does not match an outstanding chunk.",
                    &ack.transfer_id,
                ));
            }
            source.pending.remove(&ack.sequence);
            let complete = source.final_chunk && source.pending.is_empty();
            drop(source);
            if complete {
                host.release_source(&session, &ack.transfer_id);
            }
            Ok(Value::Null)
        }
        "chooseFiles" => {
            let args: ChooseArgs = decode(payload, &session_id)?;
            id(&args.request_id)?;
            host.files
                .choose(
                    window,
                    session,
                    args.request_id,
                    args.options.multiple,
                    args.options.media_types,
                )
                .await
        }
        "openFileTransfer" => {
            let args: FileArgs = decode(payload, &session_id)?;
            id(&args.request_id)?;
            host.files.open(&session, &args.request_id, &args.file_id)
        }
        "releaseFile" => {
            let args: FileArgs = decode(payload, &session_id)?;
            id(&args.request_id)?;
            host.files.release_file(&session_id, &args.file_id);
            Ok(Value::Null)
        }
        "saveFileTransfer" => {
            let args: SaveArgs = decode(payload, &session_id)?;
            id(&args.request_id)?;
            host.files
                .save(
                    window,
                    session,
                    args.request_id,
                    args.file.name,
                    args.file.media_type,
                    args.file.transfer_id,
                )
                .await
        }
        #[cfg(feature = "host-proof")]
        "fileProofStats" => Ok(host.files.proof_stats()),
        "cancel" => {
            let args: RequestArgs = decode(payload, &session_id)?;
            id(&args.request_id)?;
            Ok(host.cancel(&session, &args.request_id))
        }
        _ => Err(error(
            "UNSUPPORTED",
            "This native host capability is not implemented yet.",
            &session_id,
        )),
    }
}

async fn start_http(
    host: Arc<NativeHost>,
    session: Arc<Session>,
    session_id: String,
    request: HttpRequest,
) -> Result<Value> {
    id(&request.request_id)?;
    let destination = host.destination(&request.binding, &request.request_id)?;
    #[cfg(feature = "regional-app-proof")]
    if host.regional_app_fixture.is_some() && !RegionalAppFixture::accepts(&destination) {
        return Err(error("UNSUPPORTED", "Regional app proof refuses all non-reviewed fixture destinations before HTTP", &request.request_id));
    }
    let route = destination
        .routes
        .iter()
        .find(|route| route.path == request.path && route.methods.contains(&request.method))
        .ok_or_else(|| {
            error(
                "INVALID_REQUEST",
                "HTTP path/method is not in the native destination registry.",
                &request.request_id,
            )
        })?;
    if request.query.len() > 8
        || request.query.iter().any(|(name, value)| {
            !route.query.iter().any(|allowed| allowed == name)
                || value.len() > 256
                || value.chars().any(|c| c.is_control())
        })
    {
        return Err(error(
            "INVALID_REQUEST",
            "HTTP query parameter is not permitted by the native destination registry.",
            &request.request_id,
        ));
    }
    if request.headers.len() > 64
        || request
            .headers
            .iter()
            .map(|(key, value)| key.len() + value.len())
            .sum::<usize>()
            > 16_384
        || [
            request.timeout.connect_ms,
            request.timeout.idle_ms,
            request.timeout.total_ms,
        ]
        .iter()
        .any(|ms| *ms == 0 || *ms > 3_600_000)
    {
        return Err(error(
            "INVALID_REQUEST",
            "HTTP metadata or deadlines exceed their bounds.",
            &request.request_id,
        ));
    }
    let mut headers = reqwest::header::HeaderMap::new();
    for (key, value) in &request.headers {
        let lower = key.to_ascii_lowercase();
        if [
            "authorization",
            "proxy-authorization",
            "cookie",
            "host",
            "connection",
            "content-length",
            "transfer-encoding",
            "origin",
            "referer",
        ]
        .contains(&lower.as_str())
            || lower.starts_with("sec-")
            || lower.starts_with("x-quixi-")
            || lower == destination.credential_header.to_ascii_lowercase()
            || !route
                .headers
                .iter()
                .any(|allowed| allowed.eq_ignore_ascii_case(key))
        {
            return Err(error(
                "INVALID_REQUEST",
                "HTTP header is not permitted by the native destination registry.",
                &request.request_id,
            ));
        }
        let key = reqwest::header::HeaderName::from_bytes(key.as_bytes()).map_err(|_| {
            error(
                "INVALID_REQUEST",
                "Invalid HTTP header name.",
                &request.request_id,
            )
        })?;
        let value = reqwest::header::HeaderValue::from_str(value).map_err(|_| {
            error(
                "INVALID_REQUEST",
                "Invalid HTTP header value.",
                &request.request_id,
            )
        })?;
        headers.insert(key, value);
    }
    let permit = host.http_permits.clone().try_acquire_owned().map_err(|_| {
        error(
            "OVERLOADED",
            "Native HTTP concurrency limit reached across all sessions.",
            &request.request_id,
        )
    })?;
    let operation = Arc::new(Operation {
        token: CancellationToken::new(),
        complete: AtomicBool::new(false),
        dispatched: AtomicBool::new(false),
        timed_out: AtomicBool::new(false),
        secret_id: request.credential.as_ref().map(|handle| handle.id.clone()),
        body_bytes: Mutex::new(0),
        transfer_id: Mutex::new(None),
        permit: Mutex::new(Some(permit)),
    });
    {
        let mut operations = session.operations.lock().expect("operations poisoned");
        host.oauth.ensure_request_unused(&session.id, &request.request_id)?;
        if operations.contains_key(&request.request_id) {
            return Err(error(
                "CONFLICT",
                "Native request ID was already used.",
                &request.request_id,
            ));
        }
        if operations
            .values()
            .filter(|operation| !operation.complete.load(Ordering::SeqCst))
            .count()
            >= 4
        {
            return Err(error(
                "OVERLOADED",
                "Native HTTP concurrency limit reached.",
                &request.request_id,
            ));
        }
        operations.insert(request.request_id.clone(), operation.clone());
    }
    let timer_host = host.clone();
    let timer_session = session.clone();
    let timer_request = request.request_id.clone();
    let timer_operation = operation.clone();
    tokio::spawn(async move {
        tokio::select! { _ = timer_operation.token.cancelled() => (), _ = tokio::time::sleep(Duration::from_millis(request.timeout.total_ms)) => { timer_operation.timed_out.store(true, Ordering::SeqCst); timer_host.cancel(&timer_session, &timer_request); } }
    });
    let result = async {
        if let Some(handle) = request.credential.clone() {
            let secrets = host.secrets.clone(); let binding = request.binding.clone(); let id = request.request_id.clone();
            let permit = host.secret_permits.clone().try_acquire_owned().map_err(|_| error("OVERLOADED", "Native keychain actor admission limit reached.", &request.request_id))?;
            let authority = json!([destination.origin.as_str(), destination.credential_header.to_ascii_lowercase(), destination.credential_prefix]).to_string();
            let secret = tokio::task::spawn_blocking(move || { let _permit = permit; secrets.read(&handle, &binding, &authority, &id) }).await.map_err(|_| error("INTERNAL", "Credential actor failed.", &request.request_id))??;
            let value = zeroize::Zeroizing::new(format!("{}{}", destination.credential_prefix, secret.as_str()));
            let mut header = reqwest::header::HeaderValue::from_str(&value).map_err(|_| error("INVALID_REQUEST", "Stored credential cannot be injected into HTTP.", &request.request_id))?; header.set_sensitive(true);
            headers.insert(reqwest::header::HeaderName::from_bytes(destination.credential_header.as_bytes()).map_err(|_| error("INVALID_REQUEST", "Native credential header is invalid.", &request.request_id))?, header);
        }
        let client = reqwest::Client::builder().no_proxy().redirect(reqwest::redirect::Policy::none()).retry(reqwest::retry::never()).connect_timeout(Duration::from_millis(request.timeout.connect_ms)).read_timeout(Duration::from_millis(request.timeout.idle_ms)).timeout(Duration::from_millis(request.timeout.total_ms));
        #[cfg(feature = "regional-app-proof")]
        let client = match &host.regional_app_fixture { Some(fixture) => fixture.client(client), None => client };
        let client = client.build().map_err(|_| error("IO_ERROR", "Native TLS/HTTP client initialization failed.", &request.request_id))?;
        let method = reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|_| error("INVALID_REQUEST", "Invalid provider HTTP method.", &request.request_id))?;
        let mut url = destination.origin.join(&request.path).map_err(|_| error("INVALID_REQUEST", "Invalid registered provider route.", &request.request_id))?;
        if !request.query.is_empty() { url.query_pairs_mut().extend_pairs(request.query.iter()); }
        let mut builder = client.request(method.clone(), url).headers(headers);
        if let Some(transfer_id) = &request.body_transfer_id {
            if method == reqwest::Method::GET { return Err(error("INVALID_REQUEST", "GET cannot use a request body transfer.", &request.request_id)); }
            let stages = host.stages.lock().expect("stages poisoned");
            let stage = stages.get(transfer_id).filter(|stage| stage.owner == session_id && stage.purpose == "provider_request" && stage.verified).ok_or_else(|| error("INVALID_REQUEST", "HTTP body requires a verified session-owned request transfer.", &request.request_id))?;
            let mut budget = operation.body_bytes.lock().expect("body budget poisoned");
            if operation.complete.load(Ordering::SeqCst) || operation.token.is_cancelled() { return Err(error("CANCELLED", "Native body staging cancelled before dispatch.", &request.request_id)); }
            host.charge(stage.size, &request.request_id)?; *budget = stage.size;
            builder = builder.body(stage.chunks.concat());
        }
        if session.closed.load(Ordering::SeqCst) || operation.token.is_cancelled() { return Err(error("CANCELLED", "Native request cancelled before dispatch.", &request.request_id)); }
        operation.dispatched.store(true, Ordering::SeqCst);
        let response = tokio::select! { _ = operation.token.cancelled() => return Err(error(if operation.timed_out.load(Ordering::SeqCst) { "IO_ERROR" } else { "CANCELLED" }, "Native provider request cancelled or exceeded its deadline.", &request.request_id)), response = builder.send() => response.map_err(|_| error("IO_ERROR", "Native provider HTTP failed or timed out.", &request.request_id))? };
        if response.status().is_redirection() { return Err(error("IO_ERROR", "Native provider redirects are not permitted.", &request.request_id)); }
        let status = response.status().as_u16(); let mut response_headers = BTreeMap::new();
        for name in ["content-type", "retry-after", "x-request-id", "request-id"] { if let Some(value) = response.headers().get(name).and_then(|value| value.to_str().ok()) { response_headers.insert(name.to_string(), value.chars().take(4096).collect::<String>()); } }
        let transfer_id = uuid::Uuid::new_v4().to_string();
        let mut assigned_transfer = operation.transfer_id.lock().expect("transfer id poisoned");
        if operation.token.is_cancelled() || session.closed.load(Ordering::SeqCst) { return Err(error("CANCELLED", "Native response cancelled before transfer assignment.", &request.request_id)); }
        *assigned_transfer = Some(transfer_id.clone());
        session.sources.lock().expect("sources poisoned").insert(transfer_id.clone(), Arc::new(tokio::sync::Mutex::new(Source { request_id: request.request_id.clone(), response, remainder: Bytes::new(), sequence: 0, offset: 0, pending: BTreeMap::new(), final_chunk: false, idle_ms: request.timeout.idle_ms })));
        drop(assigned_transfer);
        Ok(json!({"requestId":request.request_id,"status":status,"headers":response_headers,"bodyTransferId":transfer_id}))
    }.await;
    if result.is_err() {
        host.finish(&session, &request.request_id);
    }
    result
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteMetadata {
    session_id: String,
    transfer_id: String,
    sequence: u32,
    offset: usize,
    r#final: bool,
}
#[tauri::command]
pub async fn native_host_write_chunk(
    window: WebviewWindow,
    host: State<'_, Arc<NativeHost>>,
    request: tauri::ipc::Request<'_>,
) -> Result<Value> {
    local_window(&window)?;
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else {
        return Err(error(
            "INVALID_REQUEST",
            "Host chunks require a binary IPC body.",
            "chunk",
        ));
    };
    if body.len() < 4 || body.len() > CHUNK_BYTES + 4100 {
        return Err(error(
            "INVALID_REQUEST",
            "Native chunk frame exceeds its bound.",
            "chunk",
        ));
    }
    let header_len = u32::from_le_bytes(body[..4].try_into().expect("four byte prefix")) as usize;
    if header_len > 4096 || 4 + header_len > body.len() {
        return Err(error(
            "INVALID_REQUEST",
            "Invalid native chunk metadata length.",
            "chunk",
        ));
    }
    let metadata: WriteMetadata = serde_json::from_slice(&body[4..4 + header_len])
        .map_err(|_| error("INVALID_REQUEST", "Invalid native chunk metadata.", "chunk"))?;
    host.session(&metadata.session_id, window.label())?;
    let bytes = &body[4 + header_len..];
    if host
        .files
        .has_stage(&metadata.session_id, &metadata.transfer_id)
    {
        return host
            .files
            .write(
                metadata.session_id,
                metadata.transfer_id,
                metadata.sequence,
                metadata.offset as u64,
                metadata.r#final,
                bytes.to_vec(),
            )
            .await;
    }
    let mut stages = host.stages.lock().expect("stages poisoned");
    let stage = stages
        .get_mut(&metadata.transfer_id)
        .filter(|stage| stage.owner == metadata.session_id)
        .ok_or_else(|| {
            error(
                "NOT_FOUND",
                "Staged transfer does not belong to this native session.",
                &metadata.transfer_id,
            )
        })?;
    if stage.final_chunk
        || stage.verified
        || stage.sequence != metadata.sequence
        || stage.size != metadata.offset
        || bytes.len() > CHUNK_BYTES
        || bytes.is_empty() && !metadata.r#final
        || stage.size + bytes.len() > STAGE_BYTES
        || stage
            .expected_bytes
            .is_some_and(|expected| stage.size + bytes.len() > expected)
    {
        return Err(error(
            "INVALID_REQUEST",
            "Invalid chunk sequence, offset, final state or size.",
            &stage.request_id,
        ));
    }
    host.charge(bytes.len(), &stage.request_id)?;
    stage.chunks.push(bytes.to_vec());
    stage.size += bytes.len();
    stage.sequence += 1;
    stage.final_chunk = metadata.r#final;
    Ok(
        json!({"transferId":metadata.transfer_id,"sequence":metadata.sequence,"committedOffset":stage.size}),
    )
}

#[tauri::command]
pub async fn native_host_read_chunk(
    window: WebviewWindow,
    host: State<'_, Arc<NativeHost>>,
    session_id: String,
    transfer_id: String,
) -> Result<tauri::ipc::Response> {
    local_window(&window)?;
    let host = host.inner().clone();
    let session = host.session(&session_id, window.label())?;
    if host.files.has_source(&session_id, &transfer_id) {
        let result = host
            .files
            .read(session_id.clone(), transfer_id.clone())
            .await;
        if result.as_ref().is_err_and(|value| value.code == "IO_ERROR") {
            host.files.release(&session_id, &transfer_id);
        }
        return result.map(tauri::ipc::Response::new);
    }
    let source = session
        .sources
        .lock()
        .expect("sources poisoned")
        .get(&transfer_id)
        .cloned()
        .ok_or_else(|| {
            error(
                "NOT_FOUND",
                "Native source transfer is absent or belongs to another session.",
                &transfer_id,
            )
        })?;
    let mut source = source.try_lock().map_err(|_| {
        error(
            "CONFLICT",
            "Another native source read is pending.",
            &transfer_id,
        )
    })?;
    if source.final_chunk {
        return Err(error(
            "CONFLICT",
            "Native source already reached its final chunk.",
            &transfer_id,
        ));
    }
    if source.pending.len() >= IN_FLIGHT {
        return Err(error(
            "OVERLOADED",
            "Acknowledge a native chunk before reading more.",
            &transfer_id,
        ));
    }
    let request_id = source.request_id.clone();
    let operation = session
        .operations
        .lock()
        .expect("operations poisoned")
        .get(&request_id)
        .cloned()
        .ok_or_else(|| error("CLOSED", "Native HTTP operation is absent.", &request_id))?;
    let result = async {
        if source.remainder.is_empty() {
            let idle = source.idle_ms;
            let chunk = tokio::select! { _ = operation.token.cancelled() => return Err(error(if operation.timed_out.load(Ordering::SeqCst) { "IO_ERROR" } else { "CANCELLED" }, "Native source cancelled or exceeded its total deadline.", &request_id)), chunk = tokio::time::timeout(Duration::from_millis(idle), source.response.chunk()) => chunk.map_err(|_| error("IO_ERROR", "Native source idle deadline elapsed.", &request_id))?.map_err(|_| error("IO_ERROR", "Native source read failed or timed out.", &request_id))? };
            match chunk { None => source.final_chunk = true, Some(bytes) if bytes.len() <= 1_048_576 && !bytes.is_empty() => source.remainder = bytes, Some(_) => return Err(error("IO_ERROR", "Native upstream chunk exceeds its bound.", &request_id)) }
        }
        let count = source.remainder.len().min(CHUNK_BYTES); let bytes = source.remainder.split_to(count);
        let sequence = source.sequence; let offset = source.offset; let final_chunk = source.final_chunk;
        source.sequence = source.sequence.checked_add(1).ok_or_else(|| error("INVALID_REQUEST", "Native source sequence overflow.", &request_id))?;
        source.offset = source.offset.checked_add(count as u64).filter(|offset| *offset <= 9_007_199_254_740_991).ok_or_else(|| error("INVALID_REQUEST", "Native source offset overflow.", &request_id))?;
        let end = source.offset; source.pending.insert(sequence, end);
        let mut frame = Vec::with_capacity(24 + count); frame.extend_from_slice(b"QH01"); frame.extend_from_slice(&sequence.to_le_bytes()); frame.extend_from_slice(&offset.to_le_bytes()); frame.extend_from_slice(&(u32::from(final_chunk)).to_le_bytes()); frame.extend_from_slice(&(count as u32).to_le_bytes()); frame.extend_from_slice(&bytes);
        Ok(tauri::ipc::Response::new(frame))
    }.await;
    drop(source);
    if result.is_err() {
        host.release_source(&session, &transfer_id);
        host.finish(&session, &request_id);
    }
    result
}

pub fn builder(host: NativeHost) -> tauri::Builder<tauri::Wry> {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri::plugin::Builder::<tauri::Wry, ()>::new("quixi-native-oauth")
            .on_event(|app, event| {
                #[cfg(target_os = "macos")]
                if let tauri::RunEvent::Opened { urls } = event {
                    app.state::<Arc<NativeHost>>().oauth.opened(urls);
                }
                #[cfg(not(target_os = "macos"))]
                let _ = (app, event);
            }).build())
        .manage(Arc::new(host))
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                let host = webview.state::<Arc<NativeHost>>();
                let ids: Vec<_> = host.sessions.lock().expect("sessions poisoned").iter()
                    .filter(|(_, session)| session.owner == webview.label()).map(|(id, _)| id.clone()).collect();
                for id in ids { let _ = host.close(&id, webview.label()); }
            }
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                let host = window.state::<Arc<NativeHost>>();
                let ids: Vec<_> = host
                    .sessions
                    .lock()
                    .expect("sessions poisoned")
                    .iter()
                    .filter(|(_, session)| session.owner == window.label())
                    .map(|(id, _)| id.clone())
                    .collect();
                for id in ids {
                    let _ = host.close(&id, window.label());
                }
            }
        });
    #[cfg(feature = "host-proof")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        native_host_open,
        native_host_call,
        native_host_write_chunk,
        native_host_read_chunk,
        crate::host_proof::native_host_proof_report,
        crate::host_proof::native_host_proof_stats
    ]);
    #[cfg(not(feature = "host-proof"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        native_host_open,
        native_host_call,
        native_host_write_chunk,
        native_host_read_chunk
    ]);
    builder
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FileArgs {
    request_id: String,
    file_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChooseOptions {
    multiple: bool,
    media_types: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ChooseArgs {
    request_id: String,
    options: ChooseOptions,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveFile {
    name: String,
    media_type: String,
    transfer_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveArgs {
    request_id: String,
    file: SaveFile,
}
