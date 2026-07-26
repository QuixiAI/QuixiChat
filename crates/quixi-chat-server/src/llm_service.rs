//! A bounded, lazy worker owning the Gemma model.
//!
//! Ported in shape from MoleculAI's `llm_service`. Per spec §12.1 the model
//! lives on one dedicated OS thread — Burn's GPU work blocks, and tokio is for
//! I/O, not for GEMMs — behind bounded job and token-stream channels.

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    thread,
};

use quixi_chat_engine::{ChatMessage, GenerationOptions};
use serde::Serialize;
use tokio::sync::mpsc;

const QUEUE_DEPTH: usize = 2;
const STREAM_DEPTH: usize = 64;
const CONTEXT_LIMIT: usize = 131_072;

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatStreamEvent {
    Compacting {
        original_tokens: usize,
    },
    Compacted {
        messages: Vec<ChatMessage>,
        original_tokens: usize,
        compacted_tokens: usize,
    },
    Thinking,
    ThinkingDelta {
        text: String,
    },
    Answering,
    Delta {
        text: String,
    },
    Done {
        reply: String,
        thinking: String,
        elapsed_ms: u128,
    },
    Error {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LlmState {
    /// The weights are not on disk. Unreachable from the desktop launch, which
    /// installs the set before the UI loads (§12.2); possible under `serve`.
    NotInstalled,
    /// Present on disk, not yet resident on the GPU.
    Idle,
    /// Reading ~4 GB of GGUF and packing it onto the device.
    Loading,
    Ready,
    Failed,
}

impl LlmState {
    const fn code(self) -> u8 {
        match self {
            Self::NotInstalled => 0,
            Self::Idle => 1,
            Self::Loading => 2,
            Self::Ready => 3,
            Self::Failed => 4,
        }
    }

    const fn from_code(code: u8) -> Self {
        match code {
            0 => Self::NotInstalled,
            1 => Self::Idle,
            2 => Self::Loading,
            3 => Self::Ready,
            _ => Self::Failed,
        }
    }
}

struct Job {
    history: Vec<ChatMessage>,
    options: GenerationOptions,
    events: mpsc::Sender<ChatStreamEvent>,
}

#[derive(Clone)]
pub struct LlmService {
    sender: mpsc::Sender<Job>,
    state: Arc<AtomicU8>,
    model: &'static str,
    path: PathBuf,
}

impl LlmService {
    /// Spawn the worker. The model is loaded on the first request, not here —
    /// four gigabytes should not be read to open a window.
    #[must_use]
    pub fn spawn(path: PathBuf) -> Self {
        let installed = path.is_file();
        let state = Arc::new(AtomicU8::new(
            if installed {
                LlmState::Idle
            } else {
                LlmState::NotInstalled
            }
            .code(),
        ));

        let (sender, receiver) = mpsc::channel::<Job>(QUEUE_DEPTH);
        let worker_state = Arc::clone(&state);
        let worker_path = path.clone();

        thread::Builder::new()
            .name("quixi-chat-engine".to_owned())
            .spawn(move || worker(receiver, &worker_state, &worker_path))
            .expect("failed to start the LLM worker thread");

        Self {
            sender,
            state,
            model: "gemma-4-E2B-it-q4_0",
            path,
        }
    }

    #[must_use]
    pub fn state(&self) -> LlmState {
        // Re-check the disk so a model copied into place mid-session is noticed.
        if LlmState::from_code(self.state.load(Ordering::Relaxed)) == LlmState::NotInstalled
            && self.path.is_file()
        {
            self.state.store(LlmState::Idle.code(), Ordering::Relaxed);
        }
        LlmState::from_code(self.state.load(Ordering::Relaxed))
    }

    #[must_use]
    pub const fn model(&self) -> &'static str {
        self.model
    }

    #[must_use]
    pub fn path(&self) -> &PathBuf {
        &self.path
    }

    /// Queue a turn and return its incremental event stream.
    pub async fn chat(
        &self,
        history: Vec<ChatMessage>,
        options: GenerationOptions,
    ) -> Result<mpsc::Receiver<ChatStreamEvent>, String> {
        if self.state() == LlmState::NotInstalled {
            return Err(format!(
                "the model set is not installed at {}",
                self.path.display()
            ));
        }
        let (events, receiver) = mpsc::channel(STREAM_DEPTH);
        self.sender
            .send(Job {
                history,
                options,
                events,
            })
            .await
            .map_err(|_| "the LLM worker is gone".to_owned())?;
        Ok(receiver)
    }
}

#[cfg(feature = "metal-kernels")]
fn worker(mut receiver: mpsc::Receiver<Job>, state: &Arc<AtomicU8>, path: &Path) {
    let mut engine: Option<quixi_chat_engine::ChatEngine> = None;

    while let Some(job) = receiver.blocking_recv() {
        let Job {
            history,
            options,
            events,
        } = job;
        if engine.is_none() {
            state.store(LlmState::Loading.code(), Ordering::Relaxed);
            tracing::info!(path = %path.display(), "loading Gemma");
            let started = std::time::Instant::now();
            match quixi_chat_engine::ChatEngine::load(path, CONTEXT_LIMIT) {
                Ok(loaded) => {
                    tracing::info!(elapsed = ?started.elapsed(), "Gemma resident");
                    engine = Some(loaded);
                    state.store(LlmState::Ready.code(), Ordering::Relaxed);
                }
                Err(error) => {
                    state.store(LlmState::Failed.code(), Ordering::Relaxed);
                    let _ = events.blocking_send(ChatStreamEvent::Error {
                        message: format!("failed to load the model: {error}"),
                    });
                    continue;
                }
            }
        }

        let engine = engine.as_mut().expect("the engine is loaded");
        let mut history = history;
        let history_tokens = match engine.history_tokens(&history) {
            Ok(tokens) => tokens,
            Err(error) => {
                let _ = events.blocking_send(ChatStreamEvent::Error {
                    message: error.to_string(),
                });
                continue;
            }
        };
        if history_tokens >= quixi_chat_engine::COMPACTION_TRIGGER_TOKENS {
            if events
                .blocking_send(ChatStreamEvent::Compacting {
                    original_tokens: history_tokens,
                })
                .is_err()
            {
                continue;
            }
            let compacted = match engine.compact_history(&history) {
                Ok(compacted) => compacted,
                Err(error) => {
                    let _ = events.blocking_send(ChatStreamEvent::Error {
                        message: error.to_string(),
                    });
                    continue;
                }
            };
            tracing::info!(
                original_tokens = compacted.original_tokens,
                compacted_tokens = compacted.compacted_tokens,
                "compacted conversation history"
            );
            history = compacted.messages;
            if events
                .blocking_send(ChatStreamEvent::Compacted {
                    messages: history.clone(),
                    original_tokens: compacted.original_tokens,
                    compacted_tokens: compacted.compacted_tokens,
                })
                .is_err()
            {
                continue;
            }
        }

        let started = std::time::Instant::now();
        let result = engine
            .reply_stream(&history, options, |event| match event {
                quixi_chat_engine::GenerationEvent::ThinkingStarted => {
                    events.blocking_send(ChatStreamEvent::Thinking).is_ok()
                }
                quixi_chat_engine::GenerationEvent::ThinkingFinished => {
                    events.blocking_send(ChatStreamEvent::Answering).is_ok()
                }
                quixi_chat_engine::GenerationEvent::ThinkingDelta(text) => events
                    .blocking_send(ChatStreamEvent::ThinkingDelta {
                        text: text.to_owned(),
                    })
                    .is_ok(),
                quixi_chat_engine::GenerationEvent::Delta(text) => events
                    .blocking_send(ChatStreamEvent::Delta {
                        text: text.to_owned(),
                    })
                    .is_ok(),
                quixi_chat_engine::GenerationEvent::ThinkingToken => !events.is_closed(),
            })
            .map_err(|error| error.to_string());
        if result.is_ok() {
            tracing::info!(
                elapsed = ?started.elapsed(),
                reused = engine.last_reuse(),
                "generated a reply"
            );
        }
        match result {
            Ok(generated) => {
                let _ = events.blocking_send(ChatStreamEvent::Done {
                    reply: generated.reply,
                    thinking: generated.thinking,
                    elapsed_ms: started.elapsed().as_millis(),
                });
            }
            Err(message) => {
                let _ = events.blocking_send(ChatStreamEvent::Error { message });
            }
        }
    }
}

#[cfg(not(feature = "metal-kernels"))]
fn worker(mut receiver: mpsc::Receiver<Job>, state: &Arc<AtomicU8>, _path: &Path) {
    state.store(LlmState::Failed.code(), Ordering::Relaxed);
    while let Some(job) = receiver.blocking_recv() {
        let _ = job.events.blocking_send(ChatStreamEvent::Error {
            message: "this build has no native Metal kernels compiled in".to_owned(),
        });
    }
}
