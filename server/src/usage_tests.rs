use super::*;

fn report(tokens: u64) -> Value {
    json!({"status":"stopped", "remoteEnabled":true, "telemetry":{"providers":[{
        "provider":"openai-codex", "source":"Companion subscription limits",
        "updatedAt":"2026-10-07T10:00:00Z", "weekly":{"usedPercent":16},
        "fiveHour":{"usedPercent":20,"resetsAt":"2026-10-07T12:00:00Z"},
        "sessionTokens":tokens, "sessionCost":0, "apiKey":"never-store-this"
    }]}})
}

#[tokio::test]
async fn usage_survives_archive_and_daemon_restart_without_storing_private_metadata() {
    let state = test_state();
    add_session(&state, "closed", true).await;
    state.sessions.write().await.get_mut("closed").unwrap().snapshot = report(123);
    cache_session_usage(&state, "closed").await;
    assert_eq!(delete_session(&state, "closed", false).await.unwrap(), StatusCode::NO_CONTENT);
    let (_, body) = call(&local_router(state.clone()), get("/api/sessions", None, None)).await;
    let body: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(body["sessions"], json!([]));
    assert_eq!(body["usageSnapshots"][0]["telemetry"]["providers"][0]["sessionTokens"].as_f64(), Some(123.0));
    let disk = fs::read_to_string(state.data_dir.join("usage.json")).await.unwrap();
    assert!(!disk.contains("never-store-this"));
    assert!(!disk.contains("cwd"));
    let restored = usage::load(&state.data_dir).await;
    let saved = serde_json::to_value(restored.snapshots(false)).unwrap();
    assert_eq!(saved[0]["status"], "stopped");
    assert_eq!(saved[0]["telemetry"]["providers"][0]["fiveHour"]["usedPercent"].as_f64(), Some(20.0));
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(state.data_dir.join("usage.json")).await.unwrap().permissions().mode() & 0o777, 0o600);
    }
    fs::remove_dir_all(&state.data_dir).await.unwrap();
}

#[tokio::test]
async fn usage_remote_snapshots_require_authentication_and_respect_sharing_revocation() {
    let state = test_state();
    let (_, token) = pair(&state).await;
    add_session(&state, "shared", true).await;
    state.sessions.write().await.get_mut("shared").unwrap().snapshot = report(42);
    cache_session_usage(&state, "shared").await;
    let remote = remote_router(state.clone());
    assert_eq!(call(&remote, get("/api/sessions", Some(DEVICE_ORIGIN), None)).await.0, StatusCode::UNAUTHORIZED);
    let (_, body) = call(&remote, get("/api/sessions", Some(DEVICE_ORIGIN), Some(&token))).await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["usageSnapshots"].as_array().unwrap().len(), 1);
    state.sessions.write().await.get_mut("shared").unwrap().snapshot["remoteEnabled"] = json!(false);
    // The current flag gates the response before the cache update is written.
    let (_, body) = call(&remote, get("/api/sessions", Some(DEVICE_ORIGIN), Some(&token))).await;
    assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["usageSnapshots"], json!([]));
    cache_session_usage(&state, "shared").await;
    assert!(state.usage.lock().await.snapshots(true).is_empty());
    fs::remove_dir_all(&state.data_dir).await.unwrap();
}

#[test]
fn usage_preserves_independent_account_and_session_timestamps_and_rejects_old_reports() {
    let mut store = usage::Store::default();
    assert!(store.capture("same", &report(123)));
    let mut next = report(200);
    next["telemetry"]["providers"][0]["updatedAt"] = json!("2026-10-07T10:05:00Z");
    next["telemetry"]["providers"][0]["weekly"] = json!({"usedPercent":18});
    next["telemetry"]["providers"][0]["sessionUpdatedAt"] = json!("2026-10-07T10:03:00Z");
    store.capture("same", &next);
    store.capture("same", &report(1));
    let saved = serde_json::to_value(store.snapshots(false)).unwrap();
    let provider = &saved[0]["telemetry"]["providers"][0];
    assert_eq!(provider["weekly"]["usedPercent"].as_f64(), Some(18.0));
    assert_eq!(provider["sessionTokens"].as_f64(), Some(200.0));
    assert_eq!(provider["sessionUpdatedAt"], "2026-10-07T10:03:00+00:00");
    // Native totals cannot erase an account report or be compared to a newer quota timestamp.
    next["telemetry"]["providers"][0]["weekly"] = Value::Null;
    next["telemetry"]["providers"][0]["fiveHour"] = Value::Null;
    next["telemetry"]["providers"][0]["sessionTokens"] = json!(300);
    next["telemetry"]["providers"][0]["sessionUpdatedAt"] = json!("2026-10-07T10:04:00Z");
    store.capture("same", &next);
    let saved = serde_json::to_value(store.snapshots(false)).unwrap();
    assert_eq!(saved[0]["telemetry"]["providers"][0]["weekly"]["usedPercent"].as_f64(), Some(18.0));
    assert_eq!(saved[0]["telemetry"]["providers"][0]["sessionTokens"].as_f64(), Some(300.0));
}

#[test]
fn usage_retention_is_bounded_and_malformed_reports_do_not_create_snapshots() {
    let mut store = usage::Store::default();
    assert!(!store.capture("invalid", &json!({"telemetry":{"providers":[{
        "provider":"codex","updatedAt":"bad","weekly":{"usedPercent":500}
    }]}})));
    for index in 0..502 { store.capture(&format!("session-{index:04}"), &report(index)); }
    assert_eq!(store.snapshots(false).len(), 500);
}
