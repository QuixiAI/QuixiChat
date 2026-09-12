//! The loopback service serving the embedded UI and streaming chat API.
//!
//! There is no configuration here. The port is ephemeral, the interface is
//! always `127.0.0.1`, and the session token is generated per launch — none of
//! it is a setting, because none of it is an editorial choice.

mod llm_service;
mod routes;

use llm_service::{ChatStreamEvent, LlmService};

use std::{
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use anyhow::{Context, Result};
use axum::{
    Router,
    http::{HeaderValue, header},
    response::{Html, IntoResponse, Response},
};
use rand::Rng;
use tokio::net::TcpListener;

/// A bound-but-not-yet-running local service.
///
/// Binding before serving means the caller learns the port — and can point a
/// window at it — without racing the server task.
pub struct Server {
    listener: TcpListener,
    address: SocketAddr,
    token: String,
    model_path: PathBuf,
}

impl Server {
    /// Bind an ephemeral loopback port.
    pub async fn bind(model_path: PathBuf) -> Result<Self> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
            .await
            .context("failed to bind the local service to 127.0.0.1")?;
        let address = listener
            .local_addr()
            .context("failed to read the bound address")?;
        Ok(Self {
            listener,
            address,
            token: session_token(),
            model_path,
        })
    }

    /// The URL the desktop window should load.
    #[must_use]
    pub fn url(&self) -> String {
        format!("http://{}/?t={}", self.address, self.token)
    }

    /// Serve until `shutdown` resolves.
    pub async fn run(self, shutdown: impl Future<Output = ()> + Send + 'static) -> Result<()> {
        let state = routes::State {
            token: self.token,
            llm: LlmService::spawn(self.model_path),
        };

        let api = Router::new()
            .route("/chat", axum::routing::post(routes::chat))
            .route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                routes::require_token,
            ))
            .with_state(state);

        let app = Router::new().nest("/api", api).fallback(index);

        tracing::info!(address = %self.address, "local service listening");
        axum::serve(self.listener, app)
            .with_graceful_shutdown(shutdown)
            .await
            .context("the local service stopped unexpectedly")
    }
}

/// The complete dependency-free UI, embedded in the binary.
async fn index() -> Response {
    let mut response = Html(include_str!("index.html")).into_response();
    response.headers_mut().insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        ),
    );
    response
}

/// A per-launch token, so only the window we opened can call the API.
///
/// Loopback binding already excludes other machines; this excludes other
/// processes on this one.
fn session_token() -> String {
    let bytes: [u8; 16] = rand::rng().random();
    bytes.iter().fold(String::with_capacity(32), |mut acc, b| {
        use std::fmt::Write as _;
        let _ = write!(acc, "{b:02x}");
        acc
    })
}
