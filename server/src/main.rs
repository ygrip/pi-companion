use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        DefaultBodyLimit, Multipart, Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::{Html, IntoResponse},
    routing::{delete, get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use qrcode::{render::svg, QrCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::{
    fs,
    io::AsyncWriteExt,
    sync::{broadcast, mpsc, RwLock},
};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

const LOCAL_ADDR: &str = "127.0.0.1:43721";
const REMOTE_ADDR: &str = "127.0.0.1:43722";
const MAX_UPLOAD_BYTES: usize = 25 * 1024 * 1024;
const PAIRING_TTL_SECS: u64 = 300;

#[derive(Clone)]
struct AppState {
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    files: Arc<RwLock<HashMap<String, Vec<TempFile>>>>,
    pairings: Arc<RwLock<HashMap<String, PairingInvite>>>,
    devices: Arc<RwLock<HashMap<String, PairedDevice>>>,
    browser_tx: broadcast::Sender<Value>,
    temp_root: PathBuf,
    public_url: String,
}

#[derive(Clone)]
struct Session {
    snapshot: Value,
    command_tx: Option<mpsc::UnboundedSender<Value>>,
}

#[derive(Clone, Serialize)]
struct TempFile {
    id: String,
    name: String,
    path: String,
    size: u64,
    #[serde(rename = "createdAt")]
    created_at: u64,
}

#[derive(Clone)]
struct PairingInvite {
    token: String,
    code: String,
    expires_at: u64,
}

#[derive(Clone, Serialize)]
struct PairedDevice {
    id: String,
    name: String,
    #[serde(skip_serializing)]
    token_hash: String,
    #[serde(rename = "pairedAt")]
    paired_at: u64,
    #[serde(rename = "lastSeen")]
    last_seen: u64,
}

#[derive(Deserialize)]
struct BrowserEnvelope {
    #[serde(rename = "sessionId")]
    session_id: String,
    command: Value,
}


#[derive(Deserialize)]
struct PairClaim {
    invite: String,
    #[serde(rename = "deviceName")]
    device_name: String,
}

#[derive(Serialize)]
struct PairingResponse {
    code: String,
    url: String,
    #[serde(rename = "qrSvg")]
    qr_svg: String,
    #[serde(rename = "expiresAt")]
    expires_at: u64,
}

#[derive(Serialize)]
struct PairClaimResponse {
    #[serde(rename = "deviceId")]
    device_id: String,
    token: String,
}

#[derive(Serialize)]
struct SessionsResponse {
    sessions: Vec<Value>,
}

#[derive(Serialize)]
struct FilesResponse {
    files: Vec<TempFile>,
}

#[derive(Serialize)]
struct DevicesResponse {
    devices: Vec<PairedDevice>,
}

type ApiError = (StatusCode, String);
type ApiResult<T> = Result<T, ApiError>;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let temp_root = std::env::temp_dir().join("pi-companion");
    fs::create_dir_all(&temp_root).await.expect("create temp root");
    set_private_dir_permissions(&temp_root).await;

    let (browser_tx, _) = broadcast::channel(256);
    let state = AppState {
        sessions: Arc::new(RwLock::new(HashMap::new())),
        files: Arc::new(RwLock::new(HashMap::new())),
        pairings: Arc::new(RwLock::new(HashMap::new())),
        devices: Arc::new(RwLock::new(HashMap::new())),
        browser_tx,
        temp_root,
        public_url: std::env::var("PI_COMPANION_PUBLIC_URL")
            .unwrap_or_else(|_| "http://127.0.0.1:43722".to_string())
            .trim_end_matches('/')
            .to_string(),
    };

    let local = local_router(state.clone());
    let remote = remote_router(state.clone());

    let local_listener = tokio::net::TcpListener::bind(LOCAL_ADDR).await.expect("bind local admin");
    let remote_listener = tokio::net::TcpListener::bind(REMOTE_ADDR).await.expect("bind remote surface");

    tracing::info!("Pi Companion admin: http://{LOCAL_ADDR}");
    tracing::info!("Pi Companion paired-device surface: http://{REMOTE_ADDR}");

    let (local_result, remote_result) = tokio::join!(
        axum::serve(local_listener, local),
        axum::serve(remote_listener, remote)
    );
    local_result.expect("local server failed");
    remote_result.expect("remote server failed");
}

fn local_router(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/app.js", get(app_js))
        .route("/styles.css", get(styles))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{session_id}/files", get(list_files).post(upload_file))
        .route("/api/sessions/{session_id}/files/{file_id}", delete(delete_file_local))
        .route("/api/pairing/start", post(start_pairing))
        .route("/api/devices", get(list_devices))
        .route("/api/devices/{device_id}", delete(revoke_device))
        .route("/ws/browser", get(browser_ws))
        .route("/ws/bridge/{session_id}", get(bridge_ws))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn remote_router(state: AppState) -> Router {
    Router::new()
        .route("/", get(remote_index))
        .route("/pair", get(remote_index))
        .route("/app.js", get(app_js))
        .route("/styles.css", get(styles))
        .route("/api/pairing/claim", post(claim_pairing))
        .route("/api/sessions", get(list_sessions_remote))
        .route("/api/sessions/{session_id}/files", get(list_files_remote).post(upload_file_remote))
        .route("/api/sessions/{session_id}/files/{file_id}", delete(delete_file_remote))
        .route("/ws/browser", get(browser_ws_remote))
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn index() -> Html<&'static str> {
    Html(include_str!("../web/index.html"))
}

async fn remote_index() -> Html<String> {
    Html(include_str!("../web/index.html").replace("<body>", "<body data-remote=\"true\">"))
}

async fn app_js() -> impl IntoResponse {
    ([("content-type", "text/javascript; charset=utf-8")], include_str!("../web/app.js"))
}

async fn styles() -> impl IntoResponse {
    ([("content-type", "text/css; charset=utf-8")], include_str!("../web/styles.css"))
}

async fn list_sessions(State(state): State<AppState>) -> Json<SessionsResponse> {
    Json(SessionsResponse {
        sessions: state.sessions.read().await.values().map(|s| s.snapshot.clone()).collect(),
    })
}

async fn list_sessions_remote(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<SessionsResponse>> {
    authorize_device(&state, bearer_token(&headers)?).await?;
    let sessions = state
        .sessions
        .read()
        .await
        .values()
        .filter(|s| s.snapshot.get("remoteEnabled").and_then(Value::as_bool) == Some(true))
        .map(|s| s.snapshot.clone())
        .collect();
    Ok(Json(SessionsResponse { sessions }))
}

async fn list_devices(State(state): State<AppState>) -> Json<DevicesResponse> {
    Json(DevicesResponse {
        devices: state.devices.read().await.values().cloned().collect(),
    })
}

async fn start_pairing(State(state): State<AppState>) -> ApiResult<Json<PairingResponse>> {
    let token = Uuid::new_v4().simple().to_string() + &Uuid::new_v4().simple().to_string();
    let compact = Uuid::new_v4().simple().to_string().to_uppercase();
    let code = format!("{}-{}", &compact[0..4], &compact[4..8]);
    let expires_at = now_secs() + PAIRING_TTL_SECS;
    let url = format!("{}/pair?invite={}", state.public_url, token);

    state.pairings.write().await.insert(
        token.clone(),
        PairingInvite { token, code: code.clone(), expires_at },
    );

    let qr_svg = QrCode::new(url.as_bytes())
        .map_err(internal_error)?
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .build();

    Ok(Json(PairingResponse { code, url, qr_svg, expires_at }))
}

async fn claim_pairing(
    State(state): State<AppState>,
    Json(claim): Json<PairClaim>,
) -> ApiResult<Json<PairClaimResponse>> {
    let invite = state
        .pairings
        .write()
        .await
        .remove(&claim.invite)
        .ok_or((StatusCode::UNAUTHORIZED, "Pairing invitation is invalid or already used.".into()))?;

    if invite.expires_at < now_secs() {
        return Err((StatusCode::UNAUTHORIZED, "Pairing invitation expired.".into()));
    }

    let name = claim.device_name.trim();
    if name.is_empty() || name.len() > 80 {
        return Err((StatusCode::BAD_REQUEST, "Device name must be 1-80 characters.".into()));
    }

    let device_id = Uuid::new_v4().to_string();
    let token = Uuid::new_v4().simple().to_string() + &Uuid::new_v4().simple().to_string();
    let timestamp = now_secs();
    state.devices.write().await.insert(
        device_id.clone(),
        PairedDevice {
            id: device_id.clone(),
            name: name.to_string(),
            token_hash: hash_token(&token),
            paired_at: timestamp,
            last_seen: timestamp,
        },
    );
    broadcast(&state, serde_json::json!({ "type": "devices.update" }));
    Ok(Json(PairClaimResponse { device_id, token }))
}

async fn revoke_device(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
) -> StatusCode {
    if state.devices.write().await.remove(&device_id).is_some() {
        broadcast(&state, serde_json::json!({ "type": "devices.update" }));
        StatusCode::NO_CONTENT
    } else {
        StatusCode::NOT_FOUND
    }
}

async fn list_files(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
) -> Json<FilesResponse> {
    Json(FilesResponse { files: session_files(&state, &session_id).await })
}

async fn list_files_remote(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<FilesResponse>> {
    authorize_device(&state, bearer_token(&headers)?).await?;
    require_remote_session(&state, &session_id).await?;
    Ok(Json(FilesResponse { files: session_files(&state, &session_id).await }))
}

async fn upload_file(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    multipart: Multipart,
) -> ApiResult<Json<TempFile>> {
    store_upload(&state, &session_id, multipart).await.map(Json)
}

async fn upload_file_remote(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
    multipart: Multipart,
) -> ApiResult<Json<TempFile>> {
    authorize_device(&state, bearer_token(&headers)?).await?;
    require_remote_session(&state, &session_id).await?;
    store_upload(&state, &session_id, multipart).await.map(Json)
}

async fn store_upload(state: &AppState, session_id: &str, mut multipart: Multipart) -> ApiResult<TempFile> {
    if !state.sessions.read().await.contains_key(session_id) {
        return Err((StatusCode::NOT_FOUND, "Session not found.".into()));
    }

    while let Some(mut field) = multipart.next_field().await.map_err(internal_error)? {
        if field.name() != Some("file") {
            continue;
        }

        let original_name = field.file_name().unwrap_or("upload.bin");
        let safe_name = FsPath::new(original_name)
            .file_name()
            .and_then(|v| v.to_str())
            .filter(|v| !v.is_empty() && *v != "." && *v != "..")
            .unwrap_or("upload.bin")
            .to_string();

        let session_dir = state.temp_root.join(session_id);
        fs::create_dir_all(&session_dir).await.map_err(internal_error)?;
        set_private_dir_permissions(&session_dir).await;

        let id = Uuid::new_v4().to_string();
        let disk_path = session_dir.join(format!("{}-{}", id, safe_name));
        let mut output = fs::File::create(&disk_path).await.map_err(internal_error)?;
        let mut size: usize = 0;

        while let Some(chunk) = field.chunk().await.map_err(internal_error)? {
            size += chunk.len();
            if size > MAX_UPLOAD_BYTES {
                let _ = fs::remove_file(&disk_path).await;
                return Err((StatusCode::PAYLOAD_TOO_LARGE, "Upload exceeds 25 MiB.".into()));
            }
            output.write_all(&chunk).await.map_err(internal_error)?;
        }
        output.flush().await.map_err(internal_error)?;

        let file = TempFile {
            id,
            name: safe_name,
            path: disk_path.to_string_lossy().to_string(),
            size: size as u64,
            created_at: now_secs(),
        };
        state.files.write().await.entry(session_id.to_string()).or_default().push(file.clone());
        notify_session_files(state, session_id).await;
        return Ok(file);
    }

    Err((StatusCode::BAD_REQUEST, "Expected multipart field named file.".into()))
}

async fn delete_file_local(
    State(state): State<AppState>,
    Path((session_id, file_id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    delete_temp_file(&state, &session_id, &file_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_file_remote(
    State(state): State<AppState>,
    Path((session_id, file_id)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult<StatusCode> {
    authorize_device(&state, bearer_token(&headers)?).await?;
    require_remote_session(&state, &session_id).await?;
    delete_temp_file(&state, &session_id, &file_id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_temp_file(state: &AppState, session_id: &str, file_id: &str) -> ApiResult<()> {
    let file = {
        let mut files = state.files.write().await;
        let session_files = files.get_mut(session_id)
            .ok_or((StatusCode::NOT_FOUND, "Temporary file not found.".into()))?;
        let index = session_files.iter().position(|f| f.id == file_id)
            .ok_or((StatusCode::NOT_FOUND, "Temporary file not found.".into()))?;
        session_files.remove(index)
    };

    let expected_root = state.temp_root.join(session_id);
    let path = PathBuf::from(&file.path);
    if !path.starts_with(&expected_root) {
        return Err((StatusCode::FORBIDDEN, "Refusing to delete outside the session sandbox.".into()));
    }

    match fs::remove_file(&path).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(internal_error(error)),
    }

    notify_session_files(state, session_id).await;
    Ok(())
}

async fn session_files(state: &AppState, session_id: &str) -> Vec<TempFile> {
    state.files.read().await.get(session_id).cloned().unwrap_or_default()
}

async fn notify_session_files(state: &AppState, session_id: &str) {
    let files = session_files(state, session_id).await;
    if let Some(session) = state.sessions.read().await.get(session_id) {
        if let Some(command_tx) = &session.command_tx {
            let _ = command_tx.send(serde_json::json!({ "type": "temp.files", "files": files }));
        }
    }
    broadcast(state, serde_json::json!({
        "type": "files.update",
        "sessionId": session_id,
        "files": files
    }));
}

async fn browser_ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| browser_socket(socket, state, false))
}

async fn browser_ws_remote(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<impl IntoResponse> {
    let token = websocket_token(&headers)?;
    authorize_device(&state, token).await?;
    Ok(ws.protocols(["pi-companion"]).on_upgrade(move |socket| browser_socket(socket, state, true)))
}

async fn browser_socket(socket: WebSocket, state: AppState, remote: bool) {
    let (mut sender, mut receiver) = socket.split();
    let mut events = state.browser_tx.subscribe();
    let event_state = state.clone();
    let send_task = tokio::spawn(async move {
        while let Ok(value) = events.recv().await {
            if remote {
                let session_id = value
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("session").and_then(|s| s.get("id")).and_then(Value::as_str));
                let Some(session_id) = session_id else { continue };
                let sessions = event_state.sessions.read().await;
                let allowed = sessions
                    .get(session_id)
                    .and_then(|s| s.snapshot.get("remoteEnabled"))
                    .and_then(Value::as_bool)
                    == Some(true);
                if !allowed { continue; }
            }
            if sender.send(Message::Text(value.to_string().into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(Message::Text(text))) = receiver.next().await {
        if let Ok(envelope) = serde_json::from_str::<BrowserEnvelope>(&text) {
            let sessions = state.sessions.read().await;
            if let Some(session) = sessions.get(&envelope.session_id) {
                if remote && session.snapshot.get("remoteEnabled").and_then(Value::as_bool) != Some(true) {
                    continue;
                }
                if let Some(command_tx) = &session.command_tx {
                    let _ = command_tx.send(serde_json::json!({
                        "type": "command",
                        "command": envelope.command
                    }));
                }
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
            if sender.send(Message::Text(command.to_string().into())).await.is_err() {
                break;
            }
        }
    });

    while let Some(Ok(Message::Text(text))) = receiver.next().await {
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        match value.get("type").and_then(Value::as_str) {
            Some("register") => {
                let snapshot = value.get("session").cloned().unwrap_or(Value::Null);
                state.sessions.write().await.insert(
                    session_id.clone(),
                    Session { snapshot: snapshot.clone(), command_tx: Some(command_tx.clone()) },
                );
                broadcast(&state, serde_json::json!({ "type": "session.register", "session": snapshot }));
                notify_session_files(&state, &session_id).await;
            }
            Some("session.update") => {
                if let Some(patch) = value.get("session").and_then(Value::as_object) {
                    let mut sessions = state.sessions.write().await;
                    if let Some(session) = sessions.get_mut(&session_id) {
                        if let Some(snapshot) = session.snapshot.as_object_mut() {
                            for (key, value) in patch {
                                snapshot.insert(key.clone(), value.clone());
                            }
                        }
                    }
                }
                broadcast(&state, serde_json::json!({
                    "type": "session.update",
                    "sessionId": session_id,
                    "patch": value.get("session")
                }));
            }
            Some("file.delete") => {
                let request_id = value.get("requestId").and_then(Value::as_str).unwrap_or_default().to_string();
                let file_id = value.get("fileId").and_then(Value::as_str).unwrap_or_default().to_string();
                let result = delete_temp_file(&state, &session_id, &file_id).await;
                let (ok, error) = match result {
                    Ok(_) => (true, None),
                    Err((_, message)) => (false, Some(message)),
                };
                let _ = command_tx.send(serde_json::json!({
                    "type": "file.delete.result",
                    "requestId": request_id,
                    "ok": ok,
                    "error": error
                }));
            }
            _ => {
                broadcast(&state, serde_json::json!({
                    "type": "bridge.event",
                    "sessionId": session_id,
                    "message": value
                }));
            }
        }
    }

    {
        let mut sessions = state.sessions.write().await;
        if let Some(session) = sessions.get_mut(&session_id) {
            if let Some(snapshot) = session.snapshot.as_object_mut() {
                snapshot.insert("status".into(), Value::String("stopped".into()));
            }
            session.command_tx = None;
        }
    }
    broadcast(&state, serde_json::json!({
        "type": "session.update",
        "sessionId": session_id,
        "patch": { "status": "stopped" }
    }));

    let cleanup_state = state.clone();
    let cleanup_session = session_id.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let reconnected = cleanup_state
            .sessions
            .read()
            .await
            .get(&cleanup_session)
            .and_then(|session| session.command_tx.as_ref())
            .is_some();
        if reconnected { return; }
        cleanup_state.files.write().await.remove(&cleanup_session);
        let _ = fs::remove_dir_all(cleanup_state.temp_root.join(&cleanup_session)).await;
    });

    send_task.abort();
}

async fn require_remote_session(state: &AppState, session_id: &str) -> ApiResult<()> {
    let sessions = state.sessions.read().await;
    match sessions.get(session_id) {
        Some(session) if session.snapshot.get("remoteEnabled").and_then(Value::as_bool) == Some(true) => Ok(()),
        Some(_) => Err((StatusCode::FORBIDDEN, "Remote control is disabled for this session.".into())),
        None => Err((StatusCode::NOT_FOUND, "Session not found.".into())),
    }
}

async fn authorize_device(state: &AppState, token: &str) -> ApiResult<()> {
    let hash = hash_token(token);
    let mut devices = state.devices.write().await;
    if let Some(device) = devices.values_mut().find(|d| d.token_hash == hash) {
        device.last_seen = now_secs();
        return Ok(());
    }
    Err((StatusCode::UNAUTHORIZED, "Invalid device token.".into()))
}

fn bearer_token(headers: &HeaderMap) -> ApiResult<&str> {
    let value = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing device credential.".into()))?;
    value
        .strip_prefix("Bearer ")
        .filter(|token| !token.is_empty())
        .ok_or((StatusCode::UNAUTHORIZED, "Invalid authorization header.".into()))
}

fn websocket_token(headers: &HeaderMap) -> ApiResult<&str> {
    let protocols = headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing WebSocket credential.".into()))?;
    protocols
        .split(',')
        .map(str::trim)
        .find_map(|value| value.strip_prefix("token."))
        .filter(|token| !token.is_empty())
        .ok_or((StatusCode::UNAUTHORIZED, "Missing WebSocket device credential.".into()))
}

fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn broadcast(state: &AppState, value: Value) {
    let _ = state.browser_tx.send(value);
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn internal_error(error: impl std::fmt::Display) -> ApiError {
    tracing::warn!("request failed: {error}");
    (StatusCode::INTERNAL_SERVER_ERROR, "Internal server error.".into())
}

#[cfg(unix)]
async fn set_private_dir_permissions(path: &FsPath) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = fs::metadata(path).await {
        let mut permissions = metadata.permissions();
        permissions.set_mode(0o700);
        let _ = fs::set_permissions(path, permissions).await;
    }
}

#[cfg(not(unix))]
async fn set_private_dir_permissions(_path: &FsPath) {}
