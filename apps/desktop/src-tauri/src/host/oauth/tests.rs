use super::super::{Operation, start_http};
use super::*;
use std::sync::Barrier;

fn configuration() -> OAuthConfiguration {
    OAuthConfiguration {
        id: "synthetic-oauth".into(),
        binding: Binding {
            provider_id: "synthetic".into(),
            account_id: "default".into(),
            destination_id: "synthetic-api".into(),
            transport_id: "native".into(),
        },
        authorization_endpoint: "https://oauth.synthetic.invalid/authorize".into(),
        token_endpoint: "https://oauth.synthetic.invalid/token".into(),
        redirect_uri: "ai.quixi.chat://oauth/callback".into(),
        issuer: "https://oauth.synthetic.invalid".into(),
        client_id: "synthetic-public-client".into(),
        allowed_scopes: vec!["chat.read".into()],
        timeout_ms: 30_000,
    }
}
fn destination() -> Destination {
    Destination {
        binding: configuration().binding,
        origin: "https://api.synthetic.invalid/".parse().unwrap(),
        routes: vec![Route {
            path: "/v1/models".into(),
            methods: vec!["GET".into()],
            headers: vec![],
            query: vec![],
        }],
        credential_header: "Authorization".into(),
        credential_prefix: "Bearer ".into(),
        privacy: "direct_provider".into(),
        allow_loopback_http: false,
    }
}
fn manager() -> Arc<OAuthManager> {
    Arc::new(OAuthManager::new(vec![configuration()], &[destination()]).unwrap())
}
fn session() -> Arc<Session> {
    Arc::new(Session {
        id: uuid::Uuid::new_v4().to_string(),
        owner: "main".into(),
        closed: AtomicBool::new(false),
        operations: Mutex::new(HashMap::new()),
        sources: Mutex::new(HashMap::new()),
    })
}
fn pending(
    manager: &OAuthManager,
    owner: &Arc<Session>,
    phase: u8,
) -> (Arc<Flow>, oneshot::Receiver<Result<Zeroizing<String>>>) {
    let (sender, receiver) = oneshot::channel();
    let flow = Arc::new(Flow {
        request: uuid::Uuid::new_v4().to_string(),
        owner: owner.id.clone(),
        session: Arc::downgrade(owner),
        configuration: configuration(),
        state: Zeroizing::new("synthetic-state".into()),
        deadline: Instant::now() + Duration::from_secs(30),
        phase: AtomicU8::new(phase),
        abandoned: AtomicBool::new(false),
        dispatched: AtomicBool::new(false),
        cancellation: CancellationToken::new(),
        callback: Mutex::new(Some(sender)),
    });
    manager
        .inner
        .lock()
        .unwrap()
        .live
        .insert(flow.request.clone(), flow.clone());
    (flow, receiver)
}
fn callback_url(state: &str, issuer: &str) -> String {
    format!(
        "{}?{}",
        configuration().redirect_uri,
        String::from_utf8(
            form_body(&[
                ("state", state),
                ("iss", issuer),
                ("code", "synthetic-code")
            ])
            .to_vec()
        )
        .unwrap()
    )
}
fn result_handle(flow: &Flow) -> Value {
    json!({"requestId":flow.request,"credential":{"id":"synthetic-opaque-handle"}})
}

