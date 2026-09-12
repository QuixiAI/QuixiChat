//! Native host. Canonical history belongs to the shared Storage Worker.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(not(feature = "storage-proof"))]
mod host;

#[cfg(not(feature = "storage-proof"))]
mod registered_destinations;

#[cfg(all(not(feature = "storage-proof"), not(feature = "host-proof")))]
fn main() {
    host::builder(
        host::NativeHost::new(registered_destinations::destinations(), "ai.quixi.chat.provider".into())
            .expect("invalid native host configuration"),
    )
    .run(tauri::generate_context!())
    .expect("failed to run Quixi desktop");
}

#[cfg(all(feature = "host-proof", not(feature = "storage-proof")))]
mod host_proof;

#[cfg(all(feature = "host-proof", not(feature = "storage-proof")))]
fn main() {
    host_proof::run();
}

#[cfg(feature = "storage-proof")]
mod storage_proof;

#[cfg(feature = "storage-proof")]
fn main() {
    storage_proof::run();
}
