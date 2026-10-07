mod assets;
mod config;

use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        DefaultBodyLimit, Multipart, Path, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
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
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Close codes sent to paired-device sockets so the UI can explain what happened.
const CLOSE_DISCONNECTED: u16 = 4001;
const CLOSE_REVOKED: u16 = 4003;

use config::{Settings, StoredDevice};

#[derive(Clone, Debug)]
struct Kick {
    device_id: String,
    code: u16,
    reason: &'static str,
}

#[derive(Clone)]
struct AppState {
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    files: Arc<RwLock<HashMap<String, Vec<TempFile>>>>,
    pairings: Arc<RwLock<HashMap<String, PairingInvite>>>,
    devices: Arc<RwLock<HashMap<String, StoredDevice>>>,
    /// Open paired-device sockets per device id.
    device_connections: Arc<RwLock<HashMap<String, usize>>>,
    settings: Arc<RwLock<Settings>>,
    env_public_url: Option<String>,
    browser_tx: broadcast::Sender<Value>,
    kick_tx: broadcast::Sender<Kick>,
    temp_root: PathBuf,
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
    expires_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceView {
    id: String,
    name: String,
    paired_at: u64,
    last_seen: u64,
    connected: bool,
    connections: usize,
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
    devices: Vec<DeviceView>,
}

type ApiError = (StatusCode, String);
type ApiResult<T> = Result<T, ApiError>;

#[tokio::main]
async fn main() {
    // Without RUST_LOG, show this daemon's info logs and other crates' warnings.
    // (EnvFilter's own default is ERROR only, which hid the startup addresses.)
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn,pi_companion_server=info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let temp_root = std::env::temp_dir().join("pi-companion");
    fs::create_dir_all(&temp_root).await.expect("create temp root");
    set_private_dir_permissions(&temp_root).await;

    let persisted = config::load().await;
    let settings = persisted.settings.validate().unwrap_or_default();
    let devices = persisted.devices.into_iter().map(|d| (d.id.clone(), d)).collect();

    let (browser_tx, _) = broadcast::channel(1024);
    let (kick_tx, _) = broadcast::channel(64);
    let state = AppState {
        sessions: Arc::new(RwLock::new(HashMap::new())),
        files: Arc::new(RwLock::new(HashMap::new())),
        pairings: Arc::new(RwLock::new(HashMap::new())),
        devices: Arc::new(RwLock::new(devices)),
        device_connections: Arc::new(RwLock::new(HashMap::new())),
        settings: Arc::new(RwLock::new(settings)),
        env_public_url: std::env::var("PI_COMPANION_PUBLIC_URL")
            .ok()
            .map(|value| value.trim().trim_end_matches('/').to_string())
            .filter(|value| !value.is_empty()),
        browser_tx,
        kick_tx,
        temp_root,
    };

    let local = local_router(state.clone());
    let remote = remote_router(state.clone());

    // Single instance per machine: if the ports are taken, another daemon is already
    // serving (started by another Pi session or manually). Exit quietly instead of panicking.
    let local_listener = match tokio::net::TcpListener::bind(LOCAL_ADDR).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!();
            eprintln!("  Pi Companion is already running.");
            eprintln!();
            eprintln!("  Console   http://{LOCAL_ADDR}");
            eprintln!();
            eprintln!("  Another daemon (often one started automatically by a Pi session) owns the port,");
            eprintln!("  so this one is exiting. To run this build instead, stop the other one first:");
            eprintln!("    macOS/Linux:  pkill -f pi-companion-server");
            eprintln!("    Windows:      taskkill /IM pi-companion-server.exe /F");
            eprintln!();
            return;
        }
        Err(error) => panic!("bind local admin {LOCAL_ADDR}: {error}"),
    };
    let remote_listener = match tokio::net::TcpListener::bind(REMOTE_ADDR).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!("pi-companion-server: {REMOTE_ADDR} is used by another program. Free that port and try again.");
            std::process::exit(1);
        }
        Err(error) => panic!("bind remote surface {REMOTE_ADDR}: {error}"),
    };

    print_banner(&state).await;

    let (local_result, remote_result) = tokio::join!(
        axum::serve(local_listener, local),
        axum::serve(remote_listener, remote)
    );
    local_result.expect("local server failed");
    remote_result.expect("remote server failed");
}

