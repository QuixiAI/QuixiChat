//! QuixiChat — native desktop chat, plus one throughput benchmark.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use anyhow::Result;
use clap::{Parser, Subcommand};
use tracing_subscriber::EnvFilter;

mod desktop;
mod models;

#[derive(Debug, Parser)]
#[command(
    name = "quixi-chat",
    version,
    disable_help_subcommand = true,
    about = "Fast, private Gemma 4 E2B chat on Apple silicon"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Debug, Subcommand)]
enum Command {
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
        None => desktop::launch(),
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
#[allow(clippy::cast_precision_loss)]
fn bench(prompt_tokens: usize, decode_tokens: usize, repeat: usize) -> Result<()> {
    let path = models::installed_model_path()?;

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