#[test]
fn configurations_bind_https_callback_scopes_and_bearer_authority() {
    let valid = configuration();
    assert!(OAuthManager::new(vec![valid.clone()], &[destination()]).is_ok());
    let mut invalid = Vec::new();
    for endpoint in [
        "http://oauth.synthetic.invalid/authorize",
        "https://user@oauth.synthetic.invalid/authorize",
        "https://oauth.synthetic.invalid/authorize?extra=1",
        "https://oauth.synthetic.invalid/authorize#fragment",
    ] {
        let mut value = valid.clone();
        value.authorization_endpoint = endpoint.into();
        invalid.push(value);
    }
    let mut value = valid.clone();
    value.token_endpoint = format!("https://oauth.synthetic.invalid/{}", "x".repeat(2048));
    invalid.push(value);
    for redirect in [
        "https://example.invalid/callback",
        "ai.quixi.chat://other/callback",
        "ai.quixi.chat://oauth/callback/",
        "ai.quixi.chat://oauth/%63allback",
        "ai.quixi.chat://oauth/callback?x=1",
    ] {
        let mut value = valid.clone();
        value.redirect_uri = redirect.into();
        invalid.push(value);
    }
    for scopes in [
        vec!["offline_access".into()],
        vec!["chat.read".into(), "chat.read".into()],
        vec!["two scopes".into()],
    ] {
        let mut value = valid.clone();
        value.allowed_scopes = scopes;
        invalid.push(value);
    }
    for timeout in [0, 300_001] {
        let mut value = valid.clone();
        value.timeout_ms = timeout;
        invalid.push(value);
    }
    for value in invalid {
        assert!(OAuthManager::new(vec![value], &[destination()]).is_err());
    }
    assert!(OAuthManager::new(vec![valid.clone(), valid.clone()], &[destination()]).is_err());
    for (header, prefix) in [("X-Api-Key", "Bearer "), ("Authorization", "Basic ")] {
        let mut dest = destination();
        dest.credential_header = header.into();
        dest.credential_prefix = prefix.into();
        assert!(OAuthManager::new(vec![valid.clone()], &[dest]).is_err());
    }
    assert!(OAuthManager::new(vec![valid], &[]).is_err());
    assert!(!OAuthManager::new(vec![], &[]).unwrap().available());
}

#[test]
fn raw_callback_parser_rejects_ambiguity_and_bounds_without_normalization_claims() {
    let base = configuration().redirect_uri;
    let good = callback_url("synthetic-state", &configuration().issuer);
    assert_eq!(
        &**callback(&good, &base).unwrap().get("code").unwrap(),
        "synthetic-code"
    );
    let suffix = good.split_once('?').unwrap().1;
    for bad in [
        format!("{good}&state=second"),
        format!("{good}&extra=x"),
        format!("{good}#fragment"),
        good.replace("state=", "%73tate="),
        good.replace("synthetic-code", "%GG"),
        good.replace("synthetic-code", "%FF"),
        good.replace("synthetic-code", "%00"),
        good.replace("synthetic-code", "%0A"),
        good.replace("synthetic-code", ""),
        format!("{good}&error=denied"),
        format!("{good}&error_description=extra"),
        format!("ai.quixi.chat://oauth/other?{suffix}"),
        format!("ai.quixi.chat://oauth/%63allback?{suffix}"),
        good.replace("synthetic-code", &"x".repeat(4097)),
        good.replace("synthetic-state", &"x".repeat(1025)),
        format!("{good}{}", "x".repeat(8192)),
    ] {
        assert!(
            callback(&bad, &base).is_none(),
            "accepted malformed synthetic callback"
        );
    }
    let encoded = good.replace("synthetic-code", "one%2Btwo+three%26four%3Dfive");
    assert_eq!(
        &**callback(&encoded, &base).unwrap().get("code").unwrap(),
        "one+two three&four=five"
    );
}

#[test]
fn callback_wrong_state_issuer_endpoint_and_expiry_do_not_consume_flow() {
    let manager = manager();
    let owner = session();
    let (flow, mut receiver) = pending(&manager, &owner, WAITING);
    for bad in [
        callback_url("wrong-state", &configuration().issuer),
        callback_url("synthetic-state", "https://other.invalid"),
        callback_url("synthetic-state", &configuration().issuer).replace("/callback?", "/other?"),
    ] {
        assert!(!manager.deliver(&bad));
    }
    assert_eq!(flow.phase.load(Ordering::SeqCst), WAITING);
    assert!(matches!(
        receiver.try_recv(),
        Err(oneshot::error::TryRecvError::Empty)
    ));
    assert!(manager.deliver(&callback_url("synthetic-state", &configuration().issuer)));
    assert_eq!(&*receiver.try_recv().unwrap().unwrap(), "synthetic-code");
    assert!(!manager.deliver(&callback_url("synthetic-state", &configuration().issuer)));
    assert_eq!(manager.accepted_callbacks.load(Ordering::SeqCst), 1);
    let (mut expired, _) = pending(&manager, &owner, WAITING);
    manager.inner.lock().unwrap().live.remove(&expired.request);
    Arc::get_mut(&mut expired).unwrap().deadline = Instant::now() - Duration::from_secs(1);
    manager
        .inner
        .lock()
        .unwrap()
        .live
        .insert(expired.request.clone(), expired);
    assert!(!manager.deliver(&callback_url("synthetic-state", &configuration().issuer)));
}

