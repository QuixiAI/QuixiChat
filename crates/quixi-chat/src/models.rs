//! The one pinned, digest-verified model QuixiChat installs on first launch.
//!
//! Ported from MoleculAI's installer. The set is a compile-time constant, the
//! cache path is fixed, and there is nothing for a user to choose. QuixiChat
//! redistributes no weights: each artifact is fetched from its publisher on the
//! user's behalf and verified against a digest compiled into this binary.

use std::{
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail, ensure};
use futures_util::StreamExt;
use reqwest::{Client, header};
use sha2::{Digest, Sha256};
use tokio::io::AsyncWriteExt;

const DOWNLOAD_RETRIES: u32 = 3;

/// One artifact in the set: where it comes from, and exactly what it must be.
#[derive(Debug, Clone, Copy)]
pub struct Artifact {
    pub role: &'static str,
    pub label: &'static str,
    pub filename: &'static str,
    pub url: &'static str,
    pub revision: &'static str,
    pub bytes: u64,
    pub sha256: &'static str,
    pub license: &'static str,
}

/// The complete model inventory. QuixiChat intentionally has no model picker.
pub static MODEL_SET: &[Artifact] = &[Artifact {
    role: "llm",
    label: "Gemma 4 E2B (q4_0)",
    filename: "gemma-4-E2B_q4_0-it.gguf",
    url: "https://huggingface.co/google/gemma-4-E2B-it-qat-q4_0-gguf/resolve/69536a21d70340464240401ba38223d805f6a709/gemma-4-E2B_q4_0-it.gguf",
    revision: "69536a21d70340464240401ba38223d805f6a709",
    bytes: 3_349_514_112,
    sha256: "3646b4c147cd235a44d91df1546d3b7d8e29b547dbe4e1f80856419aa455e6fd",
    license: "Gemma Terms of Use",
}];

/// The one cache location, on every launch type. Not overridable — there is no
/// variable to override it with (spec §12.2).
#[must_use]
pub fn models_dir() -> PathBuf {
    home().join(".cache/quixi-chat/models")
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map_or_else(|| PathBuf::from("/"), PathBuf::from)
}

#[must_use]
pub fn path_for(role: &str) -> Option<PathBuf> {
    MODEL_SET
        .iter()
        .find(|artifact| artifact.role == role)
        .map(|artifact| models_dir().join(artifact.filename))
}

/// Cheap startup check: every artifact present at its pinned size.
///
/// Full SHA-256 verification happens during install; re-hashing four gigabytes
/// on every launch would be a poor trade.
#[must_use]
pub fn installed() -> bool {
    MODEL_SET.iter().all(|artifact| {
        std::fs::metadata(models_dir().join(artifact.filename))
            .is_ok_and(|meta| meta.len() == artifact.bytes)
    })
}

/// Progress for the first-run install screen.
#[derive(Debug, Clone)]
pub enum Progress {
    Status {
        title: String,
        detail: String,
    },
    Bytes {
        label: String,
        done: u64,
        total: u64,
    },
}

pub type Observer = Box<dyn Fn(Progress) + Send + Sync>;

/// Install every artifact, or fail. There is no partial-feature mode: the caller
/// exits if this returns an error (spec §12.2).
pub async fn install(observer: Option<&Observer>) -> Result<()> {
    let dir = models_dir();
    std::fs::create_dir_all(&dir).with_context(|| format!("failed to create {}", dir.display()))?;

    let client = Client::builder()
        .user_agent(concat!("QuixiChat/", env!("CARGO_PKG_VERSION")))
        .build()
        .context("failed to build the HTTP client")?;

    for artifact in MODEL_SET {
        download_verified(&client, artifact, &dir.join(artifact.filename), observer).await?;
    }
    Ok(())
}

