//! A bounded, lazy worker owning the Gemma model.
//!
//! The model lives on one dedicated OS thread because Burn's GPU work blocks;
//! bounded channels connect it to asynchronous HTTP I/O.

use std::{
    path::{Path, PathBuf},
    thread,
};

use quixi_chat_engine::ChatMessage;
use serde::Serialize;
use tokio::sync::mpsc;

const QUEUE_DEPTH: usize = 2;
const STREAM_DEPTH: usize = 64;
const CONTEXT_LIMIT: usize = 131_072;

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ChatStreamEvent {
    Loading,
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

struct Job {
    history: Vec<ChatMessage>,
    events: mpsc::Sender<ChatStreamEvent>,
}

#[derive(Clone)]
pub struct LlmService {
    sender: mpsc::Sender<Job>,
}

impl LlmService {
    /// Spawn the worker. The model is loaded on the first request, not here —
    /// four gigabytes should not be read to open a window.
    #[must_use]
    pub fn spawn(path: PathBuf) -> Self {
        let (sender, receiver) = mpsc::channel::<Job>(QUEUE_DEPTH);

        thread::Builder::new()
            .name("quixi-chat-engine".to_owned())
            .spawn(move || worker(receiver, &path))
            .expect("failed to start the LLM worker thread");

        Self { sender }
    }

    /// Queue a turn and return its incremental event stream.
    pub async fn chat(
        &self,
        history: Vec<ChatMessage>,
    ) -> Result<mpsc::Receiver<ChatStreamEvent>, String> {
        let (events, receiver) = mpsc::channel(STREAM_DEPTH);
        self.sender
            .send(Job { history, events })
            .await
            .map_err(|_| "the LLM worker is gone".to_owned())?;
        Ok(receiver)
    }
}

fn worker(mut receiver: mpsc::Receiver<Job>, path: &Path) {
    let mut engine: Option<quixi_chat_engine::ChatEngine> = None;

    while let Some(job) = receiver.blocking_recv() {
        let Job { history, events } = job;
        if engine.is_none() {
            if events.blocking_send(ChatStreamEvent::Loading).is_err() {
                continue;
            }
            tracing::info!(path = %path.display(), "loading Gemma");
            let started = std::time::Instant::now();
            match quixi_chat_engine::ChatEngine::load(path, CONTEXT_LIMIT) {
                Ok(loaded) => {
                    tracing::info!(elapsed = ?started.elapsed(), "Gemma resident");
                    engine = Some(loaded);
                }
                Err(error) => {
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
            .reply_stream(&history, |event| forward_event(&events, event))
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

fn forward_event(
    events: &mpsc::Sender<ChatStreamEvent>,
    event: quixi_chat_engine::GenerationEvent<'_>,
) -> bool {
    let event = match event {
        quixi_chat_engine::GenerationEvent::ThinkingStarted => ChatStreamEvent::Thinking,
        quixi_chat_engine::GenerationEvent::ThinkingFinished => ChatStreamEvent::Answering,
        quixi_chat_engine::GenerationEvent::ThinkingDelta(text) => ChatStreamEvent::ThinkingDelta {
            text: text.to_owned(),
        },
        quixi_chat_engine::GenerationEvent::Delta(text) => ChatStreamEvent::Delta {
            text: text.to_owned(),
        },
        quixi_chat_engine::GenerationEvent::ThinkingToken => return !events.is_closed(),
    };
    events.blocking_send(event).is_ok()
}