#[test]
fn concurrent_duplicate_callbacks_deliver_one_code_only() {
    let manager = manager();
    let owner = session();
    let (_, mut receiver) = pending(&manager, &owner, WAITING);
    let barrier = Arc::new(Barrier::new(9));
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let manager = manager.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                manager.deliver(&callback_url("synthetic-state", &configuration().issuer))
            })
        })
        .collect();
    barrier.wait();
    assert_eq!(
        workers
            .into_iter()
            .map(|worker| usize::from(worker.join().unwrap()))
            .sum::<usize>(),
        1
    );
    assert_eq!(&*receiver.try_recv().unwrap().unwrap(), "synthetic-code");
}

#[test]
fn correlated_denial_consumes_callback_without_exposing_provider_error_text() {
    let manager = manager();
    let owner = session();
    let (_, mut receiver) = pending(&manager, &owner, WAITING);
    let denial=callback_url("synthetic-state",&configuration().issuer).replace("code=synthetic-code","error=access_denied&error_description=synthetic-private-description&error_uri=https%3A%2F%2Ferror.invalid");
    assert!(manager.deliver(&denial));
    let failure = receiver.try_recv().unwrap().unwrap_err();
    assert_eq!(failure.code, "IO_ERROR");
    assert!(
        !serde_json::to_string(&failure)
            .unwrap()
            .contains("synthetic-private-description")
    );
    assert!(!manager.deliver(&callback_url("synthetic-state", &configuration().issuer)));
    assert_eq!(manager.token_exchanges.load(Ordering::SeqCst), 0);
}

#[test]
fn token_parser_returns_only_bounded_access_token_and_refuses_unsafe_shapes() {
    let accepted = json!({"access_token":"synthetic-access","token_type":"bearer","expires_in":3600,"scope":"chat.read","refresh_token":"synthetic-refresh","id_token":"synthetic-id"});
    assert_eq!(
        &*token(
            &serde_json::to_vec(&accepted).unwrap(),
            "request",
            &["chat.read".into()]
        )
        .unwrap(),
        b"synthetic-access"
    );
    for patch in [
        json!({"access_token":""}),
        json!({"access_token":"two words"}),
        json!({"access_token":"line\nvalue"}),
        json!({"access_token":"é"}),
        json!({"access_token":"x".repeat(16385)}),
        json!({"token_type":"Basic"}),
        json!({"expires_in":0}),
        json!({"expires_in":-1}),
        json!({"expires_in":1.5}),
        json!({"expires_in":9_007_199_254_740_992u64}),
        json!({"unexpected":"field"}),
        json!({"refresh_token":42}),
    ] {
        let mut value = accepted.clone();
        value
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        let failure = token(
            &serde_json::to_vec(&value).unwrap(),
            "request",
            &["chat.read".into()],
        )
        .unwrap_err();
        assert_eq!(failure.code, "IO_ERROR");
        assert!(
            !serde_json::to_string(&failure)
                .unwrap()
                .contains("synthetic-access")
        );
    }
    assert!(
        token(
            br#"{"access_token":"one","access_token":"two","token_type":"Bearer"}"#,
            "request",
            &[]
        )
        .is_err()
    );
    let mut maximum = accepted;
    maximum["access_token"] = json!("x".repeat(16384));
    assert_eq!(
        token(
            &serde_json::to_vec(&maximum).unwrap(),
            "request",
            &["chat.read".into()]
        )
        .unwrap()
        .len(),
        16384
    );
}

