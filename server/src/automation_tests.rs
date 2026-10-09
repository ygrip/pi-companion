use super::*;
fn definition() -> Value {
    json!({"name":"Example","enabled":true,"actions":[{"type":"command","command":"echo","args":["hello"]}],"schedule":null})
}
#[tokio::test]
async fn automation_crud_persists_and_remote_is_read_start_stop_only() {
    let state = test_state();
    let local = local_router(state.clone());
    let remote = remote_router(state.clone());
    assert_eq!(
        call(&remote, get("/api/automations", Some(DEVICE_ORIGIN), None))
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
    let (_, token) = pair(&state).await;
    let (status, text) = call(
        &local,
        post_json("/api/automations", Some(CONSOLE_ORIGIN), definition()),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let d: Value = serde_json::from_str(&text).unwrap();
    let id = d["id"].as_str().unwrap();
    assert_eq!(
        call(
            &remote,
            get("/api/automations", Some(DEVICE_ORIGIN), Some(&token))
        )
        .await
        .0,
        StatusCode::OK
    );
    let mutate = request(
        "POST",
        "/api/automations",
        Some(DEVICE_ORIGIN),
        Some(&token),
    )
    .header("content-type", "application/json")
    .body(Body::from(definition().to_string()))
    .unwrap();
    assert_eq!(
        call(&remote, mutate).await.0,
        StatusCode::METHOD_NOT_ALLOWED
    );
    let reloaded = AppState::new(
        config::Persisted::default(),
        scratch("tmp"),
        state.data_dir.clone(),
        None,
        vec![],
    );
    automation::initialize(&reloaded).await.unwrap();
    assert_eq!(
        call(
            &local_router(reloaded),
            get(
                &format!("/api/automations/{id}"),
                Some(CONSOLE_ORIGIN),
                None
            )
        )
        .await
        .0,
        StatusCode::OK
    );
    fs::remove_dir_all(&state.data_dir).await.unwrap();
}
#[tokio::test]
async fn automation_rejects_invalid_dsl() {
    let local = local_router(test_state());
    for d in [
        json!({"name":"","actions":[]}),
        json!({"name":"x","actions":[{"type":"command","command":"echo","args":[]}],"schedule":"not cron"}),
        json!({"name":"x","actions":[{"type":"command","command":"echo","cwd":"relative"}]}),
    ] {
        assert_eq!(
            call(
                &local,
                post_json("/api/automations", Some(CONSOLE_ORIGIN), d)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
    }
}
#[tokio::test]
async fn automation_session_allows_answers_only_and_rejects_upload() {
    let state = test_state();
    let (tx, mut rx) = mpsc::unbounded_channel();
    state.sessions.write().await.insert("automation".into(),Session{snapshot:json!({"id":"automation","readOnly":true,"remoteEnabled":true,"status":"active"}),command_tx:Some(tx)});
    for kind in ["prompt", "steer", "abort", "plan", "git_diff"] {
        forward_browser_command(
            &state,
            &json!({"sessionId":"automation","command":{"type":kind}}).to_string(),
            false,
        )
        .await;
        assert!(rx.try_recv().is_err());
    }
    forward_browser_command(&state,&json!({"sessionId":"automation","command":{"type":"ask_answer","requestId":"r","answers":{}}}).to_string(),false).await;
    assert_eq!(rx.recv().await.unwrap()["command"]["type"], "ask_answer");
    assert_eq!(
        call(
            &local_router(state),
            upload(
                "/api/sessions/automation/files",
                Some(CONSOLE_ORIGIN),
                None,
                "x.txt",
                "text/plain",
                b"x"
            )
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
}
#[tokio::test]
async fn auto_archive_is_age_gated_registry_only() {
    let state = test_state();
    for (id, status, at) in [
        ("old", "stopped", now_secs() - 8 * 86400),
        ("recent", "stopped", now_secs()),
        ("idle", "idle", now_secs() - 8 * 86400),
    ] {
        add_session(&state, id, true).await;
        let mut sessions = state.sessions.write().await;
        let s = sessions.get_mut(id).unwrap();
        s.snapshot["status"] = json!(status);
        s.snapshot["disconnectedAt"] = json!(at);
    }
    fs::create_dir_all(state.temp_root.join("old"))
        .await
        .unwrap();
    fs::write(state.temp_root.join("old/keep"), b"keep")
        .await
        .unwrap();
    auto_archive(&state).await;
    let sessions = state.sessions.read().await;
    assert!(!sessions.contains_key("old"));
    assert!(sessions.contains_key("recent"));
    assert!(sessions.contains_key("idle"));
    assert_eq!(
        fs::read(state.temp_root.join("old/keep")).await.unwrap(),
        b"keep"
    );
    drop(sessions);
    fs::remove_dir_all(&state.temp_root).await.unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn stopping_command_run_is_recorded() {
    let state = test_state();
    let local = local_router(state.clone());
    let d = json!({"name":"Sleep","enabled":true,"actions":[{"type":"command","command":"sleep","args":["30"]}]});
    let (_, text) = call(
        &local,
        post_json("/api/automations", Some(CONSOLE_ORIGIN), d),
    )
    .await;
    let d: Value = serde_json::from_str(&text).unwrap();
    let id = d["id"].as_str().unwrap();
    let (_, text) = call(
        &local,
        post_json(
            &format!("/api/automations/{id}/start"),
            Some(CONSOLE_ORIGIN),
            json!({}),
        ),
    )
    .await;
    let run: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        call(
            &local,
            post_json(
                &format!("/api/automations/{id}/start"),
                Some(CONSOLE_ORIGIN),
                json!({})
            )
        )
        .await
        .0,
        StatusCode::CONFLICT
    );
    assert_eq!(
        call(
            &local,
            post_json(
                &format!("/api/automations/{id}/stop"),
                Some(CONSOLE_ORIGIN),
                json!({})
            )
        )
        .await
        .0,
        StatusCode::NO_CONTENT
    );
    let path = format!("/api/automations/{id}/runs/{}", run["id"].as_str().unwrap());
    let status = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let (_, text) = call(&local, get(&path, Some(CONSOLE_ORIGIN), None)).await;
            let run: Value = serde_json::from_str(&text).unwrap();
            if run["status"] != "running" {
                break run["status"].clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(status, "stopped");
    fs::remove_dir_all(&state.data_dir).await.unwrap();
}
#[cfg(unix)]
#[tokio::test]
async fn command_run_finishes_with_output() {
    let state = test_state();
    let local = local_router(state.clone());
    let (status, text) = call(
        &local,
        post_json("/api/automations", Some(CONSOLE_ORIGIN), definition()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let d: Value = serde_json::from_str(&text).unwrap();
    let id = d["id"].as_str().unwrap();
    let (status, text) = call(
        &local,
        post_json(
            &format!("/api/automations/{id}/start"),
            Some(CONSOLE_ORIGIN),
            json!({}),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let run: Value = serde_json::from_str(&text).unwrap();
    let path = format!("/api/automations/{id}/runs/{}", run["id"].as_str().unwrap());
    let final_run = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let (_, text) = call(&local, get(&path, Some(CONSOLE_ORIGIN), None)).await;
            let r: Value = serde_json::from_str(&text).unwrap();
            if r["status"] != "running" {
                break r;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(final_run["status"], "succeeded");
    assert!(final_run["result"].as_str().unwrap().contains("hello"));
    fs::remove_dir_all(&state.data_dir).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn disabled_manual_run_skips_failed_precondition_but_finalizes() {
    let state = test_state();
    let local = local_router(state.clone());
    let remote = remote_router(state.clone());
    let (_, token) = pair(&state).await;
    let d = json!({"name":"Finalize", "enabled":false,"schedule":"* * * * *","preconditions":[{"type":"command","command":"false","args":[]}],"actions":[{"type":"command","command":"echo","args":["MUST_NOT_RUN"]}],"postActions":[{"type":"command","command":"echo","args":["CLEANUP_RAN"]}]});
    let (_, text) = call(
        &local,
        post_json("/api/automations", Some(CONSOLE_ORIGIN), d),
    )
    .await;
    let d: Value = serde_json::from_str(&text).unwrap();
    let id = d["id"].as_str().unwrap();
    automation::tick(&state).await;
    let (_, history) = call(
        &local,
        get(
            &format!("/api/automations/{id}/runs"),
            Some(CONSOLE_ORIGIN),
            None,
        ),
    )
    .await;
    assert_eq!(
        serde_json::from_str::<Value>(&history).unwrap()["runs"]
            .as_array()
            .unwrap()
            .len(),
        0
    );
    let req = request(
        "POST",
        &format!("/api/automations/{id}/start"),
        Some(DEVICE_ORIGIN),
        Some(&token),
    )
    .body(Body::empty())
    .unwrap();
    let (status, text) = call(&remote, req).await;
    assert_eq!(status, StatusCode::OK, "{text}");
    let run: Value = serde_json::from_str(&text).unwrap();
    let path = format!("/api/automations/{id}/runs/{}", run["id"].as_str().unwrap());
    let run = tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let (_, text) = call(&local, get(&path, Some(CONSOLE_ORIGIN), None)).await;
            let run: Value = serde_json::from_str(&text).unwrap();
            if run["status"] != "running" {
                break run;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(run["status"], "skipped");
    let result = run["result"].as_str().unwrap();
    assert!(result.contains("CLEANUP_RAN"));
    assert!(!result.contains("MUST_NOT_RUN"));
    let req = request(
        "DELETE",
        &format!("/api/automations/{id}"),
        Some(CONSOLE_ORIGIN),
        None,
    )
    .body(Body::empty())
    .unwrap();
    assert_eq!(call(&local, req).await.0, StatusCode::NO_CONTENT);
    assert_eq!(
        call(&local, get(&path, Some(CONSOLE_ORIGIN), None)).await.0,
        StatusCode::NOT_FOUND
    );
    fs::remove_dir_all(&state.data_dir).await.unwrap();
}

#[cfg(unix)]
#[tokio::test]
async fn scheduler_deduplicates_and_restart_marks_unfinished_runs_failed() {
    let state = test_state();
    let local = local_router(state.clone());
    let d = json!({"name":"Scheduled", "enabled":true,"schedule":"* * * * *","actions":[{"type":"command","command":"sleep","args":["30"]}]});
    let (_, text) = call(
        &local,
        post_json("/api/automations", Some(CONSOLE_ORIGIN), d),
    )
    .await;
    let d: Value = serde_json::from_str(&text).unwrap();
    let id = d["id"].as_str().unwrap();
    automation::tick(&state).await;
    automation::tick(&state).await;
    let (_, text) = call(
        &local,
        get(
            &format!("/api/automations/{id}/runs"),
            Some(CONSOLE_ORIGIN),
            None,
        ),
    )
    .await;
    let history: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(history["runs"].as_array().unwrap().len(), 1);
    let reloaded = AppState::new(
        config::Persisted::default(),
        scratch("tmp"),
        state.data_dir.clone(),
        None,
        vec![],
    );
    automation::initialize(&reloaded).await.unwrap();
    let (_, text) = call(
        &local_router(reloaded),
        get(
            &format!("/api/automations/{id}/runs"),
            Some(CONSOLE_ORIGIN),
            None,
        ),
    )
    .await;
    let history: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(history["runs"][0]["status"], "failed");
    assert!(
        history["runs"][0]["result"]
            .as_str()
            .unwrap()
            .contains("restarted")
    );
    automation::cancel_all(&state).await;
    fs::remove_dir_all(&state.data_dir).await.unwrap();
}
