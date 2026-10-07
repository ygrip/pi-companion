use std::{collections::HashMap, sync::Arc};
use axum::{
    extract::{Path, State, ws::{Message, WebSocket, WebSocketUpgrade}},
    response::{Html, IntoResponse},
    routing::get,
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, RwLock};
use tower_http::trace::TraceLayer;

#[derive(Clone)]
struct AppState {
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    browser_tx: broadcast::Sender<Value>,
}

#[derive(Clone)]
struct Session {
    snapshot: Value,
    command_tx: mpsc::UnboundedSender<Value>,
}

#[derive(Deserialize)]
struct BrowserEnvelope {
    #[serde(rename = "sessionId")]
    session_id: String,
    command: Value,
}

#[derive(Serialize)]
struct SessionsResponse { sessions: Vec<Value> }

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let (browser_tx, _) = broadcast::channel(1024);
    let state = AppState {
        sessions: Arc::new(RwLock::new(HashMap::new())),
        browser_tx,
    };

    let app = Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/styles.css", get(styles))
        .route("/api/sessions", get(list_sessions))
        .route("/ws/browser", get(browser_ws))
        .route("/ws/bridge/{session_id}", get(bridge_ws))
        .layer(TraceLayer::new_for_http())
        .with_state(state);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:43721").await.unwrap();
    tracing::info!("Pi Companion listening on http://127.0.0.1:43721");
    axum::serve(listener, app).await.unwrap();
}

async fn index() -> Html<&'static str> { Html(include_str!("../web/index.html")) }
async fn app_js() -> impl IntoResponse {
    ([("content-type", "text/javascript; charset=utf-8")], include_str!("../web/app.js"))
}
async fn styles() -> impl IntoResponse {
    ([("content-type", "text/css; charset=utf-8")], include_str!("../web/styles.css"))
}

async fn list_sessions(State(state): State<AppState>) -> Json<SessionsResponse> {
    let sessions = state.sessions.read().await.values().map(|s| s.snapshot.clone()).collect();
    Json(SessionsResponse { sessions })
}

async fn browser_ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| browser_socket(socket, state))
}

async fn browser_socket(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut events = state.browser_tx.subscribe();
    let send_task = tokio::spawn(async move {
        while let Ok(value) = events.recv().await {
            if sender.send(Message::Text(value.to_string().into())).await.is_err() { break; }
        }
    });

    while let Some(Ok(Message::Text(text))) = receiver.next().await {
        if let Ok(envelope) = serde_json::from_str::<BrowserEnvelope>(&text) {
            if let Some(session) = state.sessions.read().await.get(&envelope.session_id) {
                let _ = session.command_tx.send(serde_json::json!({
                    "type": "command",
                    "command": envelope.command
                }));
            }
        }
    }
    send_task.abort();
}

async fn bridge_ws(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| bridge_socket(socket, session_id, state))
}

async fn bridge_socket(socket: WebSocket, session_id: String, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (command_tx, mut command_rx) = mpsc::unbounded_channel::<Value>();
    let send_task = tokio::spawn(async move {
        while let Some(command) = command_rx.recv().await {
            if sender.send(Message::Text(command.to_string().into())).await.is_err() { break; }
        }
    });

    while let Some(Ok(Message::Text(text))) = receiver.next().await {
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        match value.get("type").and_then(Value::as_str) {
            Some("register") => {
                let snapshot = value.get("session").cloned().unwrap_or(Value::Null);
                state.sessions.write().await.insert(session_id.clone(), Session {
                    snapshot: snapshot.clone(),
                    command_tx: command_tx.clone(),
                });
                let _ = state.browser_tx.send(serde_json::json!({
                    "type": "session.register",
                    "session": snapshot
                }));
            }
            Some("session.update") => {
                if let Some(patch) = value.get("session").and_then(Value::as_object) {
                    let mut sessions = state.sessions.write().await;
                    if let Some(session) = sessions.get_mut(&session_id) {
                        if let Some(snapshot) = session.snapshot.as_object_mut() {
                            for (key, value) in patch { snapshot.insert(key.clone(), value.clone()); }
                        }
                    }
                }
                let _ = state.browser_tx.send(serde_json::json!({
                    "type": "session.update",
                    "sessionId": session_id,
                    "patch": value.get("session")
                }));
            }
            _ => {
                let _ = state.browser_tx.send(serde_json::json!({
                    "type": "bridge.event",
                    "sessionId": session_id,
                    "message": value
                }));
            }
        }
    }

    state.sessions.write().await.remove(&session_id);
    let _ = state.browser_tx.send(serde_json::json!({
        "type": "session.remove",
        "sessionId": session_id
    }));
    send_task.abort();
}
