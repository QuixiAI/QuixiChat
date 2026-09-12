//! Native-only OAuth authorization code + PKCE. No callback, verifier, code or
//! token is emitted to the renderer. Production registrations are opt-in Rust
//! values; browser requests never select endpoints, redirect URIs or clients.
use super::{NativeHost, Session, models::*};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, VecDeque},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::{sync::oneshot, time::Instant};
use tokio_util::sync::CancellationToken;
use zeroize::{Zeroize, Zeroizing};

const WAITING: u8 = 0;
const EXCHANGING: u8 = 1;
const COMMITTING: u8 = 2;
const CANCELLED: u8 = 3;
const COMPLETE: u8 = 4;
const MAX_PENDING: usize = 4;
const MAX_RECEIPTS: usize = 64;

#[derive(Clone)]
pub struct OAuthConfiguration {
    pub id: String,
    pub binding: Binding,
    pub authorization_endpoint: String,
    pub token_endpoint: String,
    pub redirect_uri: String,
    pub issuer: String,
    pub client_id: String,
    pub allowed_scopes: Vec<String>,
    pub timeout_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct OAuthArgs {
    request_id: String,
    provider_id: String,
    configuration_id: String,
    scopes: Vec<String>,
}
struct Flow {
    request: String,
    owner: String,
    session: std::sync::Weak<Session>,
    configuration: OAuthConfiguration,
    state: Zeroizing<String>,
    deadline: Instant,
    phase: AtomicU8,
    abandoned: AtomicBool,
    dispatched: AtomicBool,
    cancellation: CancellationToken,
    callback: Mutex<Option<oneshot::Sender<Result<Zeroizing<String>>>>>,
}
impl Flow {
    fn stop(&self) -> bool {
        self.abandoned.store(true, Ordering::SeqCst);
        self.cancellation.cancel();
        loop {
            let phase = self.phase.load(Ordering::SeqCst);
            if phase == COMMITTING {
                return false;
            }
            if phase == CANCELLED || phase == COMPLETE {
                return true;
            }
            if self
                .phase
                .compare_exchange(phase, CANCELLED, Ordering::SeqCst, Ordering::SeqCst)
                .is_ok()
            {
                return true;
            }
        }
    }
    fn active(&self, session: &Session) -> Result<()> {
        if self.abandoned.load(Ordering::SeqCst)
            || session.closed.load(Ordering::SeqCst)
            || Instant::now() >= self.deadline
        {
            self.stop();
            return Err(error(
                "CANCELLED",
                "OAuth was cancelled, closed or expired.",
                &self.request,
            ));
        }
        Ok(())
    }
    fn commit(&self, session: &Session) -> Result<()> {
        self.active(session)?;
        self.phase
            .compare_exchange(EXCHANGING, COMMITTING, Ordering::SeqCst, Ordering::SeqCst)
            .map_err(|_| {
                error(
                    "CANCELLED",
                    "OAuth was cancelled before credential commit.",
                    &self.request,
                )
            })?;
        // Close/cancel can arrive between the first check and the CAS. Refuse
        // that write too; after the cutoff report conservatively as unknown.
        if session.closed.load(Ordering::SeqCst)
            || self.abandoned.load(Ordering::SeqCst)
            || Instant::now() >= self.deadline
        {
            self.abandoned.store(true, Ordering::SeqCst);
            return Err(OAuthManager::unknown(&self.request));
        }
        Ok(())
    }
    fn cancellation_result(&self) -> Value {
        let prevented = self.stop();
        json!({"requestId":self.request,"outcome":if prevented {"cancelled"} else {"unknown_outcome"},"externalEffect":if self.dispatched.load(Ordering::SeqCst) || !prevented {"may_have_occurred"} else {"not_dispatched"}})
    }
}
struct Receipt {
    request: String,
    owner: String,
    outcome: &'static str,
    dispatched: bool,
}
#[derive(Default)]
struct Inner {
    live: HashMap<String, Arc<Flow>>,
    receipts: VecDeque<Receipt>,
}
#[cfg(feature = "oauth-proof")]
type ProofOpener = Arc<dyn Fn(&str) -> std::result::Result<(), String> + Send + Sync>;
#[cfg(feature = "oauth-proof")]
struct Proof {
    address: std::net::SocketAddr,
    certificate: reqwest::Certificate,
    opener: ProofOpener,
    commit: Option<Arc<dyn Fn() + Send + Sync>>,
}
pub(super) struct OAuthManager {
    configurations: Vec<OAuthConfiguration>,
    inner: Mutex<Inner>,
    opened_events: AtomicUsize,
    accepted_callbacks: AtomicUsize,
    rejected_callbacks: AtomicUsize,
    token_exchanges: AtomicUsize,
    #[cfg(feature = "oauth-proof")]
    proof: Option<Proof>,
}
fn safe_text(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && value.bytes().all(|b| (33..=126).contains(&b))
}
fn endpoint(value: &str) -> bool {
    if value.len() > 2048 {
        return false;
    }
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && url.as_str() == value
    })
}
fn issuer(value: &str) -> bool {
    if !safe_text(value, 1024) {
        return false;
    }
    reqwest::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
            && (url.as_str() == value || url.path() == "/" && url.as_str() == format!("{value}/"))
    })
}
fn redirect(value: &str) -> bool {
    if value.len() > 256 {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    let scheme = url.scheme() == "ai.quixi.chat";
    #[cfg(feature = "oauth-proof")]
    let scheme = scheme
        || url
            .scheme()
            .strip_prefix("ai.quixi.chat.oauth-proof.")
            .is_some_and(|suffix| id(suffix).is_ok());
    scheme
        && value.len() <= 256
        && url.host_str() == Some("oauth")
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.as_str() == value
        && url.path().starts_with('/')
        && !url.path().contains(['%', '\\'])
        && url.path().split('/').skip(1).all(|part| {
            !part.is_empty()
                && part
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
}
fn random_secret(request: &str) -> Result<Zeroizing<String>> {
    let mut random = [0u8; 32];
    getrandom::fill(&mut random)
        .map_err(|_| error("IO_ERROR", "Native OAuth entropy is unavailable.", request))?;
    let encoded = Zeroizing::new(URL_SAFE_NO_PAD.encode(random));
    random.zeroize();
    Ok(encoded)
}
fn equal_secret(a: &str, b: &str) -> bool {
    a.len() == b.len()
        && a.bytes()
            .zip(b.bytes())
            .fold(0u8, |different, (x, y)| different | (x ^ y))
            == 0
}
/// Parse exactly once; keys cannot be percent-encoded, duplicated or unknown.
/// Redirect comparison occurs on the literal base before URL parsing. Invalid
/// encodings/UTF-8/control bytes are rejected instead of replacement-decoded.
fn callback(raw: &str, expected: &str) -> Option<BTreeMap<String, Zeroizing<String>>> {
    if raw.len() > 8192 || raw.bytes().any(|b| b < 32 || b == 127) || raw.contains('#') {
        return None;
    }
    let (base, query) = raw.split_once('?')?;
    if base != expected || !redirect(base) || query.is_empty() {
        return None;
    }
    let mut fields = BTreeMap::new();
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=')?;
        if ![
            "code",
            "state",
            "iss",
            "error",
            "error_description",
            "error_uri",
        ]
        .contains(&key)
            || fields.contains_key(key)
        {
            return None;
        }
        let mut bytes = Zeroizing::new(Vec::with_capacity(value.len()));
        let input = value.as_bytes();
        let mut at = 0;
        while at < input.len() {
            match input[at] {
                b'%' => {
                    if at + 2 >= input.len() {
                        return None;
                    }
                    let hex = |b: u8| (b as char).to_digit(16).map(|n| n as u8);
                    bytes.push(hex(input[at + 1])? * 16 + hex(input[at + 2])?);
                    at += 3;
                }
                b'+' => {
                    bytes.push(b' ');
                    at += 1;
                }
                byte => {
                    bytes.push(byte);
                    at += 1;
                }
            }
        }
        let decoded = std::str::from_utf8(&bytes).ok()?;
        if (decoded.is_empty() && !["error_description", "error_uri"].contains(&key))
            || decoded.chars().any(char::is_control)
            || decoded.len() > if key == "code" { 4096 } else { 1024 }
        {
            return None;
        }
        fields.insert(key.to_string(), Zeroizing::new(decoded.to_string()));
    }
    if !fields.contains_key("state")
        || !fields.contains_key("iss")
        || fields.contains_key("code") == fields.contains_key("error")
        || (fields.contains_key("code") && fields.len() != 3)
        || fields.len() > 5
    {
        return None;
    }
    Some(fields)
}
impl OAuthManager {
    pub(super) fn new(
        configurations: Vec<OAuthConfiguration>,
        destinations: &[Destination],
    ) -> std::result::Result<Self, String> {
        if configurations.len() > 32 {
            return Err("OAuth registration count exceeds its bound".into());
        }
        let mut ids = std::collections::HashSet::new();
        for config in &configurations {
            if !safe_text(&config.id, 128)
                || !ids.insert(config.id.clone())
                || !endpoint(&config.authorization_endpoint)
                || !endpoint(&config.token_endpoint)
                || !issuer(&config.issuer)
                || !redirect(&config.redirect_uri)
                || !safe_text(&config.client_id, 256)
                || !(1..=300_000).contains(&config.timeout_ms)
                || config.allowed_scopes.len() > 32
                || config.allowed_scopes.iter().any(|scope| {
                    !safe_text(scope, 128)
                        || scope.contains(['"', '\\'])
                        || scope == "offline_access"
                })
                || config
                    .allowed_scopes
                    .iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
                    != config.allowed_scopes.len()
                || !destinations.iter().any(|d| {
                    d.binding == config.binding
                        && d.credential_header.eq_ignore_ascii_case("authorization")
                        && d.credential_prefix == "Bearer "
                })
            {
                return Err("OAuth registration does not match the host-owned HTTPS, callback, scope or credential binding policy".into());
            }
        }
        Ok(Self {
            configurations,
            inner: Mutex::new(Inner::default()),
            opened_events: AtomicUsize::new(0),
            accepted_callbacks: AtomicUsize::new(0),
            rejected_callbacks: AtomicUsize::new(0),
            token_exchanges: AtomicUsize::new(0),
            #[cfg(feature = "oauth-proof")]
            proof: None,
        })
    }
    pub(super) fn available(&self) -> bool {
        cfg!(target_os = "macos") && !self.configurations.is_empty()
    }
    #[cfg(feature = "oauth-proof")]
    pub(super) fn with_proof(
        mut self,
        port: u16,
        pem: &[u8],
        opener: ProofOpener,
    ) -> std::result::Result<Self, String> {
        if port == 0
            || pem.is_empty()
            || pem.len() > 65_536
            || self.configurations.is_empty()
            || self.configurations.iter().any(|c| {
                [&c.authorization_endpoint, &c.token_endpoint]
                    .iter()
                    .any(|value| {
                        reqwest::Url::parse(value).map_or(true, |url| {
                            url.host_str() != Some("oauth.synthetic.invalid")
                                || url.port().is_some()
                        })
                    })
            })
        {
            return Err(
                "OAuth fixture requires a bounded CA and exact synthetic HTTPS endpoints".into(),
            );
        }
        let certificate = reqwest::Certificate::from_pem(pem)
            .map_err(|_| "OAuth fixture CA is invalid".to_string())?;
        self.proof = Some(Proof {
            address: ([127, 0, 0, 1], port).into(),
            certificate,
            opener,
            commit: None,
        });
        Ok(self)
    }
    #[cfg(feature = "oauth-proof")]
    pub(super) fn with_commit_proof(
        mut self,
        hook: Arc<dyn Fn() + Send + Sync>,
    ) -> std::result::Result<Self, String> {
        self.proof
            .as_mut()
            .ok_or_else(|| {
                "OAuth commit proof requires the isolated TLS/opener fixture".to_string()
            })?
            .commit = Some(hook);
        Ok(self)
    }
    #[cfg(feature = "oauth-proof")]
    pub(super) fn proof_stats(&self) -> Value {
        json!({"openedEvents":self.opened_events.load(Ordering::SeqCst),"acceptedCallbacks":self.accepted_callbacks.load(Ordering::SeqCst),"rejectedCallbacks":self.rejected_callbacks.load(Ordering::SeqCst),"tokenExchanges":self.token_exchanges.load(Ordering::SeqCst)})
    }
    pub(super) fn opened(&self, urls: &[reqwest::Url]) {
        self.opened_events.fetch_add(1, Ordering::SeqCst);
        // Tauri supplies parsed URLs; no callback is navigated or re-emitted.
        for url in urls.iter().take(16) {
            if !self.deliver(url.as_str()) {
                self.rejected_callbacks.fetch_add(1, Ordering::SeqCst);
            }
        }
    }
    fn deliver(&self, raw: &str) -> bool {
        if raw.len() > 8192 {
            return false;
        }
        let inner = self.inner.lock().expect("OAuth manager poisoned");
        for flow in inner.live.values() {
            if flow.phase.load(Ordering::SeqCst) != WAITING
                || flow.abandoned.load(Ordering::SeqCst)
                || Instant::now() >= flow.deadline
            {
                continue;
            }
            let Some(mut fields) = callback(raw, &flow.configuration.redirect_uri) else {
                continue;
            };
            if !equal_secret(&fields["state"], &flow.state)
                || *fields["iss"] != flow.configuration.issuer
            {
                continue;
            }
            if flow
                .phase
                .compare_exchange(WAITING, EXCHANGING, Ordering::SeqCst, Ordering::SeqCst)
                .is_err()
            {
                continue;
            }
            let result = if fields.contains_key("error") {
                Err(error(
                    "IO_ERROR",
                    "OAuth authorization was declined or failed.",
                    &flow.request,
                ))
            } else {
                Ok(fields.remove("code").expect("validated callback code"))
            };
            if let Some(sender) = flow
                .callback
                .lock()
                .expect("OAuth callback poisoned")
                .take()
            {
                let _ = sender.send(result);
            }
            self.accepted_callbacks.fetch_add(1, Ordering::SeqCst);
            return true;
        }
        false
    }
    pub(super) fn ensure_request_unused(&self, owner: &str, request: &str) -> Result<()> {
        let inner = self.inner.lock().expect("OAuth manager poisoned");
        if inner.live.get(request).is_some_and(|f| f.owner == owner)
            || inner
                .receipts
                .iter()
                .any(|r| r.owner == owner && r.request == request)
        {
            return Err(error(
                "CONFLICT",
                "Native request identity belongs to OAuth.",
                request,
            ));
        }
        Ok(())
    }
    pub(super) fn cancel(&self, owner: &str, request: &str) -> Option<Value> {
        let inner = self.inner.lock().expect("OAuth manager poisoned");
        if let Some(flow) = inner.live.get(request).filter(|flow| flow.owner == owner) {
            return Some(flow.cancellation_result());
        }
        inner.receipts.iter().find(|r| r.request == request && r.owner == owner).map(|r| json!({"requestId":request,"outcome":r.outcome,"externalEffect":if r.dispatched {"may_have_occurred"} else {"not_dispatched"}}))
    }
    pub(super) fn close(&self, owner: &str) {
        let mut inner = self.inner.lock().expect("OAuth manager poisoned");
        for flow in inner.live.values().filter(|f| f.owner == owner) {
            flow.stop();
        }
        inner.receipts.retain(|receipt| receipt.owner != owner);
    }
    pub(super) fn invalidate_binding(&self, binding: &Binding, request: &str) -> Result<()> {
        let mut committing = false;
        for flow in self
            .inner
            .lock()
            .expect("OAuth manager poisoned")
            .live
            .values()
            .filter(|f| &f.configuration.binding == binding)
        {
            committing |= !flow.stop();
        }
        if committing {
            Err(Self::unknown(request))
        } else {
            Ok(())
        }
    }
    fn finish(&self, flow: &Flow, mut result: Result<Value>) -> Result<Value> {
        let mut inner = self.inner.lock().expect("OAuth manager poisoned");
        if inner.live.remove(&flow.request).is_none() {
            return result;
        }
        let closed = flow
            .session
            .upgrade()
            .is_none_or(|session| session.closed.load(Ordering::SeqCst));
        if result.is_ok() && (closed || flow.abandoned.load(Ordering::SeqCst)) {
            result = Err(if flow.phase.load(Ordering::SeqCst) == COMMITTING {
                Self::unknown(&flow.request)
            } else {
                error(
                    "CANCELLED",
                    "OAuth owner was closed before completion.",
                    &flow.request,
                )
            });
        }
        let unknown = result
            .as_ref()
            .err()
            .is_some_and(|value| value.code == "UNKNOWN_OUTCOME");
        let cancelled = flow.phase.load(Ordering::SeqCst) == CANCELLED;
        flow.phase.store(COMPLETE, Ordering::SeqCst);
        // Refuse new admission when this bounded receipt table fills; never
        // silently reuse a completed request ID within this native host lifetime.
        if !closed {
            inner.receipts.push_back(Receipt {
                request: flow.request.clone(),
                owner: flow.owner.clone(),
                outcome: if unknown {
                    "unknown_outcome"
                } else if cancelled {
                    "cancelled"
                } else {
                    "already_completed"
                },
                dispatched: flow.dispatched.load(Ordering::SeqCst) || unknown,
            });
        }
        result
    }
    fn unknown(request: &str) -> HostError {
        let mut value = error(
            "UNKNOWN_OUTCOME",
            "OAuth reached credential commit; reopen its exact binding to reconcile the outcome.",
            request,
        );
        value.retry = "after_user_action";
        value
    }
    pub(super) async fn start(
        self: Arc<Self>,
        host: Arc<NativeHost>,
        session: Arc<Session>,
        args: OAuthArgs,
    ) -> Result<Value> {
        id(&args.request_id)?;
        if args.provider_id.len() > 256
            || args.configuration_id.len() > 128
            || args.scopes.iter().any(|scope| scope.len() > 128)
        {
            return Err(error(
                "INVALID_REQUEST",
                "OAuth request metadata exceeds its bounds.",
                &args.request_id,
            ));
        }
        if !self.available() || !host.secrets.available {
            return Err(error(
                "UNSUPPORTED",
                "Native OAuth has no available host-owned registration on this platform.",
                &args.request_id,
            ));
        }
        let config = self
            .configurations
            .iter()
            .find(|c| c.id == args.configuration_id && c.binding.provider_id == args.provider_id)
            .cloned()
            .ok_or_else(|| {
                error(
                    "INVALID_REQUEST",
                    "OAuth provider configuration is not registered.",
                    &args.request_id,
                )
            })?;
        if args.scopes.len() > 32
            || args
                .scopes
                .iter()
                .any(|s| !config.allowed_scopes.contains(s))
            || args
                .scopes
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != args.scopes.len()
        {
            return Err(error(
                "INVALID_REQUEST",
                "OAuth scopes exceed the registered allowlist.",
                &args.request_id,
            ));
        }
        let (sender, receiver) = oneshot::channel();
        let flow = Arc::new(Flow {
            request: args.request_id.clone(),
            owner: session.id.clone(),
            session: Arc::downgrade(&session),
            configuration: config,
            state: random_secret(&args.request_id)?,
            deadline: Instant::now()
                + Duration::from_millis(
                    self.configurations
                        .iter()
                        .find(|c| c.id == args.configuration_id)
                        .unwrap()
                        .timeout_ms,
                ),
            phase: AtomicU8::new(WAITING),
            abandoned: AtomicBool::new(false),
            dispatched: AtomicBool::new(false),
            cancellation: CancellationToken::new(),
            callback: Mutex::new(Some(sender)),
        });
        {
            // Cross-registry admission uses operations -> OAuth lock order.
            let operations = session.operations.lock().expect("operations poisoned");
            if operations.contains_key(&flow.request) {
                return Err(error(
                    "CONFLICT",
                    "Native request identity belongs to HTTP.",
                    &flow.request,
                ));
            }
            let mut inner = self.inner.lock().expect("OAuth manager poisoned");
            if inner.live.contains_key(&flow.request)
                || inner.receipts.iter().any(|r| r.request == flow.request)
            {
                return Err(error(
                    "CONFLICT",
                    "OAuth request identity was already admitted.",
                    &flow.request,
                ));
            }
            if inner.live.len() >= MAX_PENDING
                || inner.receipts.len() + inner.live.len() >= MAX_RECEIPTS
            {
                return Err(error(
                    "OVERLOADED",
                    "Native OAuth pending or receipt admission limit reached.",
                    &flow.request,
                ));
            }
            if inner
                .live
                .values()
                .any(|f| f.configuration.binding == flow.configuration.binding)
            {
                return Err(error(
                    "CONFLICT",
                    "OAuth is already pending for this credential binding.",
                    &flow.request,
                ));
            }
            inner.live.insert(flow.request.clone(), flow.clone());
        }
        let result = self
            .run(host, session, flow.clone(), args.scopes, receiver)
            .await;
        if !result.1 {
            self.finish(&flow, result.0)
        } else {
            result.0
        }
    }
    async fn run(
        self: &Arc<Self>,
        host: Arc<NativeHost>,
        session: Arc<Session>,
        flow: Arc<Flow>,
        scopes: Vec<String>,
        receiver: oneshot::Receiver<Result<Zeroizing<String>>>,
    ) -> (Result<Value>, bool) {
        let prepare = async {
            flow.active(&session)?;
            let destination = host.destination(&flow.configuration.binding, &flow.request)?;
            let authority = json!([destination.origin.as_str(), destination.credential_header.to_ascii_lowercase(), destination.credential_prefix]).to_string();
            let permit = host.secret_permits.clone().try_acquire_owned().map_err(|_| error("OVERLOADED", "Native keychain actor admission limit reached.", &flow.request))?;
            let secrets = host.secrets.clone(); let binding = flow.configuration.binding.clone(); let request = flow.request.clone(); let read_authority = authority.clone();
            let opened = tokio::task::spawn_blocking(move || { let _permit=permit; secrets.open(&binding,&read_authority,&request) });
            let existing = tokio::select! { biased;
                _ = flow.cancellation.cancelled() => return Err(error("CANCELLED", "OAuth cancelled before authorization.", &flow.request)),
                _ = tokio::time::sleep_until(flow.deadline) => { flow.stop(); return Err(error("CANCELLED", "OAuth deadline elapsed.", &flow.request)); },
                result = opened => result.map_err(|_| error("INTERNAL", "Native credential actor failed.", &flow.request))??,
            };
            if existing.is_some() { return Err(error("CONFLICT", "Disconnect the existing credential before authorizing this binding.", &flow.request)); }
            flow.active(&session)?;
            let verifier = random_secret(&flow.request)?;
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
            let mut authorization = reqwest::Url::parse(&flow.configuration.authorization_endpoint).map_err(|_|error("INTERNAL","OAuth registration is unavailable.",&flow.request))?;
            authorization.query_pairs_mut().append_pair("response_type","code").append_pair("client_id",&flow.configuration.client_id).append_pair("redirect_uri",&flow.configuration.redirect_uri).append_pair("scope",&scopes.join(" ")).append_pair("state",&flow.state).append_pair("code_challenge",&challenge).append_pair("code_challenge_method","S256");
            if authorization.as_str().len()>8192 { return Err(error("INVALID_REQUEST","OAuth authorization URL exceeds its bound.",&flow.request)); }
            // Opening is an external effect even if the OS subsequently reports failure.
            flow.dispatched.store(true, Ordering::SeqCst);
            flow.active(&session)?;
            self.open_authorization(authorization.as_str(), &flow.request)?;
            let code = tokio::select! { biased;
                _ = flow.cancellation.cancelled() => return Err(error("CANCELLED", "OAuth authorization was cancelled.", &flow.request)),
                _ = tokio::time::sleep_until(flow.deadline) => { flow.stop(); return Err(error("CANCELLED", "OAuth authorization expired.", &flow.request)); },
                result = receiver => result.map_err(|_|error("CANCELLED","OAuth callback wait was closed.",&flow.request))??,
            };
            flow.active(&session)?;
            let access_token = tokio::select! { biased;
                _ = flow.cancellation.cancelled() => return Err(error("CANCELLED", "OAuth token exchange was cancelled.", &flow.request)),
                _ = tokio::time::sleep_until(flow.deadline) => { flow.stop(); return Err(error("CANCELLED", "OAuth token exchange expired.", &flow.request)); },
                result = self.exchange(&flow,&code,&verifier,&scopes) => result?,
            };
            flow.active(&session)?;
            Ok((authority,access_token))
        }.await;
        let (authority, token) = match prepare {
            Ok(value) => value,
            Err(value) => return (Err(value), false),
        };
        let permit = match host.secret_permits.clone().try_acquire_owned() {
            Ok(value) => value,
            Err(_) => {
                return (
                    Err(error(
                        "OVERLOADED",
                        "Native keychain actor admission limit reached.",
                        &flow.request,
                    )),
                    false,
                );
            }
        };
        let secrets = host.secrets.clone();
        let committing = flow.clone();
        let committing_session = session.clone();
        #[cfg(feature = "oauth-proof")]
        let commit_hook = self.proof.as_ref().and_then(|proof| proof.commit.clone());
        let mut task = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            secrets.put_guarded(
                committing.configuration.binding.clone(),
                authority,
                token.to_vec(),
                None,
                &committing.request,
                || {
                    committing.commit(&committing_session)?;
                    #[cfg(feature = "oauth-proof")]
                    if let Some(hook) = commit_hook {
                        hook();
                    }
                    Ok(())
                },
            )
        });
        let committed = tokio::select! { biased;
            _ = flow.cancellation.cancelled() => None,
            _ = tokio::time::sleep_until(flow.deadline) => { flow.stop(); None },
            result = &mut task => Some(result),
        };
        match committed {
            Some(result) => {
                if flow.abandoned.load(Ordering::SeqCst) || session.closed.load(Ordering::SeqCst) {
                    return (
                        Err(if flow.phase.load(Ordering::SeqCst) == COMMITTING {
                            Self::unknown(&flow.request)
                        } else {
                            error(
                                "CANCELLED",
                                "OAuth was cancelled before credential commit.",
                                &flow.request,
                            )
                        }),
                        false,
                    );
                }
                let result = result
                    .map_err(|_| {
                        error("INTERNAL", "Native credential actor failed.", &flow.request)
                    })
                    .and_then(|r| r);
                if result.is_err() && flow.phase.load(Ordering::SeqCst) == COMMITTING {
                    return (Err(Self::unknown(&flow.request)), false);
                }
                (result.map(|credential|json!({"requestId":flow.request,"binding":flow.configuration.binding,"credential":credential})),false)
            }
            None => {
                let prevented = flow.stop();
                if prevented {
                    return (
                        Err(error(
                            "CANCELLED",
                            "OAuth was cancelled before credential commit.",
                            &flow.request,
                        )),
                        false,
                    );
                }
                let manager = self.clone();
                let detached = flow.clone();
                // Keep COMMITTING visible to binding invalidation until the OS
                // actor settles, even though the caller's deadline has elapsed.
                tokio::spawn(async move {
                    let _ = task.await;
                    let _ = manager.finish(&detached, Err(Self::unknown(&detached.request)));
                });
                (Err(Self::unknown(&flow.request)), true)
            }
        }
    }
    fn open_authorization(&self, url: &str, request: &str) -> Result<()> {
        #[cfg(feature = "oauth-proof")]
        if let Some(proof) = &self.proof {
            return (proof.opener)(url).map_err(|_| {
                error(
                    "IO_ERROR",
                    "The authorization browser could not be opened.",
                    request,
                )
            });
        }
        tauri_plugin_opener::open_url(url, None::<&str>).map_err(|_| {
            error(
                "IO_ERROR",
                "The authorization browser could not be opened.",
                request,
            )
        })
    }
    async fn exchange(
        &self,
        flow: &Flow,
        code: &str,
        verifier: &str,
        scopes: &[String],
    ) -> Result<Zeroizing<Vec<u8>>> {
        let builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .no_proxy()
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .http1_only();
        #[cfg(feature = "oauth-proof")]
        let builder = if let Some(proof) = &self.proof {
            builder
                .resolve("oauth.synthetic.invalid", proof.address)
                .add_root_certificate(proof.certificate.clone())
        } else {
            builder
        };
        let client = builder.build().map_err(|_| {
            error(
                "IO_ERROR",
                "OAuth token transport could not be initialized.",
                &flow.request,
            )
        })?;
        let body = form_body(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", &flow.configuration.redirect_uri),
            ("client_id", &flow.configuration.client_id),
            ("code_verifier", verifier),
        ]);
        self.token_exchanges.fetch_add(1, Ordering::SeqCst);
        let mut response = client
            .post(&flow.configuration.token_endpoint)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json")
            .body(body.to_vec())
            .send()
            .await
            .map_err(|_| error("IO_ERROR", "OAuth token exchange failed.", &flow.request))?;
        if response.headers().len() > 32
            || response
                .headers()
                .iter()
                .map(|(name, value)| name.as_str().len() + value.as_bytes().len())
                .sum::<usize>()
                > 8192
        {
            return Err(error(
                "IO_ERROR",
                "OAuth token headers exceed their bound.",
                &flow.request,
            ));
        }
        if !response.status().is_success() || response.content_length().is_some_and(|n| n > 32768) {
            return Err(error(
                "IO_ERROR",
                "OAuth token response was rejected.",
                &flow.request,
            ));
        }
        let mut bytes = Zeroizing::new(Vec::new());
        while let Some(chunk) = response.chunk().await.map_err(|_| {
            error(
                "IO_ERROR",
                "OAuth token response could not be read.",
                &flow.request,
            )
        })? {
            if chunk.len() > 32768 - bytes.len() {
                return Err(error(
                    "IO_ERROR",
                    "OAuth token response exceeds its bound.",
                    &flow.request,
                ));
            }
            bytes.extend_from_slice(&chunk);
        }
        token(&bytes, &flow.request, scopes)
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Token {
    access_token: String,
    token_type: String,
    expires_in: Option<u64>,
    #[serde(default, deserialize_with = "present_string")]
    scope: Option<String>,
    #[serde(default, deserialize_with = "present_string")]
    refresh_token: Option<String>,
    #[serde(default, deserialize_with = "present_string")]
    id_token: Option<String>,
}
impl Drop for Token {
    fn drop(&mut self) {
        self.access_token.zeroize();
        if let Some(v) = &mut self.refresh_token {
            v.zeroize();
        }
        if let Some(v) = &mut self.id_token {
            v.zeroize();
        }
    }
}
fn present_string<'de, D: serde::Deserializer<'de>>(
    value: D,
) -> std::result::Result<Option<String>, D::Error> {
    String::deserialize(value).map(Some)
}
fn token(bytes: &[u8], request: &str, scopes: &[String]) -> Result<Zeroizing<Vec<u8>>> {
    let token: Token = serde_json::from_slice(bytes)
        .map_err(|_| error("IO_ERROR", "OAuth token response is invalid.", request))?;
    if !token.token_type.eq_ignore_ascii_case("Bearer")
        || token.access_token.is_empty()
        || token.access_token.len() > 16384
        || !token.access_token.bytes().all(|b| (33..=126).contains(&b))
        || token
            .expires_in
            .is_some_and(|n| n == 0 || n > 9_007_199_254_740_991)
    {
        return Err(error(
            "IO_ERROR",
            "OAuth bearer token or expiry is invalid.",
            request,
        ));
    }
    if token.scope.as_ref().is_some_and(|scope| {
        !scope.is_empty()
            && (scope.split(' ').count() > 32
                || scope
                    .split(' ')
                    .any(|part| part.is_empty() || !scopes.iter().any(|allowed| allowed == part)))
    }) {
        return Err(error(
            "IO_ERROR",
            "OAuth token scope exceeds the reviewed request.",
            request,
        ));
    }
    Ok(Zeroizing::new(token.access_token.as_bytes().to_vec()))
}

fn form_body(fields: &[(&str, &str)]) -> Zeroizing<Vec<u8>> {
    let mut body = Zeroizing::new(Vec::new());
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    for (at, (key, value)) in fields.iter().enumerate() {
        if at > 0 {
            body.push(b'&');
        }
        body.extend_from_slice(key.as_bytes());
        body.push(b'=');
        for byte in value.bytes() {
            if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
                body.push(byte);
            } else if byte == b' ' {
                body.push(b'+');
            } else {
                body.extend_from_slice(&[
                    b'%',
                    HEX[usize::from(byte >> 4)],
                    HEX[usize::from(byte & 15)],
                ]);
            }
        }
    }
    body
}

#[cfg(test)]
mod tests;