#[test]
fn token_form_encodes_reserved_bytes_and_pkce_entropy_is_independent() {
    let body = form_body(&[
        ("code", "a+b &c=é"),
        ("redirect_uri", "ai.quixi.chat://oauth/callback"),
    ]);
    assert_eq!(
        &*body,
        b"code=a%2Bb+%26c%3D%C3%A9&redirect_uri=ai.quixi.chat%3A%2F%2Foauth%2Fcallback"
    );
    let first = random_secret("request").unwrap();
    let second = random_secret("request").unwrap();
    assert_eq!(first.len(), 43);
    assert_eq!(URL_SAFE_NO_PAD.decode(first.as_bytes()).unwrap().len(), 32);
    assert!(!equal_secret(&first, &second));
    assert!(equal_secret(&first, &first));
    assert_eq!(
        URL_SAFE_NO_PAD.encode(Sha256::digest(
            b"dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
        )),
        "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    );
}

#[test]
fn returned_scopes_cannot_expand_requested_authority() {
    let base = json!({"access_token":"synthetic-access","token_type":"Bearer"});
    assert!(
        token(
            &serde_json::to_vec(&base).unwrap(),
            "request",
            &["chat.read".into()]
        )
        .is_ok()
    );
    for scope in [
        json!("chat.write"),
        json!("chat.read offline_access"),
        json!("chat.read  chat.read"),
        json!("chat.read\tchat.write"),
        Value::Null,
    ] {
        let mut value = base.clone();
        value["scope"] = scope;
        assert!(
            token(
                &serde_json::to_vec(&value).unwrap(),
                "request",
                &["chat.read".into()]
            )
            .is_err()
        );
    }
    let mut value = base;
    value["scope"] = json!("chat.read");
    assert!(token(&serde_json::to_vec(&value).unwrap(), "request", &[]).is_err());
    assert!(
        token(
            &serde_json::to_vec(&value).unwrap(),
            "request",
            &["chat.read".into(), "chat.write".into()]
        )
        .is_ok()
    );
}

#[test]
fn cancellation_merge_keeps_the_strongest_effect_from_every_registry() {
    use super::super::combine_cancellations;
    let completed = json!({"outcome":"already_completed","externalEffect":"not_dispatched"});
    let cancelled = json!({"outcome":"cancelled","externalEffect":"not_dispatched"});
    let dispatched = json!({"outcome":"already_completed","externalEffect":"may_have_occurred"});
    let unknown = json!({"outcome":"unknown_outcome","externalEffect":"may_have_occurred"});
    for values in [
        vec![completed.clone(), cancelled.clone(), dispatched.clone()],
        vec![dispatched, completed.clone(), cancelled.clone()],
    ] {
        let result = combine_cancellations("request", &values);
        assert_eq!(result["outcome"], "cancelled");
        assert_eq!(result["externalEffect"], "may_have_occurred");
    }
    assert_eq!(
        combine_cancellations("request", &[completed, cancelled, unknown])["outcome"],
        "unknown_outcome"
    );
    assert_eq!(
        combine_cancellations("request", &[])["outcome"],
        "unknown_outcome"
    );
}

#[test]
fn native_cancel_stops_colliding_operations_and_keeps_external_effect() {
    let manager = manager();
    let mut host = NativeHost::new(
        vec![destination()],
        format!("ai.quixi.test.oauth.{}", uuid::Uuid::new_v4()),
    )
    .unwrap();
    host.oauth = manager.clone();
    let owner = session();
    let (flow, _) = pending(&manager, &owner, WAITING);
    let operation = Arc::new(Operation {
        token: CancellationToken::new(),
        complete: AtomicBool::new(false),
        dispatched: AtomicBool::new(true),
        timed_out: AtomicBool::new(false),
        secret_id: None,
        body_bytes: Mutex::new(0),
        transfer_id: Mutex::new(None),
        permit: Mutex::new(None),
    });
    // Admission now prevents this collision. Retain a defensive integration
    // check that no registry can hide another operation from cancellation.
    owner
        .operations
        .lock()
        .unwrap()
        .insert(flow.request.clone(), operation.clone());
    let result = host.cancel(&owner, &flow.request);
    assert!(operation.token.is_cancelled());
    assert!(operation.complete.load(Ordering::SeqCst));
    assert!(flow.cancellation.is_cancelled());
    assert_eq!(result["outcome"], "cancelled");
    assert_eq!(result["externalEffect"], "may_have_occurred");
}

#[test]
fn cancellation_before_commit_prevents_commit_and_handle_publication() {
    let manager = manager();
    let owner = session();
    let (flow, _) = pending(&manager, &owner, EXCHANGING);
    let cancellation = manager.cancel(&owner.id, &flow.request).unwrap();
    assert_eq!(cancellation["outcome"], "cancelled");
    assert_eq!(cancellation["externalEffect"], "not_dispatched");
    assert_eq!(flow.commit(&owner).unwrap_err().code, "CANCELLED");
    assert_eq!(
        manager
            .finish(&flow, Ok(result_handle(&flow)))
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    assert_eq!(
        manager.cancel(&owner.id, &flow.request).unwrap()["outcome"],
        "cancelled"
    );
}

#[test]
fn cancellation_after_commit_is_unknown_and_manual_mutation_refuses_until_settlement() {
    let manager = manager();
    let owner = session();
    let (flow, _) = pending(&manager, &owner, EXCHANGING);
    flow.commit(&owner).unwrap();
    assert_eq!(flow.phase.load(Ordering::SeqCst), COMMITTING);
    assert_eq!(
        manager
            .invalidate_binding(&flow.configuration.binding, "manual-delete")
            .unwrap_err()
            .code,
        "UNKNOWN_OUTCOME"
    );
    let cancellation = manager.cancel(&owner.id, &flow.request).unwrap();
    assert_eq!(cancellation["outcome"], "unknown_outcome");
    assert_eq!(cancellation["externalEffect"], "may_have_occurred");
    let failure = manager.finish(&flow, Ok(result_handle(&flow))).unwrap_err();
    assert_eq!(failure.code, "UNKNOWN_OUTCOME");
    assert_eq!(failure.retry, "after_user_action");
    assert!(
        manager
            .invalidate_binding(&flow.configuration.binding, "manual-delete")
            .is_ok()
    );
    assert_eq!(
        manager.cancel(&owner.id, &flow.request).unwrap()["outcome"],
        "unknown_outcome"
    );
}

#[test]
fn binding_invalidation_cancels_all_owners_but_preserves_unrelated_bindings() {
    let manager = manager();
    let first = session();
    let second = session();
    let (flow, _) = pending(&manager, &first, EXCHANGING);
    let (other, _) = pending(&manager, &second, WAITING);
    let mut unrelated = configuration().binding;
    unrelated.account_id = "unrelated".into();
    manager
        .invalidate_binding(&unrelated, "manual-store")
        .unwrap();
    assert!(!flow.abandoned.load(Ordering::SeqCst));
    manager
        .invalidate_binding(&flow.configuration.binding, "manual-store")
        .unwrap();
    assert!(flow.commit(&first).is_err());
    assert!(other.active(&second).is_err());
}

#[test]
fn owner_close_retires_receipts_and_late_commit_never_recreates_them() {
    let manager = manager();
    let owner = session();
    let other = session();
    let (completed, _) = pending(&manager, &owner, EXCHANGING);
    completed.commit(&owner).unwrap();
    manager
        .finish(&completed, Ok(result_handle(&completed)))
        .unwrap();
    let (preserved, _) = pending(&manager, &other, EXCHANGING);
    preserved.commit(&other).unwrap();
    manager
        .finish(&preserved, Ok(result_handle(&preserved)))
        .unwrap();
    let (late, _) = pending(&manager, &owner, EXCHANGING);
    late.commit(&owner).unwrap();
    owner.closed.store(true, Ordering::SeqCst);
    manager.close(&owner.id);
    assert!(manager.cancel(&owner.id, &completed.request).is_none());
    assert_eq!(
        manager
            .finish(&late, Ok(result_handle(&late)))
            .unwrap_err()
            .code,
        "UNKNOWN_OUTCOME"
    );
    assert!(manager.cancel(&owner.id, &late.request).is_none());
    assert_eq!(manager.inner.lock().unwrap().receipts.len(), 1);
    assert!(manager.cancel(&other.id, &preserved.request).is_some());
    assert!(manager.inner.lock().unwrap().live.is_empty());
}

#[test]
fn owner_close_before_commit_and_dropped_owner_never_publish_handles() {
    let manager = manager();
    let owner = session();
    let (flow, _) = pending(&manager, &owner, EXCHANGING);
    owner.closed.store(true, Ordering::SeqCst);
    manager.close(&owner.id);
    assert_eq!(flow.commit(&owner).unwrap_err().code, "CANCELLED");
    assert!(manager.finish(&flow, Ok(result_handle(&flow))).is_err());
    let owner = session();
    let (flow, _) = pending(&manager, &owner, COMMITTING);
    drop(owner);
    assert_eq!(
        manager
            .finish(&flow, Ok(result_handle(&flow)))
            .unwrap_err()
            .code,
        "UNKNOWN_OUTCOME"
    );
    assert!(manager.inner.lock().unwrap().receipts.is_empty());
}

#[test]
fn cancel_and_success_completion_have_one_ordered_outcome() {
    for _ in 0..32 {
        let manager = manager();
        let owner = session();
        let (flow, _) = pending(&manager, &owner, EXCHANGING);
        flow.commit(&owner).unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let cancel = {
            let manager = manager.clone();
            let owner = owner.clone();
            let flow = flow.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                manager.cancel(&owner.id, &flow.request).unwrap()
            })
        };
        let finish = {
            let manager = manager.clone();
            let flow = flow.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                manager.finish(&flow, Ok(result_handle(&flow)))
            })
        };
        barrier.wait();
        let cancellation = cancel.join().unwrap();
        let result = finish.join().unwrap();
        match cancellation["outcome"].as_str().unwrap() {
            "unknown_outcome" => assert_eq!(result.unwrap_err().code, "UNKNOWN_OUTCOME"),
            "already_completed" => assert!(result.is_ok()),
            other => panic!("unexpected cancellation receipt {other}"),
        }
    }
}

