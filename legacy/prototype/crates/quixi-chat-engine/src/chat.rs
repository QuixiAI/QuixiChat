//! Conversation on top of the quantized Gemma engine.
//!
//! It preserves the model's separate thinking and answer channels and compacts
//! long histories before they reach the context limit.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::quant_model::{Gemma4QuantizedMetal, QuantGenerationState, QuantModelError};

/// Maximum number of tokens one chat turn may generate.
const MAX_NEW_TOKENS: usize = 32_768;
/// Compact before a new answer would have to carry a very long conversation.
pub const COMPACTION_TRIGGER_TOKENS: usize = 90_000;
const COMPACTION_TARGET_TOKENS: usize = 24_000;

const COMPACTION_INSTRUCTIONS: &str = r#"You are compacting a long conversation so it can continue within a smaller context window.

Rewrite the conversation as a shorter conversation using the same message format and roles:

* system
* developer
* user
* assistant
* tool, where applicable

The output must remain a valid ordered message sequence. Do not produce a summary, commentary, YAML state, or explanation outside the messages.

Preserve all information needed to continue the conversation correctly, including:

* system and developer instructions
* the user’s active request and underlying goal
* important constraints, preferences, definitions, and corrections
* decisions that are still in effect
* unresolved questions and unfinished tasks
* relevant tool results, file references, identifiers, URLs, dates, numbers, and exact wording
* the latest authoritative version of code, drafts, plans, or artifacts
* assistant commitments that still need to be fulfilled

Compact or remove:

* greetings and filler
* repeated statements
* verbose explanations whose conclusions can be stated briefly
* failed approaches that no longer matter
* superseded drafts and decisions, unless the correction itself is important
* intermediate reasoning not needed for continuation

When several messages can be safely merged, combine them into one message with the same role.

Do not merge messages across roles when doing so would change who said or instructed something.

Preserve instruction priority. Never rewrite a user instruction as a system or developer instruction. Never rewrite an assistant claim as a user-provided fact.

When a later message corrects an earlier one, preserve the corrected version and briefly retain the fact that the earlier version was superseded only when that history may matter.

Do not answer the latest user request. The final message in the compacted transcript should leave the conversation ready for the assistant to continue.

Return only the compacted messages in this format:

<message role="system">
...
</message>

<message role="developer">
...
</message>

<message role="user">
...
</message>

<message role="assistant">
...
</message>

Use additional messages as necessary. Maintain chronological order.

Additional requirements for this compaction:

* Aim for no more than 24,000 tokens.
* Do not invent roles that are absent from the source conversation.
* Put every opening and closing message tag on its own line.
* If message content contains a line exactly equal to </message>, write that content line as &lt;/message>.

Conversation to compact:
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    System,
    Developer,
    User,
    Assistant,
    Tool,
}

impl ChatRole {
    const fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Developer => "developer",
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::Tool => "tool",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "system" => Some(Self::System),
            "developer" => Some(Self::Developer),
            "user" => Some(Self::User),
            "assistant" => Some(Self::Assistant),
            "tool" => Some(Self::Tool),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
}

#[derive(Debug, Error)]
pub enum ChatError {
    #[error("generation failed: {0}")]
    Backend(String),
    #[error("the conversation was empty")]
    EmptyPrompt,
    #[error("the prompt uses {prompt_tokens} tokens, exceeding the {context_limit}-token context")]
    ContextOverflow {
        prompt_tokens: usize,
        context_limit: usize,
    },
    #[error("conversation compaction failed: {0}")]
    Compaction(String),
}

impl From<QuantModelError> for ChatError {
    fn from(error: QuantModelError) -> Self {
        Self::Backend(error.to_string())
    }
}

use crate::template::{self, TURN_CLOSE, TemplateMessage};

const CHANNEL_OPEN: &str = "<|channel>";
const CHANNEL_CLOSE: &str = "<channel|>";

