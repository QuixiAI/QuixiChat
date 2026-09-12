//! Reviewed first-party API destinations. Caller requests never supply origins.
use crate::host::{Binding, Destination, Route};
pub fn destinations() -> Vec<Destination> {
    let mut registered: Vec<Destination> = [("openai", "https://api.openai.com/", "/v1/chat/completions", "Authorization", "Bearer "),
     ("anthropic", "https://api.anthropic.com/", "/v1/messages", "x-api-key", "")]
        .into_iter().map(|(provider, origin, generation, header, prefix)| Destination {
            binding: Binding { provider_id:provider.into(), account_id:"primary".into(), destination_id:format!("quixi-{provider}-api-v1"), transport_id:format!("quixi-{provider}-native-v1") },
            origin: origin.parse().expect("reviewed HTTPS origin"),
            routes: vec![Route {path:"/v1/models".into(),methods:vec!["GET".into()],headers:if provider=="anthropic" {vec!["anthropic-version".into()]} else {vec![]},query:if provider=="anthropic" {vec!["after_id".into(),"before_id".into(),"limit".into()]} else {vec![]}},
                         Route {path:generation.into(),methods:vec!["POST".into()],headers:if provider=="anthropic" {vec!["content-type".into(),"anthropic-version".into()]} else {vec!["content-type".into()]},query:vec![]}]
                         .into_iter().chain(if provider=="anthropic" {vec![Route {path:"/v1/messages/count_tokens".into(),methods:vec!["POST".into()],headers:vec!["content-type".into(),"anthropic-version".into()],query:vec![]}]} else {vec![]}).collect(),
            credential_header:header.into(),credential_prefix:prefix.into(),privacy:"direct_provider".into(),allow_loopback_http:false,
        }).collect();
    let openai = registered[0].clone();
    for region in ["us", "eu"] {
        let mut destination = openai.clone();
        destination.binding.destination_id = format!("quixi-openai-{region}-api-v1");
        destination.binding.transport_id = format!("quixi-openai-{region}-native-v1");
        destination.origin = format!("https://{region}.api.openai.com/").parse().expect("reviewed regional origin");
        registered.push(destination);
    }
    registered
}

/// Capability evidence comes from this native-owned review, never caller metadata.
/// An altered origin, binding, authentication scheme or route set loses the claim.
pub fn regional_processing(destination: &Destination) -> Option<serde_json::Value> {
    let region = match destination.binding.transport_id.as_str() {
        "quixi-openai-us-native-v1" => "us",
        "quixi-openai-eu-native-v1" => "eu",
        _ => return None,
    };
    let expected = destinations().into_iter().find(|item| item.binding.transport_id == destination.binding.transport_id)?;
    if destination.binding != expected.binding
        || destination.origin != expected.origin
        || destination.privacy != expected.privacy
        || destination.allow_loopback_http
        || destination.credential_header != expected.credential_header
        || destination.credential_prefix != expected.credential_prefix
        || destination.routes.len() != expected.routes.len()
        || !destination.routes.iter().zip(&expected.routes).all(|(actual, reviewed)| {
            actual.path == reviewed.path && actual.methods == reviewed.methods
                && actual.headers == reviewed.headers && actual.query == reviewed.query
        }) {
        return None;
    }
    Some(serde_json::json!({
        "version": 1,
        "configurationId": format!("openai-{region}-gpt41-mini-2026-09-10"),
        "binding": destination.binding,
        "region": region,
        "upstreamOrigin": destination.origin.origin().ascii_serialization(),
        "modelIds": ["gpt-4.1-mini-2025-04-14"],
        "endpoints": ["/v1/chat/completions"],
        "inputModalities": ["text", "image"],
        "sourceUrl": "https://developers.openai.com/api/docs/guides/your-data",
        "reviewedAt": 1788998400000_u64
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regional_registry_has_exact_origins_bindings_routes_and_evidence() {
        let registered = destinations();
        assert_eq!(registered.len(), 4);
        for region in ["us", "eu"] {
            let entry = registered.iter().find(|item| item.binding.transport_id == format!("quixi-openai-{region}-native-v1")).unwrap();
            assert_eq!(entry.binding.provider_id, "openai");
            assert_eq!(entry.binding.account_id, "primary");
            assert_eq!(entry.binding.destination_id, format!("quixi-openai-{region}-api-v1"));
            assert_eq!(entry.origin.as_str(), format!("https://{region}.api.openai.com/"));
            assert_eq!(entry.routes.len(), 2);
            assert_eq!(entry.routes[0].path, "/v1/models");
            assert_eq!(entry.routes[0].methods, ["GET"]);
            assert_eq!(entry.routes[1].path, "/v1/chat/completions");
            assert_eq!(entry.routes[1].methods, ["POST"]);
            assert_eq!(entry.credential_header, "Authorization");
            assert_eq!(entry.credential_prefix, "Bearer ");
            let evidence = regional_processing(entry).unwrap();
            assert_eq!(evidence["region"], region);
            assert_eq!(evidence["modelIds"], serde_json::json!(["gpt-4.1-mini-2025-04-14"]));
            assert_eq!(evidence["endpoints"], serde_json::json!(["/v1/chat/completions"]));
            assert_eq!(evidence["inputModalities"], serde_json::json!(["text", "image"]));
            assert_eq!(evidence["reviewedAt"], 1788998400000_u64);
        }
        assert!(registered[..2].iter().all(|item| regional_processing(item).is_none()));
    }

    #[test]
    fn modified_regional_registrations_cannot_claim_processing_evidence() {
        let source = destinations()[2].clone();
        let mutations: Vec<Box<dyn Fn(&mut Destination)>> = vec![
            Box::new(|item| item.binding.provider_id = "other".into()),
            Box::new(|item| item.binding.account_id = "other".into()),
            Box::new(|item| item.binding.destination_id = "other".into()),
            Box::new(|item| item.binding.transport_id = "quixi-openai-eu-native-v1".into()),
            Box::new(|item| item.origin = "https://api.openai.com/".parse().unwrap()),
            Box::new(|item| item.origin = "https://us.api.openai.com:8443/".parse().unwrap()),
            Box::new(|item| item.allow_loopback_http = true),
            Box::new(|item| item.privacy = "custom_remote".into()),
            Box::new(|item| item.credential_header = "x-api-key".into()),
            Box::new(|item| item.credential_prefix.clear()),
            Box::new(|item| item.routes[1].path = "/v1/responses".into()),
            Box::new(|item| item.routes[1].methods.push("GET".into())),
            Box::new(|item| item.routes[1].headers.push("x-custom".into())),
            Box::new(|item| item.routes[1].query.push("model".into())),
            Box::new(|item| { item.routes.pop(); }),
        ];
        for mutate in mutations {
            let mut altered = source.clone();
            mutate(&mut altered);
            assert!(regional_processing(&altered).is_none());
        }
    }
}

