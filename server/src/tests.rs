//! Daemon tests: wire protocol, pairing, origin policy, reconnects, upload sandbox and
//! isolation between sessions. HTTP goes through the routers directly; WebSocket flows run
//! against real listeners on ephemeral ports.

use std::{net::SocketAddr, time::Duration};

use axum::{body::Body, http::Request as HttpRequest};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::json;
use tokio::net::TcpStream;
use tokio_tungstenite::{
    MaybeTlsStream, WebSocketStream, connect_async,
    tungstenite::{self, Message as WsMessage, client::IntoClientRequest},
};
use tower::ServiceExt;

use super::*;

#[path = "archive_tests.rs"]
mod archive_tests;

const CONSOLE_ORIGIN: &str = "http://127.0.0.1:43721";
const DEVICE_ORIGIN: &str = "http://127.0.0.1:43722";
const EVIL_ORIGIN: &str = "https://evil.example";

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

fn scratch(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("pi-companion-test-{label}-{}", Uuid::new_v4().simple()))
}

fn test_state() -> AppState {
    AppState::new(config::Persisted::default(), scratch("tmp"), scratch("data"), None, Vec::new())
}

async fn call(router: &Router, request: HttpRequest<Body>) -> (StatusCode, String) {
    let response = router.clone().oneshot(request).await.expect("router call");
    let status = response.status();
    let bytes = response.into_body().collect().await.expect("body").to_bytes();
    (status, String::from_utf8_lossy(&bytes).into_owned())
}

fn request(method: &str, path: &str, origin: Option<&str>, token: Option<&str>) -> axum::http::request::Builder {
    let mut builder = HttpRequest::builder().method(method).uri(path);
    if let Some(origin) = origin {
        builder = builder.header("origin", origin);
    }
    if let Some(token) = token {
        builder = builder.header("authorization", format!("Bearer {token}"));
    }
    builder
}

fn get(path: &str, origin: Option<&str>, token: Option<&str>) -> HttpRequest<Body> {
    request("GET", path, origin, token).body(Body::empty()).unwrap()
}

fn post_json(path: &str, origin: Option<&str>, body: Value) -> HttpRequest<Body> {
    request("POST", path, origin, None)
        .header("content-type", "application/json")
        .header("user-agent", "TestPhone/1.0")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn upload(path: &str, origin: Option<&str>, token: Option<&str>, file_name: &str, content_type: &str, data: &[u8]) -> HttpRequest<Body> {
    let boundary = "pi-companion-test-boundary";
    let mut body = format!(
        "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{file_name}\"\r\nContent-Type: {content_type}\r\n\r\n"
    )
    .into_bytes();
    body.extend_from_slice(data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    request("POST", path, origin, token)
        .header("content-type", format!("multipart/form-data; boundary={boundary}"))
        .body(Body::from(body))
        .unwrap()
}

#[tokio::test]
async fn context_exposes_current_upload_policy_without_private_settings() {
    let state = test_state();
    {
        let mut settings = state.settings.write().await;
        settings.max_upload_mb = 7;
        settings.allowed_upload_types = vec!["image/*".into(), "application/pdf".into()];
    }
    for (router, origin, remote) in [
        (local_router(state.clone()), CONSOLE_ORIGIN, false),
        (remote_router(state.clone()), DEVICE_ORIGIN, true),
    ] {
        let (status, text) = call(&router, get("/api/context", Some(origin), None)).await;
        assert_eq!(status, StatusCode::OK);
        let context: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(context["remote"], remote);
        assert_eq!(context["uploadPolicy"]["maxUploadMb"], 7);
        assert_eq!(context["uploadPolicy"]["allowedUploadTypes"], json!(["image/*", "application/pdf"]));
        assert!(context.get("devices").is_none());
        assert!(context.get("settings").is_none());
        assert!(context.get("dataDir").is_none());
    }
}

async fn add_session(state: &AppState, id: &str, remote: bool) {
    state.sessions.write().await.insert(
        id.to_string(),
        Session { snapshot: json!({ "id": id, "remoteEnabled": remote, "status": "idle" }), command_tx: None },
    );
}

async fn serve(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    addr
}

async fn ws_connect(addr: SocketAddr, path: &str, origin: Option<&str>, protocols: Option<&str>) -> Result<Ws, tungstenite::Error> {
    let mut request = format!("ws://{addr}{path}").into_client_request().unwrap();
    if let Some(origin) = origin {
        request.headers_mut().insert("origin", origin.parse().unwrap());
    }
    if let Some(protocols) = protocols {
        request.headers_mut().insert("sec-websocket-protocol", protocols.parse().unwrap());
    }
    connect_async(request).await.map(|(ws, _)| ws)
}

fn rejected_with(result: Result<Ws, tungstenite::Error>, status: StatusCode) {
    match result {
        Err(tungstenite::Error::Http(response)) => assert_eq!(response.status().as_u16(), status.as_u16()),
        Err(other) => panic!("expected HTTP {status}, got {other}"),
        Ok(_) => panic!("expected HTTP {status}, but the upgrade succeeded"),
    }
}

/// Next JSON text frame matching `wanted`, skipping others; panics after two seconds.
async fn next_matching(ws: &mut Ws, wanted: impl Fn(&Value) -> bool) -> Value {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match ws.next().await.expect("socket ended").expect("socket error") {
                WsMessage::Text(text) => {
                    let value: Value = serde_json::from_str(&text).unwrap();
                    if wanted(&value) {
                        return value;
                    }
                }
                _ => continue,
            }
        }
    })
    .await
    .expect("timed out waiting for a frame")
}