/// A generation update before the HTTP layer turns it into a wire event.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GenerationEvent<'a> {
    ThinkingStarted,
    ThinkingToken,
    ThinkingDelta(&'a str),
    ThinkingFinished,
    Delta(&'a str),
}

/// Canonical visible reply plus its separately retained, non-history trace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GeneratedReply {
    pub reply: String,
    pub thinking: String,
}

#[derive(Default)]
struct ThoughtStreamFilter {
    header: String,
    past_header: bool,
}

impl ThoughtStreamFilter {
    fn push(&mut self, delta: &str) -> Option<String> {
        if self.past_header {
            return Some(delta.to_owned());
        }
        self.header.push_str(delta);
        let newline = self.header.find('\n')?;
        self.past_header = true;
        let first = self.header[..newline].trim_end_matches('\r');
        let visible = if matches!(first, "thought" | "analysis") {
            self.header[newline + 1..].to_owned()
        } else {
            std::mem::take(&mut self.header)
        };
        self.header.clear();
        (!visible.is_empty()).then_some(visible)
    }
}

fn clean_thought(text: &str) -> String {
    let text = text.trim();
    let visible = text.split_once('\n').map_or(text, |(first, rest)| {
        if matches!(first.trim_end_matches('\r'), "thought" | "analysis") {
            rest
        } else {
            text
        }
    });
    visible.trim().to_owned()
}

/// The KV state of a conversation, and exactly which tokens produced it.
///
/// Keeping this between turns is what stops turn N from re-ingesting turns
/// 1..N-1. At ~50 tok/s of prefill, a 500-token history costs ten seconds
/// before the model emits anything; reused, it costs nothing.
struct Session {
    state: QuantGenerationState,
    /// The token sequence already fed through the model, in order.
    consumed: Vec<u32>,
}

#[derive(Debug, Clone)]
pub struct Compaction {
    pub messages: Vec<ChatMessage>,
    pub original_tokens: usize,
    pub compacted_tokens: usize,
}

/// A loaded model plus the prompt formatting around it.
pub struct ChatEngine {
    model: Gemma4QuantizedMetal,
    end_of_turn: Option<u32>,
    channel_open: u32,
    channel_close: u32,
    session: Option<Session>,
    last_reuse: usize,
}

impl ChatEngine {
    pub fn load(
        path: impl AsRef<std::path::Path>,
        context_limit: usize,
    ) -> Result<Self, ChatError> {
        let model = Gemma4QuantizedMetal::load(path, context_limit)?;
        let end_of_turn = resolve_special_token(&model, TURN_CLOSE);
        if end_of_turn.is_none() {
            // Not fatal: the decoded text is still trimmed. Worth shouting about,
            // because without it every reply runs to the token limit — which is
            // an order of magnitude of wasted latency, not a cosmetic issue.
            tracing::warn!("no {TURN_CLOSE} id resolved; replies will not stop early");
        }
        let channel_open = resolve_special_token(&model, CHANNEL_OPEN).ok_or_else(|| {
            ChatError::Backend(format!("the tokenizer has no {CHANNEL_OPEN} token"))
        })?;
        let channel_close = resolve_special_token(&model, CHANNEL_CLOSE).ok_or_else(|| {
            ChatError::Backend(format!("the tokenizer has no {CHANNEL_CLOSE} token"))
        })?;
        Ok(Self {
            model,
            end_of_turn,
            channel_open,
            channel_close,
            session: None,
            last_reuse: 0,
        })
    }

    /// How many prompt tokens the previous `reply` reused from cache.
    #[must_use]
    pub const fn last_reuse(&self) -> usize {
        self.last_reuse
    }

    #[must_use]
    pub const fn end_of_turn(&self) -> Option<u32> {
        self.end_of_turn
    }

    /// Render a conversation with the checkpoint's own chat template.
    pub fn render(&self, history: &[ChatMessage]) -> Result<String, ChatError> {
        let messages: Vec<TemplateMessage> = history
            .iter()
            .map(|message| TemplateMessage {
                role: message.role.as_str(),
                content: message.content.clone(),
            })
            .collect();

        template::render(self.chat_template(), "<bos>", &messages, true)
            .map_err(|error| ChatError::Backend(error.to_string()))
    }