fn local_router(state: AppState) -> Router {
    Router::new()
        .route("/api/context", get(local_context))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{session_id}/files", get(list_files).post(upload_file))
        .route("/api/sessions/{session_id}/files/{file_id}", delete(delete_file_local))
        .route("/api/pairing/start", post(start_pairing))
        .route("/api/devices", get(list_devices))
        .route("/api/devices/{device_id}", delete(revoke_device))
        .route("/api/devices/{device_id}/disconnect", post(disconnect_device))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/ws/browser", get(browser_ws))
        .route("/ws/bridge/{session_id}", get(bridge_ws))
        .fallback(get(assets::serve))
        .layer(DefaultBodyLimit::max(body_limit()))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn remote_router(state: AppState) -> Router {
    Router::new()
        .route("/api/context", get(remote_context))
        .route("/api/pairing/claim", post(claim_pairing))
        .route("/api/sessions", get(list_sessions_remote))
        .route("/api/sessions/{session_id}/files", get(list_files_remote).post(upload_file_remote))
        .route("/api/sessions/{session_id}/files/{file_id}", delete(delete_file_remote))
        .route("/ws/browser", get(browser_ws_remote))
        .fallback(get(assets::serve))
        .layer(DefaultBodyLimit::max(body_limit()))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Always printed, independent of RUST_LOG, so `npm run serve` / `cargo run` show where to go.
async fn print_banner(state: &AppState) {
    let public = public_url(state).await;
    let public_note = if state.env_public_url.is_some() {
        "from PI_COMPANION_PUBLIC_URL"
    } else if public == config::DEFAULT_PUBLIC_URL {
        "default, this computer only; set one in Settings"
    } else {
        "from Settings"
    };
    let devices = state.devices.read().await.len();
    println!();
    println!("  Pi Companion v{VERSION}");
    println!();
    println!("  Console          http://{LOCAL_ADDR}");
    println!("  Paired devices   http://{REMOTE_ADDR}");
    println!("  Pairing links    {public}  ({public_note})");
    println!("  Data             {}  ({devices} paired)", config::data_dir().display());
    println!();
    println!("  Open the console in your browser. Press Ctrl+C to stop.");
    println!();
}

fn body_limit() -> usize {
    (config::MAX_UPLOAD_MB_LIMIT as usize) * 1024 * 1024 + 64 * 1024
}

async fn local_context() -> Json<Value> {
    Json(serde_json::json!({ "remote": false, "version": VERSION }))
}

async fn remote_context() -> Json<Value> {
    Json(serde_json::json!({ "remote": true, "version": VERSION }))
}

async fn public_url(state: &AppState) -> String {
    if let Some(url) = &state.env_public_url {
        return url.clone();
    }
    let configured = state.settings.read().await.public_url.clone();
    if configured.is_empty() { config::DEFAULT_PUBLIC_URL.to_string() } else { configured }
}

/// Write settings and device registry to disk. Failures are logged, not fatal.
async fn persist(state: &AppState) {
    let snapshot = config::Persisted {
        settings: state.settings.read().await.clone(),
        devices: state.devices.read().await.values().cloned().collect(),
    };
    if let Err(error) = config::save(&snapshot).await {
        tracing::warn!("could not save state: {error}");
    }
}

async fn get_settings(State(state): State<AppState>) -> Json<Value> {
    let settings = state.settings.read().await.clone();
    Json(serde_json::json!({
        "settings": settings,
        "effective": {
            "publicUrl": public_url(&state).await,
            "publicUrlFromEnv": state.env_public_url.is_some(),
        },
        "limits": { "maxUploadMb": config::MAX_UPLOAD_MB_LIMIT },
        "about": {
            "version": VERSION,
            "adminUrl": format!("http://{LOCAL_ADDR}"),
            "deviceUrl": format!("http://{REMOTE_ADDR}"),
            "dataDir": config::data_dir().to_string_lossy(),
            "tempDir": state.temp_root.to_string_lossy(),
        }
    }))
}

async fn put_settings(
    State(state): State<AppState>,
    Json(next): Json<Settings>,
) -> ApiResult<Json<Value>> {
    let valid = next.validate().map_err(|message| (StatusCode::BAD_REQUEST, message))?;
    *state.settings.write().await = valid;
    persist(&state).await;
    broadcast(&state, serde_json::json!({ "type": "settings.update" }));
    Ok(get_settings(State(state)).await)
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
    let connections = state.device_connections.read().await;
    let mut devices: Vec<DeviceView> = state
        .devices
        .read()
        .await
        .values()
        .map(|device| {
            let open = connections.get(&device.id).copied().unwrap_or(0);
            DeviceView {
                id: device.id.clone(),
                name: device.name.clone(),
                paired_at: device.paired_at,
                last_seen: device.last_seen,
                connected: open > 0,
                connections: open,
            }
        })
        .collect();
    devices.sort_by(|a, b| b.connected.cmp(&a.connected).then(b.last_seen.cmp(&a.last_seen)));
    Json(DevicesResponse { devices })
}

async fn start_pairing(State(state): State<AppState>) -> ApiResult<Json<PairingResponse>> {
    let token = Uuid::new_v4().simple().to_string() + &Uuid::new_v4().simple().to_string();
    let compact = Uuid::new_v4().simple().to_string().to_uppercase();
    let code = format!("{}-{}", &compact[0..4], &compact[4..8]);
    let ttl = state.settings.read().await.pairing_ttl_minutes * 60;
    let expires_at = now_secs() + ttl;
    let url = format!("{}/pair?invite={}", public_url(&state).await, token);

    {
        let mut pairings = state.pairings.write().await;
        let now = now_secs();
        pairings.retain(|_, invite| invite.expires_at >= now);
        pairings.insert(token, PairingInvite { expires_at });
    }

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
        StoredDevice {
            id: device_id.clone(),
            name: name.to_string(),
            token_hash: hash_token(&token),
            paired_at: timestamp,
            last_seen: timestamp,
        },
    );
    persist(&state).await;
    broadcast(&state, serde_json::json!({ "type": "devices.update" }));
    Ok(Json(PairClaimResponse { device_id, token }))
}

async fn revoke_device(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
) -> StatusCode {
    if state.devices.write().await.remove(&device_id).is_none() {
        return StatusCode::NOT_FOUND;
    }
    persist(&state).await;
    let _ = state.kick_tx.send(Kick { device_id, code: CLOSE_REVOKED, reason: "revoked" });
    broadcast(&state, serde_json::json!({ "type": "devices.update" }));
    StatusCode::NO_CONTENT
}

/// End the device's live connections without forgetting it. The device keeps its
/// credential and can reconnect when its user chooses to.
async fn disconnect_device(
    State(state): State<AppState>,
    Path(device_id): Path<String>,
) -> StatusCode {
    if !state.devices.read().await.contains_key(&device_id) {
        return StatusCode::NOT_FOUND;
    }
    let _ = state.kick_tx.send(Kick { device_id, code: CLOSE_DISCONNECTED, reason: "disconnected" });
    StatusCode::NO_CONTENT
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

    let max_bytes = (state.settings.read().await.max_upload_mb as usize) * 1024 * 1024;
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
            if size > max_bytes {
                drop(output);
                let _ = fs::remove_file(&disk_path).await;
                return Err((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!("File is larger than the {} MiB limit.", max_bytes / 1024 / 1024),
                ));
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
    ws.on_upgrade(move |socket| browser_socket(socket, state, None))
}

async fn browser_ws_remote(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<impl IntoResponse> {
    let token = websocket_token(&headers)?;
    let device_id = authorize_device(&state, token).await?;
    Ok(ws
        .protocols(["pi-companion"])
        .on_upgrade(move |socket| browser_socket(socket, state, Some(device_id))))
}

/// Whether a broadcast event may be shown to a paired device.
async fn visible_to_device(state: &AppState, value: &Value) -> bool {
    let session_id = value
        .get("sessionId")
        .and_then(Value::as_str)
        .or_else(|| value.get("session").and_then(|s| s.get("id")).and_then(Value::as_str));
    let Some(session_id) = session_id else { return false };
    // Let devices learn that a session stopped being shared, so they can hide it.
    if value.get("type").and_then(Value::as_str) == Some("session.update")
        && value.get("patch").and_then(|p| p.get("remoteEnabled")).is_some()
    {
        return true;
    }
    state
        .sessions
        .read()
        .await
        .get(session_id)
        .and_then(|s| s.snapshot.get("remoteEnabled"))
        .and_then(Value::as_bool)
        == Some(true)
}

async fn set_device_connection(state: &AppState, device_id: &str, delta: isize) {
    {
        let mut connections = state.device_connections.write().await;
        let entry = connections.entry(device_id.to_string()).or_insert(0);
        *entry = (*entry as isize + delta).max(0) as usize;
        if *entry == 0 {
            connections.remove(device_id);
        }
    }
    if delta < 0 {
        if let Some(device) = state.devices.write().await.get_mut(device_id) {
            device.last_seen = now_secs();
        }
        persist(state).await;
    }
    broadcast(state, serde_json::json!({ "type": "devices.update" }));
}

async fn browser_socket(socket: WebSocket, state: AppState, device_id: Option<String>) {
    let (mut sender, mut receiver) = socket.split();
    let mut events = state.browser_tx.subscribe();
    let mut kicks = state.kick_tx.subscribe();
    let (close_tx, mut close_rx) = mpsc::unbounded_channel::<(u16, &'static str)>();
    if let Some(id) = &device_id {
        set_device_connection(&state, id, 1).await;
    }

    let writer_state = state.clone();
    let remote = device_id.is_some();
    let mut send_task = tokio::spawn(async move {
        loop {
            tokio::select! {
                close = close_rx.recv() => {
                    if let Some((code, reason)) = close {
                        let frame = CloseFrame { code, reason: reason.into() };
                        let _ = sender.send(Message::Close(Some(frame))).await;
                    }
                    break;
                }
                event = events.recv() => match event {
                    Ok(value) => {
                        if remote && !visible_to_device(&writer_state, &value).await { continue; }
                        if sender.send(Message::Text(value.to_string().into())).await.is_err() { break; }
                    }
                    // A slow tab missed some events; keep streaming rather than dropping it.
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            }
        }
    });

    let mut kicked = false;
    loop {
        tokio::select! {
            message = receiver.next() => match message {
                Some(Ok(Message::Text(text))) => forward_browser_command(&state, &text, remote).await,
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => continue,
            },
            kick = kicks.recv(), if remote => match kick {
                Ok(kick) if Some(&kick.device_id) == device_id.as_ref() => {
                    let _ = close_tx.send((kick.code, kick.reason));
                    kicked = true;
                    break;
                }
                Err(broadcast::error::RecvError::Closed) => break,
                _ => continue,
            },
        }
    }

    if kicked {
        let _ = tokio::time::timeout(Duration::from_secs(1), &mut send_task).await;
    }
    send_task.abort();
    if let Some(id) = &device_id {
        set_device_connection(&state, id, -1).await;
    }
}

async fn forward_browser_command(state: &AppState, text: &str, remote: bool) {
    let Ok(envelope) = serde_json::from_str::<BrowserEnvelope>(text) else { return };
    let sessions = state.sessions.read().await;
    let Some(session) = sessions.get(&envelope.session_id) else { return };
    if remote && session.snapshot.get("remoteEnabled").and_then(Value::as_bool) != Some(true) {
        return;
    }
    if let Some(command_tx) = &session.command_tx {
        let _ = command_tx.send(serde_json::json!({ "type": "command", "command": envelope.command }));
    }
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

async fn authorize_device(state: &AppState, token: &str) -> ApiResult<String> {
    let hash = hash_token(token);
    let mut devices = state.devices.write().await;
    if let Some(device) = devices.values_mut().find(|d| d.token_hash == hash) {
        device.last_seen = now_secs();
        return Ok(device.id.clone());
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
