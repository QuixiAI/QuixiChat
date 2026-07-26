//! The embedded frontend.
//!
//! `frontend/dist/` is built by Vite and baked into the binary with
//! `rust-embed`, so the shipped `.app` is one file with no external web assets
//! (spec §17). When that bundle has not been built — a fresh clone, or a machine
//! without Node — we serve a self-contained fallback instead of failing, so
//! `cargo run` brings up a working window with no frontend toolchain at all.

use axum::{
    body::Body,
    extract::OriginalUri,
    http::{StatusCode, header},
    response::Response,
};
use rust_embed::RustEmbed;

#[derive(RustEmbed)]
#[folder = "../../frontend/dist/"]
struct Frontend;

/// Whether the real Vite bundle is present in this binary.
#[must_use]
pub fn bundle_present() -> bool {
    Frontend::get("index.html").is_some()
}

/// Served when `frontend/dist/` is empty. Deliberately dependency-free: no
/// build step, no framework, no network. It renders the same greeting and the
/// same health data the React app does.
const FALLBACK_INDEX: &str = include_str!("fallback.html");

pub async fn serve(OriginalUri(uri): OriginalUri) -> Response {
    let requested = uri.path().trim_start_matches('/');
    // The document is requested by `/` or by any client-side route, which has
    // no file extension. Anything with an extension is an asset.
    let wants_document = requested.is_empty() || !requested.contains('.');
    let path = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };

    if let Some(asset) = Frontend::get(path) {
        let cache = if path == "index.html" {
            "no-store"
        } else {
            "public, max-age=31536000, immutable"
        };
        return response(
            StatusCode::OK,
            mime_guess::from_path(path).first_or_octet_stream().as_ref(),
            asset.data.into_owned(),
            cache,
        );
    }

    if wants_document {
        if let Some(index) = Frontend::get("index.html") {
            return response(
                StatusCode::OK,
                "text/html; charset=utf-8",
                index.data.into_owned(),
                "no-store",
            );
        }
        return response(
            StatusCode::OK,
            "text/html; charset=utf-8",
            FALLBACK_INDEX.as_bytes().to_vec(),
            "no-store",
        );
    }

    response(
        StatusCode::NOT_FOUND,
        "text/plain; charset=utf-8",
        b"not found".to_vec(),
        "no-store",
    )
}

fn response(status: StatusCode, content_type: &str, body: Vec<u8>, cache: &str) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, cache)
        .body(Body::from(body))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}