fn http_request(request: &str) -> HttpRequest {
    HttpRequest {
        request_id: request.into(),
        binding: configuration().binding,
        method: "GET".into(),
        path: "/v1/models".into(),
        query: BTreeMap::new(),
        headers: BTreeMap::new(),
        credential: None,
        body_transfer_id: None,
        timeout: Timeouts {
            connect_ms: 100,
            idle_ms: 100,
            total_ms: 100,
        },
    }
}

#[tokio::test]
async fn http_admission_rejects_live_and_completed_oauth_identity_before_network() {
    let manager = manager();
    let mut host = NativeHost::new(
        vec![destination()],
        format!("ai.quixi.test.oauth.{}", uuid::Uuid::new_v4()),
    )
    .unwrap();
    host.oauth = manager.clone();
    let host = Arc::new(host);
    let owner = session();
    let (flow, _) = pending(&manager, &owner, EXCHANGING);
    for complete in [false, true] {
        if complete {
            flow.commit(&owner).unwrap();
            manager.finish(&flow, Ok(result_handle(&flow))).unwrap();
        }
        assert_eq!(
            start_http(
                host.clone(),
                owner.clone(),
                owner.id.clone(),
                http_request(&flow.request)
            )
            .await
            .unwrap_err()
            .code,
            "CONFLICT"
        );
        assert!(owner.operations.lock().unwrap().is_empty());
    }
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn oauth_admission_rejects_http_identity_before_keychain_or_opener() {
    let manager = manager();
    let mut host = NativeHost::new(
        vec![destination()],
        format!("ai.quixi.test.oauth.{}", uuid::Uuid::new_v4()),
    )
    .unwrap();
    host.oauth = manager.clone();
    let host = Arc::new(host);
    let owner = session();
    let request = uuid::Uuid::new_v4().to_string();
    owner.operations.lock().unwrap().insert(
        request.clone(),
        Arc::new(Operation {
            token: CancellationToken::new(),
            complete: AtomicBool::new(false),
            dispatched: AtomicBool::new(false),
            timed_out: AtomicBool::new(false),
            secret_id: None,
            body_bytes: Mutex::new(0),
            transfer_id: Mutex::new(None),
            permit: Mutex::new(None),
        }),
    );
    let result = manager
        .clone()
        .start(
            host,
            owner,
            OAuthArgs {
                request_id: request,
                provider_id: configuration().binding.provider_id,
                configuration_id: configuration().id,
                scopes: vec![],
            },
        )
        .await;
    assert_eq!(result.unwrap_err().code, "CONFLICT");
    assert!(manager.inner.lock().unwrap().live.is_empty());
    assert_eq!(manager.token_exchanges.load(Ordering::SeqCst), 0);
}
