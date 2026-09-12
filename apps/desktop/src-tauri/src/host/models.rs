use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const CHUNK_BYTES: usize = 65_536;
pub const IN_FLIGHT: usize = 4;
pub const STAGE_BYTES: usize = 8 * 1024 * 1024;
pub const BUFFER_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Binding {
    pub provider_id: String,
    pub account_id: String,
    pub destination_id: String,
    pub transport_id: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretHandle {
    pub id: String,
    pub persistence: String,
    pub binding: Binding,
}
#[derive(Clone)]
pub struct Route {
    pub path: String,
    pub methods: Vec<String>,
    pub headers: Vec<String>,
    /// Query parameter names this route accepts; empty for none.
    pub query: Vec<String>,
}
#[derive(Clone)]
pub struct Destination {
    pub binding: Binding,
    pub origin: reqwest::Url,
    pub routes: Vec<Route>,
    pub credential_header: String,
    pub credential_prefix: String,
    pub privacy: String,
    pub allow_loopback_http: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Timeouts {
    pub connect_ms: u64,
    pub idle_ms: u64,
    pub total_ms: u64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HttpRequest {
    pub request_id: String,
    pub binding: Binding,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub query: BTreeMap<String, String>,
    pub headers: BTreeMap<String, String>,
    pub credential: Option<SecretHandle>,
    pub body_transfer_id: Option<String>,
    pub timeout: Timeouts,
}
#[derive(Clone, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostError {
    pub code: &'static str,
    pub message: &'static str,
    pub request_id: String,
    pub operation_id: Option<String>,
    pub retry: &'static str,
    pub details: BTreeMap<String, String>,
}
pub type Result<T> = std::result::Result<T, HostError>;
pub fn error(code: &'static str, message: &'static str, request_id: &str) -> HostError {
    HostError {
        code,
        message,
        request_id: request_id.to_owned(),
        operation_id: None,
        retry: if code == "UNSUPPORTED" {
            "after_user_action"
        } else {
            "never"
        },
        details: BTreeMap::new(),
    }
}
pub fn id(value: &str) -> Result<()> {
    if uuid::Uuid::parse_str(value)
        .is_ok_and(|id| id.get_version_num() == 4 && id.to_string() == value)
    {
        Ok(())
    } else {
        Err(error(
            "INVALID_REQUEST",
            "A lowercase UUIDv4 is required.",
            value,
        ))
    }
}
pub fn hash_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
