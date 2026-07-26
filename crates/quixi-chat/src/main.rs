//! QuixiChat — one binary for native desktop chat and diagnostics.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

#[cfg(feature = "desktop")]
mod desktop;
mod models;

const APP_NAME: &str = "QuixiChat";
const VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Parser)]
#[command(
    name = "quixi-chat",
    version,
    about = "Fast, private Gemma 4 E2B chat on Apple silicon"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Open QuixiChat in its native window. The default with no arguments.
    #[cfg(feature = "desktop")]
    Desktop,
    /// Run the local service without opening a window.
    Serve,
    /// Report the compute backend and prove the GPU computes.
    Doctor,
    /// Install and verify the pinned Gemma model, then exit.
    DownloadModel,
    /// Measure prefill and decode throughput.
    Bench {
        #[arg(long, default_value_t = 256)]
        prompt_tokens: usize,
        #[arg(long, default_value_t = 64)]
        decode_tokens: usize,
        /// Report the best of N runs. This machine drifts several percent under
        /// sustained load, so a single run cannot resolve a small change.
        #[arg(long, default_value_t = 5)]
        repeat: usize,
    },
}

fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    match Cli::parse().command {
        #[cfg(feature = "desktop")]
        None | Some(Command::Desktop) => desktop::launch(),
        #[cfg(not(feature = "desktop"))]
        None => serve(),
        Some(Command::Serve) => serve(),
        Some(Command::Doctor) => doctor(),
        Some(Command::DownloadModel) => download_model(),
        Some(Command::Bench {
            prompt_tokens,
            decode_tokens,
            repeat,
        }) => bench(prompt_tokens, decode_tokens, repeat),
    }
}

/// Time the two halves of generation separately.
///
/// A slow reply is either slow to ingest the prompt or slow to emit tokens, and
/// the fixes are completely different. One number cannot tell you which.
#[cfg(feature = "metal-kernels")]
#[allow(clippy::cast_precision_loss)]
fn bench(prompt_tokens: usize, decode_tokens: usize, repeat: usize) -> Result<()> {
    let path = models::llm_path()?;

    let started = std::time::Instant::now();
    let engine = quixi_chat_engine::ChatEngine::load(&path, 8_192)
        .map_err(|error| anyhow::anyhow!("{error}"))?;
    let load = started.elapsed();

    println!("load           {:.2}s", load.as_secs_f64());
    // Prove the checkpoint's own template renders, and show what the model
    // actually receives — the prompt is the easiest thing to get silently wrong.
    match engine.render(&[
        quixi_chat_engine::ChatMessage {
            role: quixi_chat_engine::ChatRole::User,
            content: "hello".into(),
        },
        quixi_chat_engine::ChatMessage {
            role: quixi_chat_engine::ChatRole::Assistant,
            content: "hi".into(),
        },
        quixi_chat_engine::ChatMessage {
            role: quixi_chat_engine::ChatRole::User,
            content: "again".into(),
        },
    ]) {
        Ok(prompt) => println!("prompt         {prompt:?}"),
        Err(error) => println!("prompt         RENDER FAILED: {error}"),
    }
    println!(
        "eos            {}   end_of_turn {}",
        engine.eos(),
        engine
            .end_of_turn()
            .map_or_else(|| "UNRESOLVED".to_owned(), |id| id.to_string())
    );

    // Best-of-N: the fastest run is the one least perturbed by thermal state
    // and background work, which is what makes an A/B comparable across time.
    let mut best_prefill = f64::MIN;
    let mut best_decode = f64::MIN;
    let mut prompt_tokens_seen = 0;
    for _ in 0..repeat.max(1) {
        let report = engine
            .bench(prompt_tokens, decode_tokens)
            .map_err(|error| anyhow::anyhow!("{error}"))?;
        best_prefill = best_prefill.max(report.prefill_per_second());
        best_decode = best_decode.max(report.decode_per_second());
        prompt_tokens_seen = report.prompt_tokens;
    }

    println!(
        "prefill        {prompt_tokens_seen:>6} tok   {best_prefill:>8.1} tok/s   {:.2} ms/tok",
        1000.0 / best_prefill
    );
    println!(
        "decode         {decode_tokens:>6} tok   {best_decode:>8.1} tok/s   {:.2} ms/tok",
        1000.0 / best_decode
    );
    Ok(())
}

#[cfg(not(feature = "metal-kernels"))]
fn bench(_prompt_tokens: usize, _decode_tokens: usize, _repeat: usize) -> Result<()> {
    anyhow::bail!("this build has no native Metal kernels compiled in")
}

/// Fetch the pinned model from its publisher and verify it.
#[allow(clippy::cast_precision_loss)]
fn download_model() -> Result<()> {
    use std::io::Write as _;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to start the async runtime")?;

    let total: u64 = models::MODEL_SET.iter().map(|a| a.bytes).sum();
    println!(
        "Installing {} artifact(s), {:.2} GB, into {}",
        models::MODEL_SET.len(),
        total as f64 / 1e9,
        models::models_dir().display()
    );
    for artifact in models::MODEL_SET {
        println!(
            "  {} — {} ({}, revision {})",
            artifact.role, artifact.label, artifact.license, artifact.revision
        );
    }

    let observer: models::Observer = Box::new(|progress| match progress {
        models::Progress::Status { title, detail } => {
            println!("{title}: {detail}");
        }
        models::Progress::Bytes { label, done, total } => {
            let pct = if total == 0 {
                0.0
            } else {
                done as f64 / total as f64 * 100.0
            };
            print!(
                "\r  {label}: {pct:.1}% ({:.2}/{:.2} GB)   ",
                done as f64 / 1e9,
                total as f64 / 1e9
            );
            let _ = std::io::stdout().flush();
        }
    });

    runtime.block_on(models::install(Some(&observer)))?;
    println!("\nGemma installed and verified.");
    Ok(())
}

/// Headless: serve until interrupted.
fn serve() -> Result<()> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to start the async runtime")?;

    runtime.block_on(async {
        let server = quixi_chat_server::Server::bind(models::llm_path()?).await?;
        println!("{APP_NAME} {VERSION}");
        println!("{}", server.url());
        server
            .run(async {
                let _ = tokio::signal::ctrl_c().await;
            })
            .await
    })
}

/// The device policy from §18, made observable: this either prints a working
/// Metal device or fails loudly. There is no third outcome.
fn doctor() -> Result<()> {
    let (device, smoke) = quixi_chat_kernels::smoke_test().context("no usable compute device")?;

    println!("{APP_NAME} {VERSION}");
    println!("  backend        {}", device.backend);
    println!("  device         {}", device.device);
    println!(
        "  kernels        {}",
        if device.native_kernels {
            "native dispatch compiled"
        } else {
            "framework fallback"
        }
    );
    println!(
        "  smoke test     {} (got {}, expected {})",
        if smoke.ok { "pass" } else { "FAIL" },
        smoke.value,
        smoke.expected
    );

    anyhow::ensure!(smoke.ok, "the GPU smoke test did not produce 30.0");
    Ok(())
}