    /// The chat template Google shipped inside the GGUF.
    #[must_use]
    pub fn chat_template(&self) -> &str {
        &self.model.tokenizer().chat_template
    }

    #[must_use]
    pub fn eos(&self) -> u32 {
        self.model.tokenizer().eos_token_id
    }

    /// Measure prefill and decode separately, which is the only way to tell
    /// which half of a slow reply is actually slow.
    pub fn bench(&self, prompt_tokens: usize, decode_tokens: usize) -> Result<Bench, ChatError> {
        let ids = self
            .model
            .tokenizer()
            .encode(&"word ".repeat(prompt_tokens.max(1)), true)
            .map_err(|error| ChatError::Backend(error.to_string()))?;

        let mut state = self.model.new_state()?;
        let started = std::time::Instant::now();
        for &token in &ids[..ids.len() - 1] {
            self.model.consume_token(token, &mut state)?;
        }
        let prefill = started.elapsed();

        let started = std::time::Instant::now();
        let mut next = self
            .model
            .forward_token_greedy(ids[ids.len() - 1], &mut state)?;
        for _ in 1..decode_tokens {
            next = self.model.forward_token_greedy(next, &mut state)?;
        }
        let decode = started.elapsed();

        Ok(Bench {
            prompt_tokens: ids.len(),
            prefill,
            decode_tokens,
            decode,
        })
    }

    /// Generate one reply for the conversation so far.
    ///
    /// The history is rendered and tokenized each turn; unchanged prefixes reuse
    /// their existing KV state, while edited or replaced histories start clean.
    pub fn reply(&mut self, history: &[ChatMessage]) -> Result<String, ChatError> {
        self.reply_stream(history, |_| true)
            .map(|generated| generated.reply)
    }

