//! The local service: axum on loopback, serving the embedded UI and the API on
//! one port (spec §17). The Tauri window is pointed at it.
//!
//! There is no configuration here. The port is ephemeral, the interface is
//! always `127.0.0.1`, and the session token is generated per launch — none of
//! it is a setting, because none of it is an editorial choice (§2.11).

pub mod assets;
mod llm_service;
mod routes;

pub use llm_service::{ChatStreamEvent, LlmService, LlmState};

use std::{
    net::{Ipv4Addr, SocketAddr},
    path::PathBuf,
};

use anyhow::{Context, Result};
use axum::{Router, routing::get};
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

    #[must_use]
    pub const fn address(&self) -> SocketAddr {
        self.address
    }

    /// The URL the desktop window should load.
    #[must_use]
    pub fn url(&self) -> String {
        format!("http://{}/?t={}", self.address, self.token)
    }

    /// Serve until `shutdown` resolves.
    pub async fn run(self, shutdown: impl Future<Output = ()> + Send + 'static) -> Result<()> {
        let state = routes::State {
            address: self.address,
            token: self.token,
            llm: LlmService::spawn(self.model_path),
        };

        let api = Router::new()
            .route("/health", get(routes::health))
            .route("/chat", axum::routing::post(routes::chat))
            .route_layer(axum::middleware::from_fn_with_state(
                state.clone(),
                routes::require_token,
            ))
            .with_state(state);

        let app = Router::new()
            .nest("/api", api)
            .fallback(assets::serve)
            .layer(tower_http::trace::TraceLayer::new_for_http());

        tracing::info!(address = %self.address, "local service listening");
        axum::serve(self.listener, app)
            .with_graceful_shutdown(shutdown)
            .await
            .context("the local service stopped unexpectedly")
    }
}

/// A per-launch token, so only the window we opened can call the API (§15).
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