/// Asserts that no frame matching `unwanted` arrives within `ms`.
async fn assert_no_frame(ws: &mut Ws, ms: u64, unwanted: impl Fn(&Value) -> bool) {
    let _ = tokio::time::timeout(Duration::from_millis(ms), async {
        while let Some(Ok(message)) = ws.next().await {
            if let WsMessage::Text(text) = message {
                let value: Value = serde_json::from_str(&text).unwrap();
                assert!(!unwanted(&value), "unexpected frame: {value}");
            }
        }
    })
    .await;
}

async fn close_code(ws: &mut Ws) -> u16 {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match ws.next().await {
                Some(Ok(WsMessage::Close(Some(frame)))) => return u16::from(frame.code),
                Some(Ok(_)) => continue,
                other => panic!("expected a close frame, got {other:?}"),
            }
        }
    })
    .await
    .expect("timed out waiting for close")
}

async fn send_json(ws: &mut Ws, value: Value) {
    ws.send(WsMessage::Text(value.to_string().into())).await.unwrap();
}

/// A Pi bridge that registered `id`; returns once the daemon acknowledged with temp.files.
async fn bridge(addr: SocketAddr, id: &str, remote: bool) -> Ws {
    let mut ws = ws_connect(addr, &format!("/ws/bridge/{id}"), None, None).await.unwrap();
    send_json(&mut ws, json!({ "type": "register", "session": { "id": id, "remoteEnabled": remote, "status": "idle" } })).await;
    next_matching(&mut ws, |v| v["type"] == "temp.files").await;
    ws
}