async fn download_verified(
    client: &Client,
    spec: &Artifact,
    target: &Path,
    observer: Option<&Observer>,
) -> Result<()> {
    notify(
        observer,
        "Checking required models",
        format!("Verifying {}…", spec.label),
    );
    if file_matches(target, spec.bytes, spec.sha256)? {
        tracing::info!(path = %target.display(), "using verified model");
        return Ok(());
    }
    if target.exists() {
        std::fs::remove_file(target)
            .with_context(|| format!("failed to remove invalid {}", target.display()))?;
    }

    let partial = target.with_extension("part");
    if partial.exists() {
        let partial_bytes = std::fs::metadata(&partial)?.len();
        if partial_bytes > spec.bytes
            || (partial_bytes == spec.bytes && !file_matches(&partial, spec.bytes, spec.sha256)?)
        {
            std::fs::remove_file(&partial)
                .with_context(|| format!("failed to remove invalid {}", partial.display()))?;
        }
    }
    if file_matches(&partial, spec.bytes, spec.sha256)? {
        std::fs::rename(&partial, target)?;
        return Ok(());
    }

    let mut last_error = None;
    for attempt in 1..=DOWNLOAD_RETRIES {
        match attempt_download(client, spec, &partial, observer).await {
            Ok(()) => {
                last_error = None;
                break;
            }
            Err(error) => {
                last_error = Some(error);
                if attempt < DOWNLOAD_RETRIES {
                    tracing::warn!(
                        attempt,
                        "download interrupted; retrying from the partial file"
                    );
                    tokio::time::sleep(Duration::from_secs(u64::from(attempt))).await;
                }
            }
        }
    }
    if let Some(error) = last_error {
        return Err(error).with_context(|| format!("failed to download {}", spec.filename));
    }

    notify(
        observer,
        "Verifying downloaded model",
        format!("Checking the SHA-256 digest for {}…", spec.label),
    );
    verify(&partial, spec.bytes, spec.sha256)
        .with_context(|| format!("download verification failed for {}", spec.filename))?;
    std::fs::rename(&partial, target)?;
    tracing::info!(path = %target.display(), "downloaded and verified");
    Ok(())
}

/// Resume from `.part` with a Range request, so a retry costs the remainder.
async fn attempt_download(
    client: &Client,
    spec: &Artifact,
    partial: &Path,
    observer: Option<&Observer>,
) -> Result<()> {
    let mut offset = std::fs::metadata(partial).map_or(0, |meta| meta.len());
    if offset == spec.bytes {
        return Ok(());
    }

    let mut request = client.get(spec.url);
    if offset > 0 {
        request = request.header(header::RANGE, format!("bytes={offset}-"));
    }
    let response = request
        .send()
        .await
        .with_context(|| format!("request failed for {}", spec.url))?;

    if offset > 0 && response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        // The server ignored the range; start over rather than corrupt the file.
        offset = 0;
        let _ = std::fs::remove_file(partial);
    }
    let response = response
        .error_for_status()
        .with_context(|| format!("unexpected status for {}", spec.url))?;

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(offset > 0)
        .write(true)
        .truncate(offset == 0)
        .open(partial)
        .await
        .with_context(|| format!("failed to open {}", partial.display()))?;

    let mut written = offset;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.context("the download stream failed")?;
        file.write_all(&chunk).await?;
        written += chunk.len() as u64;
        if let Some(observe) = observer {
            observe(Progress::Bytes {
                label: spec.label.to_owned(),
                done: written,
                total: spec.bytes,
            });
        }
    }
    file.flush().await?;
    Ok(())
}

fn file_matches(path: &Path, expected_bytes: u64, expected_sha256: &str) -> Result<bool> {
    if !std::fs::metadata(path).is_ok_and(|meta| meta.len() == expected_bytes) {
        return Ok(false);
    }
    Ok(sha256_file(path)? == expected_sha256)
}

fn verify(path: &Path, expected_bytes: u64, expected_sha256: &str) -> Result<()> {
    let actual_bytes = std::fs::metadata(path)?.len();
    ensure!(
        actual_bytes == expected_bytes,
        "{} is {actual_bytes} bytes; expected {expected_bytes}",
        path.display()
    );
    let actual = sha256_file(path)?;
    ensure!(
        actual == expected_sha256,
        "{} has SHA-256 {actual}; expected {expected_sha256}",
        path.display()
    );
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String> {
    use std::io::Read as _;
    let mut file =
        std::fs::File::open(path).with_context(|| format!("failed to open {}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; 1 << 20];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn notify(observer: Option<&Observer>, title: &str, detail: String) {
    if let Some(observe) = observer {
        observe(Progress::Status {
            title: title.to_owned(),
            detail,
        });
    }
}

/// Resolve the LLM weights, or explain precisely what is missing.
pub fn llm_path() -> Result<PathBuf> {
    let path = path_for("llm").context("no llm artifact is bound in MODEL_SET")?;
    if !path.exists() {
        bail!(
            "Gemma is not installed; run `quixi-chat download-model` (expected {})",
            path.display()
        );
    }
    Ok(path)
}