    /// Generate one reply, yielding private-thinking phase changes and
    /// UTF-8-safe visible text as soon as answer tokens decode.
    ///
    /// Returning `false` from `on_event` stops generation early. The HTTP layer
    /// uses that signal when the browser disconnects, so an abandoned request
    /// does not keep the GPU busy for the rest of a 32K-token turn.
    #[allow(clippy::too_many_lines)]
    pub fn reply_stream(
        &mut self,
        history: &[ChatMessage],
        mut on_event: impl FnMut(GenerationEvent<'_>) -> bool,
    ) -> Result<GeneratedReply, ChatError> {
        if history.is_empty() {
            return Err(ChatError::EmptyPrompt);
        }

        let prompt = self.render(history)?;
        // The template emits `bos_token` itself.
        let ids = self
            .model
            .tokenizer()
            .encode(&prompt, false)
            .map_err(|error| ChatError::Backend(error.to_string()))?;
        if ids.is_empty() {
            return Err(ChatError::EmptyPrompt);
        }
        let context_limit = self.model.context_limit();
        if ids.len() > context_limit {
            return Err(ChatError::ContextOverflow {
                prompt_tokens: ids.len(),
                context_limit,
            });
        }

        // Reuse the cached KV when the previous turn's token stream is a prefix
        // of this one, which is the ordinary case in a conversation that only
        // ever grows. Anything else — an edited history, a new chat — starts
        // clean, because this cache cannot rewind.
        let reusable = self
            .session
            .as_ref()
            .filter(|session| session.consumed.len() < ids.len())
            .filter(|session| ids.starts_with(&session.consumed))
            .map_or(0, |session| session.consumed.len());

        if reusable == 0 {
            self.session = Some(Session {
                state: self.model.new_state()?,
                consumed: Vec::with_capacity(ids.len() + MAX_NEW_TOKENS),
            });
        }
        self.last_reuse = reusable;
        let session = self.session.as_mut().expect("session was just ensured");

        // Feed everything new except the final token, which the first decode
        // step consumes in order to produce the first output token.
        for &token in &ids[reusable..ids.len() - 1] {
            self.model.consume_token(token, &mut session.state)?;
            session.consumed.push(token);
        }

        let last = ids[ids.len() - 1];
        let mut next = self.model.forward_token_greedy(last, &mut session.state)?;
        session.consumed.push(last);

        let eos = self.model.tokenizer().eos_token_id;
        let available = context_limit.saturating_sub(session.state.position());
        let token_limit = MAX_NEW_TOKENS.min(available);
        let mut visible = Vec::with_capacity(token_limit);
        let mut thought = Vec::new();
        let mut visible_decoder = self.model.tokenizer().inner().decode_stream(true);
        let mut thought_decoder = self.model.tokenizer().inner().decode_stream(true);
        let mut thought_stream = ThoughtStreamFilter::default();
        let mut thinking = true;
        let mut cancelled = !on_event(GenerationEvent::ThinkingStarted);
        for _ in 0..token_limit {
            if cancelled {
                break;
            }
            if next == eos || Some(next) == self.end_of_turn {
                break;
            }

            if next == self.channel_open {
                if thinking {
                    cancelled = !on_event(GenerationEvent::ThinkingToken);
                } else {
                    thinking = true;
                    cancelled = !on_event(GenerationEvent::ThinkingStarted);
                }
            } else if next == self.channel_close {
                if thinking {
                    thinking = false;
                    cancelled = !on_event(GenerationEvent::ThinkingFinished);
                }
            } else if thinking {
                thought.push(next);
                cancelled = if let Some(delta) = thought_decoder
                    .step(next)
                    .map_err(|error| ChatError::Backend(error.to_string()))?
                    && !delta.is_empty()
                {
                    if let Some(visible) = thought_stream.push(&delta) {
                        !on_event(GenerationEvent::ThinkingDelta(&visible))
                    } else {
                        !on_event(GenerationEvent::ThinkingToken)
                    }
                } else {
                    // Keep checking for a disconnected browser when a partial
                    // UTF-8 sequence has not decoded into visible text yet.
                    !on_event(GenerationEvent::ThinkingToken)
                };
            } else {
                visible.push(next);
                if let Some(delta) = visible_decoder
                    .step(next)
                    .map_err(|error| ChatError::Backend(error.to_string()))?
                    && !delta.is_empty()
                {
                    cancelled = !on_event(GenerationEvent::Delta(&delta));
                }
            }
            if cancelled {
                break;
            }
            let following = self.model.forward_token_greedy(next, &mut session.state)?;
            session.consumed.push(next);
            next = following;
        }

        if thinking && !cancelled {
            return Err(ChatError::Backend(
                "the model ended before closing its private thinking channel".to_owned(),
            ));
        }

        let text = self
            .model
            .tokenizer()
            .decode(&visible, true)
            .map_err(|error| ChatError::Backend(error.to_string()))?;
        let thought = self
            .model
            .tokenizer()
            .decode(&thought, true)
            .map_err(|error| ChatError::Backend(error.to_string()))?;

        // Belt and braces: if the marker was not a single token, drop the tail.
        let text = text.split(TURN_CLOSE).next().unwrap_or(&text);
        Ok(GeneratedReply {
            reply: text.trim().to_owned(),
            thinking: clean_thought(&thought),
        })
    }

    /// Count the exact rendered prompt tokens the next model turn would see.
    pub fn history_tokens(&self, history: &[ChatMessage]) -> Result<usize, ChatError> {
        let prompt = self.render(history)?;
        self.model
            .tokenizer()
            .encode(&prompt, false)
            .map(|tokens| tokens.len())
            .map_err(|error| ChatError::Backend(error.to_string()))
    }

    /// Ask the model to rewrite a long conversation, then strictly parse and
    /// validate the ordered message sequence before it replaces live history.
    pub fn compact_history(&mut self, history: &[ChatMessage]) -> Result<Compaction, ChatError> {
        if history.is_empty() {
            return Err(ChatError::EmptyPrompt);
        }
        let original_tokens = self.history_tokens(history)?;
        let request = compaction_request(history);
        let output = self.reply(&[ChatMessage {
            role: ChatRole::User,
            content: request,
        }])?;
        let messages = parse_compacted_history(&output)?;
        let source_roles = history
            .iter()
            .map(|message| message.role)
            .collect::<Vec<_>>();
        if let Some(invented) = messages
            .iter()
            .map(|message| message.role)
            .find(|role| !source_roles.contains(role))
        {
            return Err(ChatError::Compaction(format!(
                "the model invented the {} role",
                invented.as_str()
            )));
        }
        if messages.last().map(|message| message.role) != history.last().map(|message| message.role)
        {
            return Err(ChatError::Compaction(
                "the final message role no longer matches the active conversation".to_owned(),
            ));
        }

        let compacted_tokens = self.history_tokens(&messages)?;
        if compacted_tokens >= original_tokens || compacted_tokens >= COMPACTION_TRIGGER_TOKENS {
            return Err(ChatError::Compaction(format!(
                "the result still uses {compacted_tokens} tokens (source: {original_tokens}, target: {COMPACTION_TARGET_TOKENS})"
            )));
        }
        Ok(Compaction {
            messages,
            original_tokens,
            compacted_tokens,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_generation_budget_is_32k() {
        assert_eq!(MAX_NEW_TOKENS, 32_768);
        assert_eq!(COMPACTION_TRIGGER_TOKENS, 90_000);
    }

    #[test]
    fn compacted_messages_parse_roles_and_escaped_closing_tag_lines() {
        let messages = parse_compacted_history(
            r#"<message role="system">
Keep exact constraints.
</message>
<message role="user">
Preserve this literal line:
&lt;/message>
</message>"#,
        )
        .unwrap();
        assert_eq!(messages.len(), 2);
        assert_eq!(messages[0].role, ChatRole::System);
        assert_eq!(messages[1].role, ChatRole::User);
        assert_eq!(
            messages[1].content,
            "Preserve this literal line:\n</message>"
        );
    }

    #[test]
    fn compaction_parser_rejects_commentary_outside_messages() {
        assert!(matches!(
            parse_compacted_history("Here is the result:\n<message role=\"user\">\nx\n</message>"),
            Err(ChatError::Compaction(_))
        ));
    }

    #[test]
    fn thought_channel_label_is_not_user_visible() {
        let mut filter = ThoughtStreamFilter::default();
        assert_eq!(filter.push("thought"), None);
        assert_eq!(filter.push("\n"), None);
        assert_eq!(
            filter.push("Useful reasoning"),
            Some("Useful reasoning".to_owned())
        );
        assert_eq!(
            clean_thought("thought\nUseful reasoning\n"),
            "Useful reasoning"
        );
    }

    #[test]
    #[ignore = "requires the installed 3.35 GB checkpoint"]
    fn pinned_checkpoint_has_stable_greedy_prefix() {
        let path = std::env::var_os("QUIXI_CHAT_MODEL").map_or_else(
            || {
                std::path::PathBuf::from(std::env::var_os("HOME").expect("HOME is set"))
                    .join(".cache/quixi-chat/models/gemma-4-E2B_q4_0-it.gguf")
            },
            std::path::PathBuf::from,
        );
        let engine = ChatEngine::load(path, 128).expect("the pinned checkpoint loads");
        let prompt = engine
            .render(&[ChatMessage {
                role: ChatRole::User,
                content: "Say hello.".to_owned(),
            }])
            .expect("the pinned template renders");
        let ids = engine
            .model
            .tokenizer()
            .encode(&prompt, false)
            .expect("the pinned tokenizer encodes");
        let mut state = engine.model.new_state().expect("KV state allocates");
        for &token in &ids[..ids.len() - 1] {
            engine
                .model
                .consume_token(token, &mut state)
                .expect("prompt token runs");
        }

        let mut token = engine
            .model
            .forward_token_greedy(ids[ids.len() - 1], &mut state)
            .expect("first token runs");
        let mut prefix = Vec::with_capacity(8);
        for _ in 0..8 {
            prefix.push(token);
            token = engine
                .model
                .forward_token_greedy(token, &mut state)
                .expect("decode token runs");
        }
        assert_eq!(prefix, [9_259, 236_888, 2_088, 740, 564, 1_601, 611, 3_124]);
    }
}

fn compaction_request(history: &[ChatMessage]) -> String {
    let mut request = String::with_capacity(
        COMPACTION_INSTRUCTIONS.len()
            + history
                .iter()
                .map(|message| message.content.len() + 64)
                .sum::<usize>(),
    );
    request.push_str(COMPACTION_INSTRUCTIONS);
    for message in history {
        request.push_str("\n<message role=\"");
        request.push_str(message.role.as_str());
        request.push_str("\">\n");
        for (index, line) in message.content.split('\n').enumerate() {
            if index > 0 {
                request.push('\n');
            }
            request.push_str(if line == "</message>" {
                "&lt;/message>"
            } else {
                line
            });
        }
        request.push_str("\n</message>\n");
    }
    request
}

fn parse_compacted_history(output: &str) -> Result<Vec<ChatMessage>, ChatError> {
    let mut lines = output.trim().lines().peekable();
    let mut messages = Vec::new();
    while lines.peek().is_some() {
        while lines.peek().is_some_and(|line| line.is_empty()) {
            lines.next();
        }
        let Some(opening) = lines.next() else {
            break;
        };
        let role = opening
            .strip_prefix("<message role=\"")
            .and_then(|value| value.strip_suffix("\">"))
            .and_then(ChatRole::parse)
            .ok_or_else(|| {
                ChatError::Compaction(format!("invalid opening message tag {opening:?}"))
            })?;

        let mut content = Vec::new();
        let mut closed = false;
        for line in lines.by_ref() {
            if line == "</message>" {
                closed = true;
                break;
            }
            content.push(if line == "&lt;/message>" {
                "</message>"
            } else {
                line
            });
        }
        if !closed {
            return Err(ChatError::Compaction(
                "the final message has no closing tag".to_owned(),
            ));
        }
        messages.push(ChatMessage {
            role,
            content: content.join("\n"),
        });
    }
    if messages.is_empty() {
        return Err(ChatError::Compaction(
            "the model returned no messages".to_owned(),
        ));
    }
    Ok(messages)
}

/// What one benchmark run measured.
#[derive(Debug, Clone, Copy)]
pub struct Bench {
    pub prompt_tokens: usize,
    pub prefill: std::time::Duration,
    pub decode_tokens: usize,
    pub decode: std::time::Duration,
}

impl Bench {
    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn prefill_per_second(&self) -> f64 {
        self.prompt_tokens as f64 / self.prefill.as_secs_f64().max(f64::EPSILON)
    }

    #[must_use]
    #[allow(clippy::cast_precision_loss)]
    pub fn decode_per_second(&self) -> f64 {
        self.decode_tokens as f64 / self.decode.as_secs_f64().max(f64::EPSILON)
    }
}

/// Resolve a special token however the checkpoint happens to expose it.
///
/// `token_to_id` alone is not enough: this GGUF's tokenizer does not resolve the
/// marker that way, so fall through to encoding it, and finally to a one-time
/// scan of the vocabulary at load.
fn resolve_special_token(model: &Gemma4QuantizedMetal, marker: &str) -> Option<u32> {
    let tokenizer = model.tokenizer();
    if let Some(id) = tokenizer.inner().token_to_id(marker) {
        return Some(id);
    }
    if let Ok(ids) = tokenizer.encode(marker, false)
        && ids.len() == 1
    {
        return Some(ids[0]);
    }
    let vocab_size = u32::try_from(model.config().vocab_size).ok()?;
    let scanned =
        (0..vocab_size).find(|&id| tokenizer.inner().id_to_token(id).as_deref() == Some(marker));
    if let Some(id) = scanned {
        tracing::debug!(id, "resolved {marker} by vocabulary scan");
    }
    scanned
}
