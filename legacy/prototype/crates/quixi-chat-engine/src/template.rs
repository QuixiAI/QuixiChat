//! Prompt rendering through the model's own chat template.
//!
//! Gemma 4 ships a full Jinja2 template inside the GGUF — macros, namespaces,
//! `dictsort`, capture blocks, forward scans for tool continuation. Writing a
//! Rust approximation of it is how you end up feeding the model a prompt it was
//! never tuned on, which is exactly the bug this module exists to prevent: an
//! earlier version used Gemma 3's `<start_of_turn>` markers, so the prompt was
//! malformed *and* the stop token did not exist, making every reply run to the
//! token limit.
//!
//! So: render the template the checkpoint actually carries.

use std::sync::Arc;

use minijinja::{
    Environment, Error, ErrorKind, State, Value, context,
    value::{Enumerator, Object},
};
use thiserror::Error as ThisError;

/// Marker that closes any turn in Gemma 4's template, including the model's.
pub const TURN_CLOSE: &str = "<turn|>";

#[derive(Debug, ThisError)]
pub enum TemplateError {
    #[error("the checkpoint carries no chat template")]
    Missing,
    #[error("chat template failed to render: {0}")]
    Render(String),
}

/// One message, in the shape the template indexes into.
///
/// Exposed to Jinja as an object rather than a plain map because the template
/// calls `message.get('reasoning')`, `message.get('tool_calls')` and friends.
/// A map has no `get` method in minijinja, and those calls must return
/// undefined — not fail — for an ordinary conversation with no tools.
#[derive(Debug, Clone)]
pub struct TemplateMessage {
    pub role: &'static str,
    pub content: String,
}

impl Object for TemplateMessage {
    fn get_value(self: &Arc<Self>, key: &Value) -> Option<Value> {
        match key.as_str()? {
            "role" => Some(Value::from(self.role)),
            "content" => Some(Value::from(self.content.clone())),
            _ => None,
        }
    }

    fn enumerate(self: &Arc<Self>) -> Enumerator {
        Enumerator::Str(&["role", "content"])
    }

    fn call_method(
        self: &Arc<Self>,
        _state: &State<'_, '_>,
        name: &str,
        args: &[Value],
    ) -> Result<Value, Error> {
        match name {
            // `get(key)` and `get(key, default)`; unknown keys are undefined,
            // which is what every tool/reasoning branch in the template tests.
            "get" => {
                let key = args
                    .first()
                    .ok_or_else(|| Error::new(ErrorKind::MissingArgument, "get(key)"))?;
                Ok(self
                    .get_value(key)
                    .or_else(|| args.get(1).cloned())
                    .unwrap_or(Value::UNDEFINED))
            }
            other => Err(Error::new(
                ErrorKind::UnknownMethod,
                format!("message has no method {other}"),
            )),
        }
    }
}

/// Render `messages` with the checkpoint's template.
///
/// `add_generation_prompt` opens the model's turn, which is what makes the
/// model answer rather than continue the user.
pub fn render(
    template: &str,
    bos_token: &str,
    messages: &[TemplateMessage],
    add_generation_prompt: bool,
) -> Result<String, TemplateError> {
    if template.trim().is_empty() {
        return Err(TemplateError::Missing);
    }

    let mut environment = Environment::new();
    // The template calls this when tool arguments arrive in the wrong shape.
    // Without it registered, minijinja fails at parse time on an unknown name.
    environment.add_function(
        "raise_exception",
        |message: String| -> Result<Value, Error> {
            Err(Error::new(ErrorKind::InvalidOperation, message))
        },
    );
    // Hugging Face chat templates are written against Python's Jinja, so they
    // call Python string and dict methods — `text.split(...)`, `message.get(...)`.
    // minijinja-contrib's pycompat callback implements exactly that surface;
    // it exists for this use case.
    environment.set_unknown_method_callback(minijinja_contrib::pycompat::unknown_method_callback);
    environment
        .add_template("chat", template)
        .map_err(|error| TemplateError::Render(error.to_string()))?;

    let rendered = environment
        .get_template("chat")
        .map_err(|error| TemplateError::Render(error.to_string()))?
        .render(context! {
            bos_token => bos_token,
            messages => messages
                .iter()
                .cloned()
                .map(Value::from_object)
                .collect::<Vec<_>>(),
            add_generation_prompt => add_generation_prompt,
            // Gemma 4's own template injects `<|think|>` at the very top of
            // the first system turn when this is true. The generation layer
            // keeps its private thought channel separate from the answer. The
            // UI may reveal it explicitly, but it never enters chat history.
            enable_thinking => true,
            preserve_thinking => false,
            tools => Vec::<Value>::new(),
        })
        .map_err(|error| TemplateError::Render(format!("{error:#}")))?;

    Ok(rendered)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The turn-structure subset of the shipped template, which is all a plain
    /// conversation exercises. The real one is checked against the GGUF at
    /// runtime; this keeps the unit test hermetic.
    const SUBSET: &str = r"{{- bos_token -}}
{%- for message in messages -%}
{%- set role = 'model' if message['role'] == 'assistant' else message['role'] -%}
{{- '<|turn>' + role + '\n' -}}
{{- message['content'] | trim -}}
{{- '<turn|>\n' -}}
{%- endfor -%}
{%- if add_generation_prompt -%}{{- '<|turn>model\n' -}}{%- endif -%}";

    fn message(role: &'static str, content: &str) -> TemplateMessage {
        TemplateMessage {
            role,
            content: content.to_owned(),
        }
    }

    #[test]
    fn renders_turns_and_opens_a_model_turn() {
        let out = render(
            SUBSET,
            "<bos>",
            &[
                message("user", " hello "),
                message("assistant", "hi"),
                message("user", "how are you?"),
            ],
            true,
        )
        .expect("subset template renders");

        assert_eq!(
            out,
            "<bos><|turn>user\nhello<turn|>\n\
             <|turn>model\nhi<turn|>\n\
             <|turn>user\nhow are you?<turn|>\n\
             <|turn>model\n"
        );
    }

    #[test]
    fn enables_the_checkpoints_thinking_system_prefix() {
        let template = r"{{- bos_token -}}
{%- if enable_thinking -%}{{- '<|turn>system\n<|think|>\n<turn|>\n' -}}{%- endif -%}
{{- '<|turn>user\n' + messages[0]['content'] + '<turn|>\n' -}}";
        let out = render(template, "<bos>", &[message("user", "hello")], true).unwrap();
        assert_eq!(
            out,
            "<bos><|turn>system\n<|think|>\n<turn|>\n<|turn>user\nhello<turn|>\n"
        );
    }

    #[test]
    fn an_empty_template_is_an_error_rather_than_a_silent_bad_prompt() {
        assert!(matches!(
            render("   ", "<bos>", &[message("user", "x")], true),
            Err(TemplateError::Missing)
        ));
    }
}
