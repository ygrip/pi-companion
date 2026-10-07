use super::*;

fn remove(id: &str, origin: Option<&str>, token: Option<&str>) -> HttpRequest<Body> {
    request("DELETE", &format!("/api/sessions/{id}"), origin, token).body(Body::empty()).unwrap()
}

#[tokio::test]
async fn archive_rejects_live_and_unknown_statuses_even_without_a_channel() {
    let state = test_state();
    let local = local_router(state.clone());
    for status in ["active", "idle", "waiting", "unknown"] {
        add_session(&state, "session", true).await;
        state.sessions.write().await.get_mut("session").unwrap().snapshot["status"] = json!(status);
        assert_eq!(call(&local, remove("session", Some(CONSOLE_ORIGIN), None)).await.0, StatusCode::CONFLICT);
        assert!(state.sessions.read().await.contains_key("session"));
    }
}

#[tokio::test]
async fn archive_requires_credential_origin_and_remote_sharing() {
    let state = test_state();
    let (_, token) = pair(&state).await;
    let remote = remote_router(state.clone());
    add_session(&state, "session", false).await;
    state.sessions.write().await.get_mut("session").unwrap().snapshot["status"] = json!("stopped");
    assert_eq!(call(&remote, remove("session", Some(DEVICE_ORIGIN), None)).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(call(&remote, remove("session", Some(DEVICE_ORIGIN), Some("invalid"))).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(call(&remote, remove("session", Some(EVIL_ORIGIN), Some(&token))).await.0, StatusCode::FORBIDDEN);
    assert_eq!(call(&remote, remove("session", Some(DEVICE_ORIGIN), Some(&token))).await.0, StatusCode::FORBIDDEN);
    state.sessions.write().await.get_mut("session").unwrap().snapshot["remoteEnabled"] = json!(true);
    let mut events = state.browser_tx.subscribe();
    assert_eq!(call(&remote, remove("session", Some(DEVICE_ORIGIN), Some(&token))).await.0, StatusCode::NO_CONTENT);
    let event = events.recv().await.unwrap();
    assert_eq!(event["type"], "session.removed");
    assert!(visible_to_device(&state, &event).await);
    assert_eq!(call(&remote, remove("session", Some(DEVICE_ORIGIN), Some(&token))).await.0, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn archive_only_removes_daemon_record_not_files() {
    let state = test_state();
    add_session(&state, "session", false).await;
    state.sessions.write().await.get_mut("session").unwrap().snapshot["status"] = json!("stopped");
    let dir = state.temp_root.join("session");
    fs::create_dir_all(&dir).await.unwrap();
    fs::write(dir.join("keep.txt"), b"untouched").await.unwrap();
    assert_eq!(delete_session(&state, "session", false).await.unwrap(), StatusCode::NO_CONTENT);
    assert_eq!(fs::read(dir.join("keep.txt")).await.unwrap(), b"untouched");
    fs::remove_dir_all(&state.temp_root).await.unwrap();
}

#[tokio::test]
async fn connected_stopped_and_reconnected_sessions_cannot_be_archived() {
    let state = test_state();
    let addr = serve(local_router(state.clone())).await;
    let mut old = bridge(addr, "session", true).await;
    state.sessions.write().await.get_mut("session").unwrap().snapshot["status"] = json!("stopped");
    assert_eq!(delete_session(&state, "session", false).await.unwrap_err().0, StatusCode::CONFLICT);
    let mut replacement = bridge(addr, "session", true).await;
    old.close(None).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let sessions = state.sessions.read().await;
    assert!(sessions["session"].command_tx.is_some());
    assert_eq!(sessions["session"].snapshot["status"], "idle");
    drop(sessions);
    assert_eq!(delete_session(&state, "session", false).await.unwrap_err().0, StatusCode::CONFLICT);
    replacement.close(None).await.unwrap();
}

#[tokio::test]
async fn retired_bridge_cannot_stop_or_hide_its_replacement() {
    let state = test_state();
    let addr = serve(local_router(state.clone())).await;
    let mut old = bridge(addr, "session", true).await;
    let mut replacement = bridge(addr, "session", true).await;
    send_json(&mut old, json!({"type":"session.update","session":{"remoteEnabled":false,"status":"stopped"}})).await;
    // The retired channel is dropped once its stale update has been processed.
    assert!(tokio::time::timeout(Duration::from_secs(2), old.next()).await.is_ok());
    let sessions = state.sessions.read().await;
    assert_eq!(sessions["session"].snapshot["remoteEnabled"], true);
    assert_eq!(sessions["session"].snapshot["status"], "idle");
    assert!(sessions["session"].command_tx.is_some());
    drop(sessions);
    assert_eq!(delete_session(&state, "session", false).await.unwrap_err().0, StatusCode::CONFLICT);
    replacement.close(None).await.unwrap();
}