async fn start_pairing_via(local: &Router) -> Value {
    let (status, body) = call(local, request("POST", "/api/pairing/start", Some(CONSOLE_ORIGIN), None).body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    serde_json::from_str(&body).unwrap()
}

fn invite_of(pairing: &Value) -> String {
    pairing["url"].as_str().unwrap().split("invite=").nth(1).unwrap().to_string()
}

/// Pair a device through the public API; returns (device id, token).
async fn pair(state: &AppState) -> (String, String) {
    let local = local_router(state.clone());
    let remote = remote_router(state.clone());
    let invite = invite_of(&start_pairing_via(&local).await);
    let (status, body) = call(&remote, post_json("/api/pairing/claim", Some(DEVICE_ORIGIN), json!({ "invite": invite, "deviceName": "Phone" }))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let claim: Value = serde_json::from_str(&body).unwrap();
    (claim["deviceId"].as_str().unwrap().to_string(), claim["token"].as_str().unwrap().to_string())
}

async fn wait_connected(state: &AppState, device_id: &str, connected: bool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while state.device_connections.read().await.contains_key(device_id) != connected {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("device connection state did not settle");
}

// ---------------------------------------------------------------- protocol

#[tokio::test]
async fn protocol_relays_registration_updates_and_commands() {
    let state = test_state();
    let addr = serve(local_router(state.clone())).await;
    let mut browser = ws_connect(addr, "/ws/browser", Some(CONSOLE_ORIGIN), None).await.unwrap();
    let mut pi = bridge(addr, "s1", false).await;

    let registered = next_matching(&mut browser, |v| v["type"] == "session.register").await;
    assert_eq!(registered["session"]["id"], "s1");

    send_json(&mut pi, json!({ "type": "session.update", "session": { "status": "active", "asks": [{ "requestId": "r1" }] } })).await;
    let update = next_matching(&mut browser, |v| v["type"] == "session.update").await;
    assert_eq!(update["sessionId"], "s1");
    assert_eq!(update["patch"]["status"], "active");
    let snapshot = state.sessions.read().await.get("s1").unwrap().snapshot.clone();
    assert_eq!(snapshot["status"], "active", "patches merge into the stored snapshot");
    assert_eq!(snapshot["asks"][0]["requestId"], "r1", "late joiners see pending questions");

    send_json(&mut browser, json!({ "sessionId": "s1", "command": { "type": "ask_answer", "requestId": "r1", "answers": { "q1": ["Yes"] } } })).await;
    let command = next_matching(&mut pi, |v| v["type"] == "command").await;
    assert_eq!(command["command"]["type"], "ask_answer");
    assert_eq!(command["command"]["answers"]["q1"][0], "Yes");
    let echoed = next_matching(&mut browser, |v| v["type"] == "bridge.event").await;
    assert_eq!(echoed["message"]["event"], "user.message", "answers show up in every companion's feed");
    assert_eq!(echoed["message"]["payload"]["text"], "Yes");

    send_json(&mut pi, json!({ "type": "event", "event": "tool.start", "payload": { "toolName": "bash" } })).await;
    let event = next_matching(&mut browser, |v| v["type"] == "bridge.event").await;
    assert_eq!(event["sessionId"], "s1");
    assert_eq!(event["message"]["payload"]["toolName"], "bash");
    assert_eq!(event["message"]["seq"], 2, "feed messages carry a replay sequence");
}

#[tokio::test]
async fn protocol_ignores_malformed_browser_frames() {
    let state = test_state();
    let addr = serve(local_router(state.clone())).await;
    let mut pi = bridge(addr, "s1", false).await;
    let mut browser = ws_connect(addr, "/ws/browser", Some(CONSOLE_ORIGIN), None).await.unwrap();
    browser.send(WsMessage::Text("not json".into())).await.unwrap();
    send_json(&mut browser, json!({ "sessionId": "missing", "command": { "type": "abort" } })).await;
    send_json(&mut browser, json!({ "sessionId": "s1", "command": { "type": "abort" } })).await;
    let command = next_matching(&mut pi, |v| v["type"] == "command").await;
    assert_eq!(command["command"]["type"], "abort", "the socket survives bad frames");
}

// ---------------------------------------------------------------- origin policy

#[tokio::test]
async fn console_refuses_foreign_origins() {
    let state = test_state();
    let local = local_router(state.clone());
    assert_eq!(call(&local, get("/api/sessions", None, None)).await.0, StatusCode::OK);
    assert_eq!(call(&local, get("/api/sessions", Some(CONSOLE_ORIGIN), None)).await.0, StatusCode::OK);
    assert_eq!(call(&local, get("/api/sessions", Some("http://localhost:43721"), None)).await.0, StatusCode::OK);
    assert_eq!(call(&local, get("/api/sessions", Some(EVIL_ORIGIN), None)).await.0, StatusCode::FORBIDDEN);
    assert_eq!(call(&local, get("/api/sessions", Some("null"), None)).await.0, StatusCode::FORBIDDEN);

    let addr = serve(local).await;
    rejected_with(ws_connect(addr, "/ws/browser", Some(EVIL_ORIGIN), None).await, StatusCode::FORBIDDEN);
    assert!(ws_connect(addr, "/ws/browser", Some(CONSOLE_ORIGIN), None).await.is_ok());
}

#[tokio::test]
async fn device_surface_requires_allowed_origin() {
    let state = test_state();
    let (_, token) = pair(&state).await;
    let remote = remote_router(state.clone());
    let claim = json!({ "invite": "nope", "deviceName": "Phone" });

    // State-changing requests need an allowed Origin; a foreign one is refused before auth.
    assert_eq!(call(&remote, post_json("/api/pairing/claim", None, claim.clone())).await.0, StatusCode::FORBIDDEN);
    assert_eq!(call(&remote, post_json("/api/pairing/claim", Some(EVIL_ORIGIN), claim.clone())).await.0, StatusCode::FORBIDDEN);
    assert_eq!(call(&remote, post_json("/api/pairing/claim", Some(DEVICE_ORIGIN), claim.clone())).await.0, StatusCode::UNAUTHORIZED);
    // Plain GETs may omit Origin, never carry a foreign one.
    assert_eq!(call(&remote, get("/api/sessions", None, Some(&token))).await.0, StatusCode::OK);
    assert_eq!(call(&remote, get("/api/sessions", Some(EVIL_ORIGIN), Some(&token))).await.0, StatusCode::FORBIDDEN);

    // The configured public address is an allowed origin.
    state.settings.write().await.public_url = "https://companion.example.com".into();
    assert_eq!(call(&remote, post_json("/api/pairing/claim", Some("https://companion.example.com"), claim)).await.0, StatusCode::UNAUTHORIZED);

    let addr = serve(remote).await;
    let protocols = format!("pi-companion, token.{token}");
    rejected_with(ws_connect(addr, "/ws/browser", None, Some(&protocols)).await, StatusCode::FORBIDDEN);
    rejected_with(ws_connect(addr, "/ws/browser", Some(EVIL_ORIGIN), Some(&protocols)).await, StatusCode::FORBIDDEN);
    assert!(ws_connect(addr, "/ws/browser", Some(DEVICE_ORIGIN), Some(&protocols)).await.is_ok());
}

#[test]
fn origins_are_normalized() {
    assert_eq!(origin_of("https://Example.com:443/path?q").as_deref(), Some("https://example.com"));
    assert_eq!(origin_of("http://example.com:80").as_deref(), Some("http://example.com"));
    assert_eq!(origin_of("http://127.0.0.1:43722").as_deref(), Some("http://127.0.0.1:43722"));
    assert_eq!(origin_of("http://user@evil.example"), None);
    assert_eq!(origin_of("null"), None);
    assert_eq!(origin_of("file:///etc"), None);
}

// ---------------------------------------------------------------- pairing

#[tokio::test]
async fn pairing_invites_expire_and_work_once() {
    let state = test_state();
    let local = local_router(state.clone());
    let remote = remote_router(state.clone());

    let invite = invite_of(&start_pairing_via(&local).await);
    for pairing in state.pairings.write().await.values_mut() {
        pairing.expires_at = now_secs() - 1;
    }
    let (status, body) = call(&remote, post_json("/api/pairing/claim", Some(DEVICE_ORIGIN), json!({ "invite": invite, "deviceName": "Phone" }))).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert!(body.contains("expired"), "{body}");
    assert!(state.devices.read().await.is_empty());

    let invite = invite_of(&start_pairing_via(&local).await);
    let claim = json!({ "invite": invite, "deviceName": "Phone" });
    assert_eq!(call(&remote, post_json("/api/pairing/claim", Some(DEVICE_ORIGIN), claim.clone())).await.0, StatusCode::OK);
    assert_eq!(call(&remote, post_json("/api/pairing/claim", Some(DEVICE_ORIGIN), claim)).await.0, StatusCode::UNAUTHORIZED, "single use");
}

#[tokio::test]
async fn pairing_rejects_bad_names_without_burning_the_invite() {
    let state = test_state();
    let local = local_router(state.clone());
    let remote = remote_router(state.clone());
    let invite = invite_of(&start_pairing_via(&local).await);
    let bad = json!({ "invite": invite, "deviceName": "  " });
    assert_eq!(call(&remote, post_json("/api/pairing/claim", Some(DEVICE_ORIGIN), bad)).await.0, StatusCode::BAD_REQUEST);
    let good = json!({ "invite": invite, "deviceName": "Phone" });
    assert_eq!(call(&remote, post_json("/api/pairing/claim", Some(DEVICE_ORIGIN), good)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn pairing_by_code_persists_only_a_hash_in_a_private_file() {
    let state = test_state();
    let local = local_router(state.clone());
    let remote = remote_router(state.clone());
    let pairing = start_pairing_via(&local).await;
    let typed = pairing["code"].as_str().unwrap().replace('-', " ").to_lowercase();

    let (status, body) = call(&remote, post_json("/api/pairing/claim", Some(DEVICE_ORIGIN), json!({ "code": typed, "deviceName": "Phone" }))).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let claim: Value = serde_json::from_str(&body).unwrap();
    let token = claim["token"].as_str().unwrap();

    let path = config::state_file(&state.data_dir);
    let saved = std::fs::read_to_string(&path).unwrap();
    assert!(!saved.contains(token), "the credential itself is never written");
    assert!(saved.contains(&hash_token(token)));
    assert!(saved.contains("TestPhone/1.0"), "device metadata is persisted");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&state.data_dir).unwrap().permissions().mode() & 0o777, 0o700);
    }

    let reloaded = config::load(&state.data_dir).await;
    assert_eq!(reloaded.devices.len(), 1);
    assert_eq!(reloaded.devices[0].token_hash, hash_token(token));
    assert_eq!(reloaded.devices[0].user_agent, "TestPhone/1.0");
}

#[cfg(unix)]
#[tokio::test]
async fn loading_tightens_a_loose_state_file() {
    use std::os::unix::fs::PermissionsExt;
    let dir = scratch("loose");
    config::save(&dir, &config::Persisted::default()).await.unwrap();
    let path = config::state_file(&dir);
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
    config::load(&dir).await;
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
}

#[tokio::test]
async fn wrong_codes_are_throttled_and_withdraw_open_invites() {
    let state = test_state();
    let local = local_router(state.clone());
    let remote = remote_router(state.clone());
    let invite = invite_of(&start_pairing_via(&local).await);
    let wrong = json!({ "code": "ZZZZ-ZZZZ", "deviceName": "Phone" });
    for _ in 0..CODE_FAILURE_LIMIT {
        assert_eq!(call(&remote, post_json("/api/pairing/claim", Some(DEVICE_ORIGIN), wrong.clone())).await.0, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(call(&remote, post_json("/api/pairing/claim", Some(DEVICE_ORIGIN), wrong)).await.0, StatusCode::TOO_MANY_REQUESTS);
    let claim = json!({ "invite": invite, "deviceName": "Phone" });
    assert_eq!(call(&remote, post_json("/api/pairing/claim", Some(DEVICE_ORIGIN), claim)).await.0, StatusCode::UNAUTHORIZED, "open invites were withdrawn");
    let both = json!({ "invite": "x", "code": "y", "deviceName": "Phone" });
    assert_eq!(call(&remote, post_json("/api/pairing/claim", Some(DEVICE_ORIGIN), both)).await.0, StatusCode::BAD_REQUEST);
}

// ---------------------------------------------------------------- reconnect

#[tokio::test]
async fn bridge_reconnect_keeps_the_session_and_its_files() {
    let state = test_state();
    let local = local_router(state.clone());
    let addr = serve(local.clone()).await;
    let mut browser = ws_connect(addr, "/ws/browser", Some(CONSOLE_ORIGIN), None).await.unwrap();
    let mut pi = bridge(addr, "s1", false).await;
    let (status, _) = call(&local, upload("/api/sessions/s1/files", Some(CONSOLE_ORIGIN), None, "notes.txt", "text/plain", b"hello")).await;
    assert_eq!(status, StatusCode::OK);

    pi.close(None).await.unwrap();
    let stopped = next_matching(&mut browser, |v| v["type"] == "session.update" && v["patch"]["status"] == "stopped").await;
    assert_eq!(stopped["sessionId"], "s1");

    let mut pi = ws_connect(addr, "/ws/bridge/s1", None, None).await.unwrap();
    send_json(&mut pi, json!({ "type": "register", "session": { "id": "s1", "remoteEnabled": false, "status": "idle" } })).await;
    let files = next_matching(&mut pi, |v| v["type"] == "temp.files").await;
    assert_eq!(files["files"].as_array().unwrap().len(), 1, "uploads survive a bridge reconnect");
    next_matching(&mut browser, |v| v["type"] == "session.register").await;

    send_json(&mut browser, json!({ "sessionId": "s1", "command": { "type": "prompt", "text": "again" } })).await;
    let command = next_matching(&mut pi, |v| v["type"] == "command").await;
    assert_eq!(command["command"]["text"], "again", "commands reach the new bridge socket");
}

#[tokio::test]
async fn superseded_bridge_cannot_stop_or_overwrite_the_working_session() {
    let state = test_state();
    let addr = serve(local_router(state.clone())).await;
    let mut browser = ws_connect(addr, "/ws/browser", Some(CONSOLE_ORIGIN), None).await.unwrap();
    let mut old = bridge(addr, "s1", true).await;
    let mut current = bridge(addr, "s1", true).await;
    send_json(&mut old, json!({ "type": "session.update", "session": { "status": "stopped", "remoteEnabled": false } })).await;
    old.close(None).await.unwrap();
    assert_no_frame(&mut browser, 100, |v| v["type"] == "session.update" && v["patch"]["status"] == "stopped").await;
    let sessions = state.sessions.read().await;
    assert_eq!(sessions["s1"].snapshot["status"], "idle");
    assert_eq!(sessions["s1"].snapshot["remoteEnabled"], true);
    drop(sessions);
    send_json(&mut browser, json!({ "sessionId": "s1", "command": { "type": "prompt", "text": "current only" } })).await;
    let command = next_matching(&mut current, |v| v["type"] == "command").await;
    assert_eq!(command["command"]["text"], "current only");
}

#[tokio::test]
async fn heartbeat_control_frames_do_not_end_a_bridge_session() {
    let state = test_state();
    let addr = serve(local_router(state.clone())).await;
    let mut browser = ws_connect(addr, "/ws/browser", Some(CONSOLE_ORIGIN), None).await.unwrap();
    next_matching(&mut browser, |v| v["type"] == "resync").await;
    next_matching(&mut browser, |v| v["type"] == "ping").await;
    let mut pi = bridge(addr, "s1", true).await;
    pi.send(WsMessage::Pong(Vec::new().into())).await.unwrap();
    send_json(&mut pi, json!({ "type": "session.update", "session": { "status": "active" } })).await;
    next_matching(&mut browser, |v| v["type"] == "session.update" && v["patch"]["status"] == "active").await;
    send_json(&mut browser, json!({ "sessionId": "s1", "command": { "type": "prompt", "text": "still working" } })).await;
    let command = next_matching(&mut pi, |v| v["type"] == "command").await;
    assert_eq!(command["command"]["text"], "still working");
}

#[tokio::test]
async fn paired_device_recovers_working_session_and_questions_after_daemon_restart() {
    let state = test_state();
    let (_, token) = pair(&state).await;
    let persisted = config::load(&state.data_dir).await;
    let restarted = AppState::new(persisted, scratch("restart-tmp"), state.data_dir.clone(), None, Vec::new());
    let local_addr = serve(local_router(restarted.clone())).await;
    let remote = remote_router(restarted.clone());
    let device_addr = serve(remote.clone()).await;
    let mut pi = bridge(local_addr, "working", true).await;
    send_json(&mut pi, json!({ "type": "session.update", "session": { "status": "active", "asks": [{ "requestId": "pending", "questions": [] }] } })).await;
    // This phone keeps the same credential across daemon restart, never re-pairs.
    let protocols = format!("pi-companion, token.{token}");
    let mut phone = ws_connect(device_addr, "/ws/browser", Some(DEVICE_ORIGIN), Some(&protocols)).await.unwrap();
    next_matching(&mut phone, |v| v["type"] == "resync").await;
    let (status, body) = call(&remote, get("/api/sessions", Some(DEVICE_ORIGIN), Some(&token))).await;
    assert_eq!(status, StatusCode::OK);
    let sessions: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(sessions["sessions"][0]["status"], "active");
    assert_eq!(sessions["sessions"][0]["asks"][0]["requestId"], "pending");
    send_json(&mut phone, json!({ "sessionId": "working", "command": { "type": "ask_answer", "requestId": "pending", "answers": {} } })).await;
    let command = next_matching(&mut pi, |v| v["type"] == "command").await;
    assert_eq!(command["command"]["requestId"], "pending");
}

#[tokio::test]
async fn device_reconnects_after_disconnect_but_not_after_revoke() {
    let state = test_state();
    let (device_id, token) = pair(&state).await;
    let local = local_router(state.clone());
    let addr = serve(remote_router(state.clone())).await;
    let protocols = format!("pi-companion, token.{token}");

    let mut device = ws_connect(addr, "/ws/browser", Some(DEVICE_ORIGIN), Some(&protocols)).await.unwrap();
    wait_connected(&state, &device_id, true).await;
    let disconnect = request("POST", &format!("/api/devices/{device_id}/disconnect"), Some(CONSOLE_ORIGIN), None).body(Body::empty()).unwrap();
    assert_eq!(call(&local, disconnect).await.0, StatusCode::NO_CONTENT);
    assert_eq!(close_code(&mut device).await, CLOSE_DISCONNECTED);
    wait_connected(&state, &device_id, false).await;

    let mut device = ws_connect(addr, "/ws/browser", Some(DEVICE_ORIGIN), Some(&protocols)).await.expect("same credential reconnects");
    wait_connected(&state, &device_id, true).await;
    let revoke = request("DELETE", &format!("/api/devices/{device_id}"), Some(CONSOLE_ORIGIN), None).body(Body::empty()).unwrap();
    assert_eq!(call(&local, revoke).await.0, StatusCode::NO_CONTENT);
    assert_eq!(close_code(&mut device).await, CLOSE_REVOKED);
    rejected_with(ws_connect(addr, "/ws/browser", Some(DEVICE_ORIGIN), Some(&protocols)).await, StatusCode::UNAUTHORIZED);
}

// ---------------------------------------------------------------- upload sandbox

#[tokio::test]
async fn uploads_cannot_escape_the_session_folder() {
    let state = test_state();
    add_session(&state, "s1", false).await;
    let local = local_router(state.clone());
    let session_dir = state.temp_root.join("s1");

    for hostile in ["../../escape.txt", "..\\..\\escape.txt", "/etc/escape.txt", ".escape.txt"] {
        let (status, body) = call(&local, upload("/api/sessions/s1/files", None, None, hostile, "text/plain", b"x")).await;
        assert_eq!(status, StatusCode::OK, "{hostile}: {body}");
        let file: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(file["name"], "escape.txt", "{hostile}");
        let path = PathBuf::from(file["path"].as_str().unwrap());
        assert_eq!(path.parent().unwrap(), session_dir, "{hostile}");
    }

    for path in ["/api/sessions/..%2F..%2Fetc/files", "/api/sessions/s1%2F..%2Fx/files"] {
        let (status, _) = call(&local, upload(path, None, None, "a.txt", "text/plain", b"x")).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
    }
    let delete = request("DELETE", "/api/sessions/..%2Fs1/files/x", None, None).body(Body::empty()).unwrap();
    assert_eq!(call(&local, delete).await.0, StatusCode::BAD_REQUEST);

    let addr = serve(local).await;
    rejected_with(ws_connect(addr, "/ws/bridge/..%2F..%2Ftmp", None, None).await, StatusCode::BAD_REQUEST);
}

#[test]
fn file_names_are_reduced_to_a_safe_last_component() {
    assert_eq!(safe_file_name("../../a.txt"), "a.txt");
    assert_eq!(safe_file_name("C:\\Users\\x\\b.png"), "b.png");
    assert_eq!(safe_file_name("..."), "upload.bin");
    assert_eq!(safe_file_name("bad\u{0}name\n.txt"), "badname.txt");
    assert!(safe_file_name(&"a".repeat(500)).len() <= 120);
    assert!(valid_session_id("8c1f0e1a-2b3c-4d5e-8f90-123456789abc"));
    assert!(!valid_session_id(".."));
    assert!(!valid_session_id("a/b"));
    assert!(!valid_session_id(""));
}

#[tokio::test]
async fn uploads_over_the_limit_are_refused_and_leave_nothing_behind() {
    let state = test_state();
    add_session(&state, "s1", false).await;
    state.settings.write().await.max_upload_mb = 1;
    let local = local_router(state.clone());
    let limit = 1024 * 1024;

    let (status, body) = call(&local, upload("/api/sessions/s1/files", None, None, "big.bin", "application/octet-stream", &vec![0u8; limit + 1])).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE, "{body}");
    let leftovers = std::fs::read_dir(state.temp_root.join("s1")).map(|dir| dir.count()).unwrap_or(0);
    assert_eq!(leftovers, 0, "partial upload removed");
    assert!(session_files(&state, "s1").await.is_empty());

    let (status, body) = call(&local, upload("/api/sessions/s1/files", None, None, "exact.bin", "application/octet-stream", &vec![0u8; limit])).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let file: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(file["size"], limit as u64);
}

#[tokio::test]
async fn upload_mime_allowlist_checks_name_and_declared_type() {
    let state = test_state();
    add_session(&state, "s1", false).await;
    let local = local_router(state.clone());
    let path = "/api/sessions/s1/files";

    // Empty allowlist: anything goes.
    assert_eq!(call(&local, upload(path, None, None, "run.sh", "text/x-sh", b"x")).await.0, StatusCode::OK);

    state.settings.write().await.allowed_upload_types = vec!["image/*".into(), "application/pdf".into()];
    let (status, body) = call(&local, upload(path, None, None, "photo.png", "image/png", b"x")).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let file: Value = serde_json::from_str(&body).unwrap();
    assert_eq!(file["mime"], "image/png");
    assert_eq!(call(&local, upload(path, None, None, "doc.pdf", "application/octet-stream", b"x")).await.0, StatusCode::OK);
    assert_eq!(call(&local, upload(path, None, None, "notes.txt", "text/plain", b"x")).await.0, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(call(&local, upload(path, None, None, "photo.png", "text/html", b"x")).await.0, StatusCode::UNSUPPORTED_MEDIA_TYPE, "declared type must pass too");
    assert_eq!(call(&local, upload(path, None, None, "noext", "application/octet-stream", b"x")).await.0, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}

#[test]
fn settings_validate_mime_patterns() {
    let settings = |types: &[&str]| Settings { allowed_upload_types: types.iter().map(|t| t.to_string()).collect(), ..Settings::default() };
    let valid = settings(&[" Image/* ", "application/pdf", "image/*", ""]).validate().unwrap();
    assert_eq!(valid.allowed_upload_types, vec!["image/*", "application/pdf"]);
    assert!(settings(&["image"]).validate().is_err());
    assert!(settings(&["*/*"]).validate().is_err());
    assert!(settings(&["text/<script>"]).validate().is_err());
    assert!(valid.allows_upload_type("image/png; charset=binary"));
    assert!(!valid.allows_upload_type("imagex/png"));
}

// ---------------------------------------------------------------- multi-session isolation

#[tokio::test]
async fn sessions_are_isolated_from_each_other_and_from_unshared_devices() {
    let state = test_state();
    let (_, token) = pair(&state).await;
    let local_addr = serve(local_router(state.clone())).await;
    let remote = remote_router(state.clone());
    let remote_addr = serve(remote.clone()).await;

    let mut shared = bridge(local_addr, "shared", true).await;
    let mut private = bridge(local_addr, "private", false).await;

    // Listing and files: only the shared session is visible to the device.
    let (_, body) = call(&remote, get("/api/sessions", None, Some(&token))).await;
    let sessions: Value = serde_json::from_str(&body).unwrap();
    let ids: Vec<&str> = sessions["sessions"].as_array().unwrap().iter().map(|s| s["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["shared"]);
    assert_eq!(call(&remote, get("/api/sessions/private/files", None, Some(&token))).await.0, StatusCode::FORBIDDEN);
    let (status, _) = call(&remote, upload("/api/sessions/private/files", Some(DEVICE_ORIGIN), Some(&token), "a.txt", "text/plain", b"x")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call(&remote, upload("/api/sessions/shared/files", Some(DEVICE_ORIGIN), Some(&token), "a.txt", "text/plain", b"x")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(session_files(&state, "shared").await.len(), 1);
    assert!(session_files(&state, "private").await.is_empty(), "files stay with their session");

    // Commands reach only the addressed session, and never an unshared one from a device.
    let protocols = format!("pi-companion, token.{token}");
    let mut device = ws_connect(remote_addr, "/ws/browser", Some(DEVICE_ORIGIN), Some(&protocols)).await.unwrap();
    send_json(&mut device, json!({ "sessionId": "private", "command": { "type": "prompt", "text": "sneaky" } })).await;
    send_json(&mut device, json!({ "sessionId": "shared", "command": { "type": "prompt", "text": "hello" } })).await;
    let command = next_matching(&mut shared, |v| v["type"] == "command").await;
    assert_eq!(command["command"]["text"], "hello");
    assert_no_frame(&mut private, 200, |v| v["type"] == "command").await;

    // Events from the unshared session never reach the device.
    send_json(&mut private, json!({ "type": "event", "event": "assistant.delta", "payload": { "delta": "secret" } })).await;
    send_json(&mut shared, json!({ "type": "event", "event": "assistant.delta", "payload": { "delta": "public" } })).await;
    let event = next_matching(&mut device, |v| v["type"] == "bridge.event").await;
    assert_eq!(event["sessionId"], "shared");
    assert_no_frame(&mut device, 200, |v| v["sessionId"] == "private").await;
}
