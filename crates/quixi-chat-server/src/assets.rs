//! The complete dependency-free chat UI, embedded in the binary.

use axum::response::Html;

pub(crate) async fn serve() -> Html<&'static str> {
    Html(include_str!("index.html"))
}
