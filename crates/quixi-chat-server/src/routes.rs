//! The authenticated streaming chat route.

use std::convert::Infallible;

use axum::{
    Json,
    body::Body,
    extract::{Query, Request, State as AxumState},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    middleware::Next,
    response::Response,
};
use futures_util::stream;
use serde::Deserialize;

#[derive(Clone)]
pub struct State {
    pub token: String,
    pub llm: crate::LlmService,
}

#[derive(Debug, Deserialize)]
pub struct TokenQuery {
    t: Option<String>,
}

/// Reject API calls that do not carry this launch's session token.
pub async fn require_token(
    AxumState(state): AxumState<State>,
    Query(query): Query<TokenQuery>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let header = headers
        .get("x-quixi-chat-token")
        .and_then(|value| value.to_str().ok());
    let presented = query.t.as_deref().or(header);

    if presented.is_some_and(|token| token == state.token) {
        Ok(next.run(request).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

#[derive(Debug, Deserialize)]
pub struct ChatRequest {
    pub messages: Vec<quixi_chat_engine::ChatMessage>,
}

/// One conversational turn, returned as newline-delimited JSON events. Keeping
/// this as an authenticated POST avoids putting conversation text in a URL,
/// while Axum's streaming body flushes each decoded token chunk immediately.
pub async fn chat(
    AxumState(state): AxumState<State>,
    Json(request): Json<ChatRequest>,
) -> Result<Response, (StatusCode, String)> {
    if request.messages.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "no messages".to_owned()));
    }

    let events = state
        .llm
        .chat(request.messages)
        .await
        .map_err(|error| (StatusCode::SERVICE_UNAVAILABLE, error))?;
    Ok(stream_response(events))
}

fn stream_response(events: tokio::sync::mpsc::Receiver<crate::ChatStreamEvent>) -> Response {
    let body = Body::from_stream(stream::unfold(events, |mut events| async move {
        events.recv().await.map(|event| {
            let mut line = serde_json::to_string(&event).expect("chat events are serializable");
            line.push('\n');
            (Ok::<String, Infallible>(line), events)
        })
    }));
    let mut response = Response::new(body);
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/x-ndjson; charset=utf-8"),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn chat_stream_is_incremental_ndjson() {
        let (sender, receiver) = tokio::sync::mpsc::channel(8);
        sender.send(crate::ChatStreamEvent::Loading).await.unwrap();
        sender
            .send(crate::ChatStreamEvent::Compacting {
                original_tokens: 90_001,
            })
            .await
            .unwrap();
        sender
            .send(crate::ChatStreamEvent::Compacted {
                messages: vec![quixi_chat_engine::ChatMessage {
                    role: quixi_chat_engine::ChatRole::User,
                    content: "continue".to_owned(),
                }],
                original_tokens: 90_001,
                compacted_tokens: 12_345,
            })
            .await
            .unwrap();
        sender.send(crate::ChatStreamEvent::Thinking).await.unwrap();
        sender
            .send(crate::ChatStreamEvent::ThinkingDelta {
                text: "private".to_owned(),
            })
            .await
            .unwrap();
        sender
            .send(crate::ChatStreamEvent::Answering)
            .await
            .unwrap();
        sender
            .send(crate::ChatStreamEvent::Delta {
                text: "hello".to_owned(),
            })
            .await
            .unwrap();
        sender
            .send(crate::ChatStreamEvent::Done {
                reply: "hello".to_owned(),
                thinking: "private".to_owned(),
                elapsed_ms: 7,
            })
            .await
            .unwrap();
        drop(sender);

        let response = stream_response(receiver);
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/x-ndjson; charset=utf-8"
        );
        let body = axum::body::to_bytes(response.into_body(), 1_024)
            .await
            .unwrap();
        assert_eq!(
            std::str::from_utf8(&body).unwrap(),
            "{\"type\":\"loading\"}\n\
             {\"type\":\"compacting\",\"original_tokens\":90001}\n\
             {\"type\":\"compacted\",\"messages\":[{\"role\":\"user\",\"content\":\"continue\"}],\"original_tokens\":90001,\"compacted_tokens\":12345}\n\
             {\"type\":\"thinking\"}\n\
             {\"type\":\"thinking_delta\",\"text\":\"private\"}\n\
             {\"type\":\"answering\"}\n\
             {\"type\":\"delta\",\"text\":\"hello\"}\n\
             {\"type\":\"done\",\"reply\":\"hello\",\"thinking\":\"private\",\"elapsed_ms\":7}\n"
        );
    }
}
