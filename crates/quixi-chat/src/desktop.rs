//! The native desktop shell.
//!
//! The window opens on a boot splash served over Tauri's asset protocol. A
//! background thread installs the model if it is not already present,
//! brings up the local axum service, and navigates the window to it. That is
//! one loopback port serving both the UI and API. Installation is automatic; a
//! failure ends the launch rather than opening a half-working app.

use std::{
    sync::{Arc, Mutex},
    thread,
};

use crate::models::{self, Progress};
use anyhow::{Context, Result};
use tauri::{Manager, RunEvent, WebviewWindow, WindowEvent};
use tokio::sync::oneshot;

const MAIN_WINDOW: &str = "main";

pub fn launch() -> Result<()> {
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let shutdown_tx = Arc::new(Mutex::new(Some(shutdown_tx)));
    let event_shutdown = Arc::clone(&shutdown_tx);

    let app = tauri::Builder::default()
        .setup(move |app| {
            let window = app
                .get_webview_window(MAIN_WINDOW)
                .context("the QuixiChat window was not created")?;
            let handle = app.handle().clone();
            thread::Builder::new()
                .name("quixi-chat-service".to_owned())
                .spawn(move || {
                    if let Err(error) = run_service(shutdown_rx, &window) {
                        tracing::error!(error = %format!("{error:#}"), "QuixiChat could not start");
                        show_error(&window, &error);
                        // Give the message a moment to render, then stop. A
                        // half-installed app is the worse outcome.
                        thread::sleep(std::time::Duration::from_secs(8));
                        handle.exit(1);
                    }
                })
                .context("failed to start the local service thread")?;
            Ok(())
        })
        .build(tauri::generate_context!("tauri.conf.json"))
        .context("failed to initialize the QuixiChat window")?;

    let exit_code = app.run_return(move |handle, event| match event {
        RunEvent::WindowEvent {
            label,
            event: WindowEvent::CloseRequested { .. },
            ..
        } if label == MAIN_WINDOW => {
            signal_shutdown(&event_shutdown);
            handle.exit(0);
        }
        RunEvent::ExitRequested { .. } | RunEvent::Exit => signal_shutdown(&event_shutdown),
        _ => {}
    });

    if exit_code == 0 {
        Ok(())
    } else {
        anyhow::bail!("QuixiChat exited with status {exit_code}")
    }
}

/// Owns the tokio runtime for the local service, on its own thread so Burn's
/// blocking GPU work never sits on the UI thread.
fn run_service(shutdown: oneshot::Receiver<()>, window: &WebviewWindow) -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to start the async runtime")?;

    runtime.block_on(async move {
        install_model(window).await?;

        set_status(
            window,
            "Starting local inference",
            "Bringing up the on-device service…",
        );

        let server = quixi_chat_server::Server::bind(models::installed_model_path()?).await?;
        let url = server.url();
        tracing::info!(%url, "navigating the window to the local service");

        let target = url
            .parse()
            .context("the local service URL was not a valid URL")?;
        window
            .navigate(target)
            .context("failed to navigate the QuixiChat window")?;

        server
            .run(async move {
                let _ = shutdown.await;
            })
            .await
    })
}

/// First run installs the whole set, with progress on the splash. Later runs
/// verify sizes and continue immediately.
async fn install_model(window: &WebviewWindow) -> Result<()> {
    if models::installed() {
        return Ok(());
    }

    #[allow(clippy::cast_precision_loss)]
    let gigabytes = models::MODEL_BYTES as f64 / 1e9;
    set_status(
        window,
        "Installing Gemma",
        &format!(
            "QuixiChat runs entirely on this machine. Fetching {gigabytes:.1} GB of model weights, once."
        ),
    );

    let progress_window = window.clone();
    let observer: models::Observer = Box::new(move |progress| {
        show_install_progress(&progress_window, &progress);
    });

    models::install(Some(&observer))
        .await
        .context("the model install did not complete")?;

    Ok(())
}

fn show_install_progress(window: &WebviewWindow, progress: &Progress) {
    match progress {
        Progress::Status { title, detail } => set_status(window, title, detail),
        Progress::Bytes { label, done, total } => {
            let label = serde_json::to_string(label).expect("label is serializable");
            let _ = window.eval(format!(
                "window.quixiChatProgress?.({label}, {done}, {total});"
            ));
        }
    }
}

fn set_status(window: &WebviewWindow, title: &str, detail: &str) {
    let title = serde_json::to_string(title).expect("title is serializable");
    let detail = serde_json::to_string(detail).expect("detail is serializable");
    let _ = window.eval(format!(
        "window.quixiChatStatus?.({title}, {detail}, false);"
    ));
}

fn show_error(window: &WebviewWindow, error: &anyhow::Error) {
    let title = serde_json::to_string("QuixiChat could not start").expect("title is serializable");
    let detail = serde_json::to_string(&format!("{error:#}")).expect("detail is serializable");
    let _ = window.eval(format!(
        "window.quixiChatStatus?.({title}, {detail}, true);"
    ));
}

fn signal_shutdown(slot: &Arc<Mutex<Option<oneshot::Sender<()>>>>) {
    if let Ok(mut guard) = slot.lock()
        && let Some(sender) = guard.take()
    {
        let _ = sender.send(());
    }
}
