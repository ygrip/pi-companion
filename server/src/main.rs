mod activity;
mod automation;
mod assets;
mod config;
#[cfg(test)]
mod tests;

use std::{
    collections::HashMap,
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use axum::{
    extract::{
        DefaultBodyLimit, Multipart, Path, Request, State,
        ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    serve::ListenerExt,
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
    sync::{broadcast, mpsc, Mutex, RwLock},
};
use tower_http::trace::TraceLayer;
use uuid::Uuid;

/// Loopback listen address, overridable for isolated runs (demo screenshots, a second
/// build next to a running daemon). Only loopback addresses are accepted.
fn listen_addr(var: &str, default: &'static str) -> &'static str {
    std::env::var(var)
        .ok()
        .filter(|value| value.starts_with("127.0.0.1:") && value[10..].parse::<u16>().is_ok())
        .map(|value| &*Box::leak(value.into_boxed_str()))
        .unwrap_or(default)
}

static LOCAL_ADDR_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
static REMOTE_ADDR_CELL: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();

fn local_addr() -> &'static str { LOCAL_ADDR_CELL.get_or_init(|| listen_addr("PI_COMPANION_ADMIN_ADDR", "127.0.0.1:43721")) }
fn remote_addr() -> &'static str { REMOTE_ADDR_CELL.get_or_init(|| listen_addr("PI_COMPANION_DEVICE_ADDR", "127.0.0.1:43722")) }
const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Close codes sent to paired-device sockets so the UI can explain what happened.
const CLOSE_DISCONNECTED: u16 = 4001;
const CLOSE_REVOKED: u16 = 4003;
/// Wrong pairing codes tolerated per window before every open invitation is withdrawn.
const CODE_FAILURE_LIMIT: usize = 10;
const CODE_FAILURE_WINDOW_SECS: u64 = 600;

use config::{Settings, StoredDevice};

#[derive(Clone, Debug)]
struct Kick {
    device_id: String,
    code: u16,
    reason: &'static str,
}

#[derive(Clone)]
struct AppState {
    automations: Arc<Mutex<automation::Store>>,
    sessions: Arc<RwLock<HashMap<String, Session>>>,
    files: Arc<RwLock<HashMap<String, Vec<TempFile>>>>,
    /// Recent feed per session so reconnecting browsers can catch up.
    activity: Arc<RwLock<activity::ActivityStore>>,
    pairings: Arc<RwLock<HashMap<String, PairingInvite>>>,
    /// Times of recent wrong pairing-code attempts (brute-force brake).
    code_failures: Arc<Mutex<Vec<u64>>>,
    devices: Arc<RwLock<HashMap<String, StoredDevice>>>,
    /// Open paired-device sockets per device id.
    device_connections: Arc<RwLock<HashMap<String, usize>>>,
    settings: Arc<RwLock<Settings>>,
    env_public_url: Option<String>,
    /// Extra origins allowed on the paired-device surface (PI_COMPANION_ALLOWED_ORIGINS).
    extra_origins: Vec<String>,
    browser_tx: broadcast::Sender<Value>,
    kick_tx: broadcast::Sender<Kick>,
    shutdown_tx: broadcast::Sender<()>,
    temp_root: PathBuf,
    data_dir: PathBuf,
}

impl AppState {
    fn new(persisted: config::Persisted, temp_root: PathBuf, data_dir: PathBuf, env_public_url: Option<String>, extra_origins: Vec<String>) -> Self {
        let settings = persisted.settings.validate().unwrap_or_default();
        let devices = persisted.devices.into_iter().map(|d| (d.id.clone(), d)).collect();
        let (browser_tx, _) = broadcast::channel(1024);
        let (kick_tx, _) = broadcast::channel(64);
        let (shutdown_tx, _) = broadcast::channel(2);
        Self {
            automations: Arc::new(Mutex::new(automation::Store::default())),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            files: Arc::new(RwLock::new(HashMap::new())),
            activity: Arc::new(RwLock::new(activity::ActivityStore::default())),
            pairings: Arc::new(RwLock::new(HashMap::new())),
            code_failures: Arc::new(Mutex::new(Vec::new())),
            devices: Arc::new(RwLock::new(devices)),
            device_connections: Arc::new(RwLock::new(HashMap::new())),
            settings: Arc::new(RwLock::new(settings)),
            env_public_url,
            extra_origins,
            browser_tx,
            kick_tx,
            shutdown_tx,
            temp_root,
            data_dir,
        }
    }
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
    mime: String,
    #[serde(rename = "createdAt")]
    created_at: u64,
}

#[derive(Clone)]
struct PairingInvite {
    expires_at: u64,
    /// The short code shown next to the QR, normalized (8 uppercase hex chars).
    code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceView {
    id: String,
    name: String,
    paired_at: u64,
    last_seen: u64,
    user_agent: String,
    connected: bool,
    connections: usize,
}

#[derive(Deserialize)]
struct BrowserEnvelope {
    #[serde(rename = "sessionId")]
    session_id: String,
    command: Value,
}


/// Exactly one of `invite` (QR link token) or `code` (short code typed by hand).
#[derive(Deserialize)]
struct PairClaim {
    #[serde(default)]
    invite: Option<String>,
    #[serde(default)]
    code: Option<String>,
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

    let data_dir = config::data_dir();
    let persisted = config::load(&data_dir).await;
    let env_public_url = std::env::var("PI_COMPANION_PUBLIC_URL")
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| !value.is_empty());
    let extra_origins = std::env::var("PI_COMPANION_ALLOWED_ORIGINS")
        .unwrap_or_default()
        .split(',')
        .filter_map(origin_of)
        .collect();
    let state = AppState::new(persisted, temp_root, data_dir, env_public_url, extra_origins);

    let local = local_router(state.clone());
    let remote = remote_router(state.clone());
    let mut local_shutdown = state.shutdown_tx.subscribe();
    let mut remote_shutdown = state.shutdown_tx.subscribe();

    // Single instance per machine: if the ports are taken, another daemon is already
    // serving (started by another Pi session or manually). Exit quietly instead of panicking.
    let local_listener = match tokio::net::TcpListener::bind(local_addr()).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!();
            eprintln!("  Pi Companion is already running.");
            eprintln!();
            eprintln!("  Console   http://{}", local_addr());
            eprintln!();
            eprintln!("  Another daemon (often one started automatically by a Pi session) owns the port,");
            eprintln!("  so this one is exiting. To run this build instead, stop the other one first:");
            eprintln!("    macOS/Linux:  pkill -f pi-companion-server");
            eprintln!("    Windows:      taskkill /IM pi-companion-server.exe /F");
            eprintln!();
            return;
        }
        Err(error) => panic!("bind local admin {}: {error}", local_addr()),
    };
    let remote_listener = match tokio::net::TcpListener::bind(remote_addr()).await {
        Ok(listener) => listener,
        Err(error) if error.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!("pi-companion-server: {} is used by another program. Free that port and try again.", remote_addr());
            std::process::exit(1);
        }
        Err(error) => panic!("bind remote surface {}: {error}", remote_addr()),
    };

    // A duplicate process must not rewrite the live daemon's run history either.
    automation::initialize(&state).await.expect("load automation definitions");
    // Do not execute scheduled jobs until both ports are owned by this daemon.
    let maintenance = state.clone();
    let mut maintenance_shutdown = state.shutdown_tx.subscribe();
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(30));
        loop { tokio::select! {
            _ = maintenance_shutdown.recv() => { automation::cancel_all(&maintenance).await; break; },
            _ = interval.tick() => { automation::tick(&maintenance).await; auto_archive(&maintenance).await; }
        } }
    });
    print_banner(&state).await;

    // Small, latency-sensitive frames (questions, answers, deltas): disable Nagle.
    let (local_result, remote_result) = tokio::join!(
        axum::serve(local_listener.tap_io(|tcp| { let _ = tcp.set_nodelay(true); }), local)
            .with_graceful_shutdown(async move { let _ = local_shutdown.recv().await; }),
        axum::serve(remote_listener.tap_io(|tcp| { let _ = tcp.set_nodelay(true); }), remote)
            .with_graceful_shutdown(async move { let _ = remote_shutdown.recv().await; })
    );
    automation::cancel_all(&state).await;
    local_result.expect("local server failed");
    remote_result.expect("remote server failed");
}

fn local_router(state: AppState) -> Router {
    Router::new()
        .merge(automation::router(false))
        .route("/api/context", get(local_context))
        .route("/api/sessions", get(list_sessions))
        .route("/api/sessions/{session_id}", delete(delete_session_local))
        .route("/api/sessions/{session_id}/activity", get(session_activity))
        .route("/api/sessions/{session_id}/files", get(list_files).post(upload_file))
        .route("/api/sessions/{session_id}/files/{file_id}", delete(delete_file_local))
        .route("/api/pairing/start", post(start_pairing))
        .route("/api/devices", get(list_devices))
        .route("/api/devices/{device_id}", delete(revoke_device))
        .route("/api/devices/{device_id}/disconnect", post(disconnect_device))
        .route("/api/settings", get(get_settings).put(put_settings))
        .route("/api/shutdown", post(shutdown_daemon))
        .route("/ws/browser", get(browser_ws))
        .route("/ws/bridge/{session_id}", get(bridge_ws))
        .fallback(get(assets::serve))
        .layer(middleware::from_fn_with_state(state.clone(), require_console_origin))
        .layer(DefaultBodyLimit::max(body_limit()))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

fn remote_router(state: AppState) -> Router {
    Router::new()
        .merge(automation::router(true).layer(middleware::from_fn_with_state(state.clone(), automation::authenticate)))
        .route("/api/context", get(remote_context))
        .route("/api/pairing/claim", post(claim_pairing))
        .route("/api/sessions", get(list_sessions_remote))
        .route("/api/sessions/{session_id}", delete(delete_session_remote))
        .route("/api/sessions/{session_id}/activity", get(session_activity_remote))
        .route("/api/sessions/{session_id}/files", get(list_files_remote).post(upload_file_remote))
        .route("/api/sessions/{session_id}/files/{file_id}", delete(delete_file_remote))
        .route("/ws/browser", get(browser_ws_remote))
        .fallback(get(assets::serve))
        .layer(middleware::from_fn_with_state(state.clone(), require_device_origin))
        .layer(DefaultBodyLimit::max(body_limit()))
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// Normalized `scheme://host[:port]` of an http(s) URL; default ports dropped.
fn origin_of(url: &str) -> Option<String> {
    let url = url.trim().to_ascii_lowercase();
    let (scheme, rest) = url.split_once("://")?;
    let default_port = match scheme {
        "http" => ":80",
        "https" => ":443",
        _ => return None,
    };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let authority = authority.strip_suffix(default_port).unwrap_or(authority);
    Some(format!("{scheme}://{authority}"))
}

fn loopback_origins(addr: &str) -> impl Iterator<Item = String> + '_ {
    let port = addr.rsplit(':').next().unwrap_or_default();
    ["127.0.0.1", "localhost", "[::1]"].into_iter().map(move |host| format!("http://{host}:{port}"))
}

/// Origins a paired-device browser may use: the public address and the loopback device port.
async fn device_origins(state: &AppState) -> Vec<String> {
    let mut origins: Vec<String> = loopback_origins(remote_addr()).collect();
    origins.extend(origin_of(&public_url(state).await));
    origins.extend(state.extra_origins.iter().cloned());
    origins
}

fn forbidden_origin() -> Response {
    (StatusCode::FORBIDDEN, "Origin not allowed. Open Pi Companion from its own address.").into_response()
}

/// `None`: no Origin header; `Some(None)`: present but unusable (`null`, non-http).
fn request_origin(request: &Request) -> Option<Option<String>> {
    request.headers().get(header::ORIGIN).map(|value| value.to_str().ok().and_then(origin_of))
}

/// Strict Origin policy for the paired-device surface. A browser always sends Origin on
/// WebSocket upgrades and on POST/DELETE, so those must carry an allowed one; plain GETs
/// (page loads, same-origin fetches) may omit it, but a foreign Origin is always refused.
async fn require_device_origin(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let upgrade = request.headers().contains_key(header::UPGRADE);
    let safe = matches!(*request.method(), Method::GET | Method::HEAD) && !upgrade;
    let allowed = match request_origin(&request) {
        None => safe,
        Some(None) => false,
        Some(Some(origin)) => device_origins(&state).await.contains(&origin),
    };
    if !allowed {
        return forbidden_origin();
    }
    next.run(request).await
}

/// The console has no credentials, so a web page from any other origin must never reach
/// it (cross-site WebSocket would let it steer Pi). Requests without Origin come from
/// non-browser clients such as the Pi bridge and stay allowed.
async fn require_console_origin(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let allowed = match request_origin(&request) {
        None => true,
        Some(None) => false,
        Some(Some(origin)) => loopback_origins(local_addr()).any(|allowed| allowed == origin) || state.extra_origins.contains(&origin),
    };
    if !allowed {
        return forbidden_origin();
    }
    next.run(request).await
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
    println!("  Console          http://{}", local_addr());
    println!("  Paired devices   http://{}", remote_addr());
    println!("  Pairing links    {public}  ({public_note})");
    println!("  Data             {}  ({devices} paired)", state.data_dir.display());
    println!();
    println!("  Open the console in your browser. Press Ctrl+C to stop.");
    println!();
}

fn body_limit() -> usize {
    (config::MAX_UPLOAD_MB_LIMIT as usize) * 1024 * 1024 + 64 * 1024
}

async fn upload_policy(state: &AppState) -> Value {
    let settings = state.settings.read().await;
    serde_json::json!({ "maxUploadMb": settings.max_upload_mb, "allowedUploadTypes": settings.allowed_upload_types })
}

async fn local_context(State(state): State<AppState>) -> Json<Value> {
    Json(serde_json::json!({ "remote": false, "version": VERSION, "pid": std::process::id(), "uploadPolicy": upload_policy(&state).await }))
}

async fn remote_context(State(state): State<AppState>) -> Json<Value> {
    Json(serde_json::json!({ "remote": true, "version": VERSION, "uploadPolicy": upload_policy(&state).await }))
}

/// Local-admin only. Used by the extension to replace an older daemon after a package upgrade.
async fn shutdown_daemon(State(state): State<AppState>) -> StatusCode {
    let _ = state.shutdown_tx.send(());
    StatusCode::NO_CONTENT
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
    if let Err(error) = config::save(&state.data_dir, &snapshot).await {
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
            "adminUrl": format!("http://{}", local_addr()),
            "deviceUrl": format!("http://{}", remote_addr()),
            "dataDir": state.data_dir.to_string_lossy(),
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

async fn delete_session_local(State(state): State<AppState>, Path(session_id): Path<String>) -> ApiResult<StatusCode> {
    delete_session(&state, &session_id, false).await
}

async fn delete_session_remote(State(state): State<AppState>, Path(session_id): Path<String>, headers: HeaderMap) -> ApiResult<StatusCode> {
    authorize_device(&state, bearer_token(&headers)?).await?;
    delete_session(&state, &session_id, true).await
}

/// Remove only the daemon's record. Pi session history and project files are untouched.
async fn delete_session(state: &AppState, session_id: &str, remote: bool) -> ApiResult<StatusCode> {
    check_session_id(session_id)?;
    let mut sessions = state.sessions.write().await;
    let session = sessions.get(session_id).ok_or((StatusCode::NOT_FOUND, "Session not found.".into()))?;
    if remote && session.snapshot.get("remoteEnabled").and_then(Value::as_bool) != Some(true) {
        return Err((StatusCode::FORBIDDEN, "Remote control is disabled for this session.".into()));
    }
    let status = session.snapshot.get("status").and_then(Value::as_str);
    if session.command_tx.is_some() || !matches!(status, Some("stopped" | "disconnected")) {
        return Err((StatusCode::CONFLICT, "Only disconnected sessions can be archived; active and idle sessions cannot be removed.".into()));
    }
    let remote_enabled = session.snapshot.get("remoteEnabled").and_then(Value::as_bool) == Some(true);
    sessions.remove(session_id);
    state.activity.write().await.remove(session_id);
    // Keep the lock through publication so a concurrent registration cannot be followed
    // by a stale removal event. No filesystem operation is performed by archiving.
    broadcast(state, serde_json::json!({ "type": "session.removed", "sessionId": session_id, "remoteEnabled": remote_enabled }));
    Ok(StatusCode::NO_CONTENT)
}

async fn require_interactive_session(state: &AppState, id: &str) -> ApiResult<()> {
    if state.sessions.read().await.get(id).is_some_and(|s| s.snapshot.get("readOnly").and_then(Value::as_bool) == Some(true)) {
        return Err((StatusCode::FORBIDDEN, "Automation sessions are read-only; only question answers are supported.".into()));
    }
    Ok(())
}

async fn auto_archive(state: &AppState) {
    let cutoff = now_secs().saturating_sub(7 * 24 * 60 * 60);
    let mut sessions = state.sessions.write().await;
    let ids: Vec<String> = sessions.iter().filter(|(_,s)| s.command_tx.is_none()
        && matches!(s.snapshot.get("status").and_then(Value::as_str), Some("stopped" | "disconnected"))
        && s.snapshot.get("disconnectedAt").and_then(Value::as_u64).is_some_and(|at| at < cutoff))
        .map(|(id,_)| id.clone()).collect();
    for id in ids {
        let session = sessions.remove(&id).unwrap();
        state.activity.write().await.remove(&id);
        broadcast(state, serde_json::json!({"type":"session.removed","sessionId":id,"remoteEnabled":session.snapshot.get("remoteEnabled").and_then(Value::as_bool)==Some(true)}));
    }
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
                user_agent: device.user_agent.clone(),
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
        pairings.insert(token, PairingInvite { expires_at, code: compact[0..8].to_string() });
    }

    let qr_svg = QrCode::new(url.as_bytes())
        .map_err(internal_error)?
        .render::<svg::Color>()
        .min_dimensions(220, 220)
        .build();

    Ok(Json(PairingResponse { code, url, qr_svg, expires_at }))
}

/// Uppercase alphanumerics of a typed code (`ab12-cd34`, `AB12 CD34` → `AB12CD34`).
fn normalize_code(code: &str) -> String {
    code.chars().filter(char::is_ascii_alphanumeric).map(|c| c.to_ascii_uppercase()).collect()
}

/// Take the invitation a claim refers to. Typed codes are short, so wrong ones are counted:
/// after CODE_FAILURE_LIMIT misses in the window every open invitation is withdrawn and code
/// claims are refused until the window passes.
async fn take_invite(state: &AppState, claim: &PairClaim) -> ApiResult<PairingInvite> {
    match (claim.invite.as_deref(), claim.code.as_deref()) {
        (Some(invite), None) => state
            .pairings
            .write()
            .await
            .remove(invite)
            .ok_or((StatusCode::UNAUTHORIZED, "Pairing invitation is invalid or already used.".into())),
        (None, Some(code)) => {
            let now = now_secs();
            let mut failures = state.code_failures.lock().await;
            failures.retain(|at| now.saturating_sub(*at) < CODE_FAILURE_WINDOW_SECS);
            if failures.len() >= CODE_FAILURE_LIMIT {
                return Err((StatusCode::TOO_MANY_REQUESTS, "Too many wrong codes. Create a new invitation on the computer later.".into()));
            }
            let code = normalize_code(code);
            let mut pairings = state.pairings.write().await;
            let token = pairings.iter().find(|(_, invite)| code.len() == 8 && invite.code == code).map(|(token, _)| token.clone());
            if let Some(invite) = token.and_then(|token| pairings.remove(&token)) {
                return Ok(invite);
            }
            failures.push(now);
            if failures.len() >= CODE_FAILURE_LIMIT {
                pairings.clear();
                tracing::warn!("too many wrong pairing codes; withdrew all open invitations");
            }
            Err((StatusCode::UNAUTHORIZED, "That code is not valid or has already been used.".into()))
        }
        _ => Err((StatusCode::BAD_REQUEST, "Send either an invitation or a pairing code.".into())),
    }
}

async fn claim_pairing(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(claim): Json<PairClaim>,
) -> ApiResult<Json<PairClaimResponse>> {
    let name = claim.device_name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err((StatusCode::BAD_REQUEST, "Device name must be 1-80 characters.".into()));
    }

    let invite = take_invite(&state, &claim).await?;
    if invite.expires_at < now_secs() {
        return Err((StatusCode::UNAUTHORIZED, "Pairing invitation expired.".into()));
    }

    let user_agent: String = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .chars()
        .take(160)
        .collect();
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
            user_agent,
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

async fn session_activity(State(state): State<AppState>, Path(session_id): Path<String>) -> ApiResult<Json<Value>> {
    if !state.sessions.read().await.contains_key(&session_id) {
        return Err((StatusCode::NOT_FOUND, "Session not found.".into()));
    }
    Ok(Json(state.activity.read().await.snapshot(&session_id)))
}

async fn session_activity_remote(
    State(state): State<AppState>,
    Path(session_id): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    authorize_device(&state, bearer_token(&headers)?).await?;
    require_remote_session(&state, &session_id).await?;
    Ok(Json(state.activity.read().await.snapshot(&session_id)))
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

/// Session ids come from URL paths and become directory names: allow only a safe alphabet.
fn valid_session_id(session_id: &str) -> bool {
    (1..=64).contains(&session_id.len())
        && session_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn check_session_id(session_id: &str) -> ApiResult<()> {
    if valid_session_id(session_id) { Ok(()) } else { Err((StatusCode::BAD_REQUEST, "Invalid session id.".into())) }
}

/// Last path component of a client file name, without separators or control characters.
fn safe_file_name(original: &str) -> String {
    let last = original.rsplit(['/', '\\']).next().unwrap_or_default();
    let cleaned: String = last.chars().filter(|c| !c.is_control()).take(120).collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    if trimmed.is_empty() { "upload.bin".to_string() } else { trimmed.to_string() }
}

/// MIME type an upload is judged by: guessed from the file name, falling back to the
/// declared Content-Type. With an allowlist, both the guess and any specific declared type
/// must be allowed, so a renamed file cannot slip through on either side.
fn upload_mime(settings: &Settings, name: &str, declared: Option<&str>) -> ApiResult<String> {
    let guessed = mime_guess::from_path(name).first().map(|mime| mime.essence_str().to_string());
    let declared = declared
        .map(|value| value.split(';').next().unwrap_or_default().trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "application/octet-stream");
    let mime = guessed.clone().or(declared.clone()).unwrap_or_else(|| "application/octet-stream".into());
    let allowed = settings.allows_upload_type(&mime)
        && declared.as_deref().is_none_or(|value| settings.allows_upload_type(value));
    if !allowed {
        return Err((StatusCode::UNSUPPORTED_MEDIA_TYPE, format!("Files of type {mime} are not allowed here.")));
    }
    Ok(mime)
}

async fn store_upload(state: &AppState, session_id: &str, mut multipart: Multipart) -> ApiResult<TempFile> {
    require_interactive_session(state, session_id).await?;
    check_session_id(session_id)?;
    if !state.sessions.read().await.contains_key(session_id) {
        return Err((StatusCode::NOT_FOUND, "Session not found.".into()));
    }

    let settings = state.settings.read().await.clone();
    let max_bytes = (settings.max_upload_mb as usize) * 1024 * 1024;
    while let Some(mut field) = multipart.next_field().await.map_err(bad_upload)? {
        if field.name() != Some("file") {
            continue;
        }

        let safe_name = safe_file_name(field.file_name().unwrap_or("upload.bin"));
        let mime = upload_mime(&settings, &safe_name, field.content_type())?;

        let session_dir = state.temp_root.join(session_id);
        fs::create_dir_all(&session_dir).await.map_err(internal_error)?;
        set_private_dir_permissions(&session_dir).await;

        let id = Uuid::new_v4().to_string();
        let disk_path = session_dir.join(format!("{}-{}", id, safe_name));
        let mut output = fs::File::create(&disk_path).await.map_err(internal_error)?;
        let mut size: usize = 0;

        let written: ApiResult<()> = async {
            while let Some(chunk) = field.chunk().await.map_err(bad_upload)? {
                size += chunk.len();
                if size > max_bytes {
                    return Err((
                        StatusCode::PAYLOAD_TOO_LARGE,
                        format!("File is larger than the {} MiB limit.", max_bytes / 1024 / 1024),
                    ));
                }
                output.write_all(&chunk).await.map_err(internal_error)?;
            }
            output.flush().await.map_err(internal_error)
        }
        .await;
        drop(output);
        if let Err(error) = written {
            let _ = fs::remove_file(&disk_path).await;
            return Err(error);
        }

        let file = TempFile {
            id,
            name: safe_name,
            path: disk_path.to_string_lossy().to_string(),
            size: size as u64,
            mime,
            created_at: now_secs(),
        };
        state.files.write().await.entry(session_id.to_string()).or_default().push(file.clone());
        notify_session_files(state, session_id).await;
        return Ok(file);
    }

    Err((StatusCode::BAD_REQUEST, "Expected multipart field named file.".into()))
}

/// Multipart stream errors: the body limit surfaces here as well.
fn bad_upload(error: axum::extract::multipart::MultipartError) -> ApiError {
    let status = error.status();
    if status == StatusCode::PAYLOAD_TOO_LARGE {
        return (status, "File is larger than the upload limit.".into());
    }
    (status, error.body_text())
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
    check_session_id(session_id)?;
    require_interactive_session(state, session_id).await?;
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
    if value.get("type").and_then(Value::as_str) == Some("session.removed") {
        return value.get("remoteEnabled").and_then(Value::as_bool) == Some(true);
    }
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
        // Subscribe before prompting the client to refresh: registrations during its
        // initial HTTP fetch must not disappear between the fetch and socket upgrade.
        if sender.send(Message::Text(serde_json::json!({ "type": "resync" }).to_string().into())).await.is_err() { return; }
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    // Browsers automatically pong at the protocol level. The text frame
                    // also lets the UI detect a silent/half-open socket in JavaScript.
                    if sender.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                    if sender.send(Message::Text(serde_json::json!({ "type": "ping" }).to_string().into())).await.is_err() { break; }
                }
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
                    // A slow tab missed some events; tell it to re-fetch state so nothing it
                    // missed (a question, a status change) waits for the next reconnect.
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let resync = serde_json::json!({ "type": "resync" }).to_string();
                        if sender.send(Message::Text(resync.into())).await.is_err() { break; }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                },
            }
        }
    });

    let mut kicked = false;
    let mut last_received = tokio::time::Instant::now();
    let mut liveness = tokio::time::interval(Duration::from_secs(15));
    loop {
        tokio::select! {
            _ = &mut send_task => break,
            _ = liveness.tick() => {
                if last_received.elapsed() >= Duration::from_secs(45) { break; }
            }
            message = receiver.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    last_received = tokio::time::Instant::now();
                    forward_browser_command(&state, &text, remote).await;
                }
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => { last_received = tokio::time::Instant::now(); }
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
    if session.snapshot.get("readOnly").and_then(Value::as_bool) == Some(true)
        && !matches!(envelope.command.get("type").and_then(Value::as_str), Some("ask_answer" | "ask_cancel")) { return; }
    let Some(command_tx) = &session.command_tx else { return };
    if command_tx.send(serde_json::json!({ "type": "command", "command": envelope.command.clone() })).is_err() { return; }
    // Show what was sent on every open companion (and after a reload), not just the sender's tab.
    if let Some(entry) = activity::user_message(&envelope.command) {
        let mut log = state.activity.write().await;
        let message = log.record(&envelope.session_id, entry);
        broadcast(state, serde_json::json!({ "type": "bridge.event", "sessionId": envelope.session_id, "message": message }));
    }
}

async fn bridge_ws(
    ws: WebSocketUpgrade,
    Path(session_id): Path<String>,
    State(state): State<AppState>,
) -> ApiResult<impl IntoResponse> {
    check_session_id(&session_id)?;
    Ok(ws.on_upgrade(move |socket| bridge_socket(socket, session_id, state)))
}

async fn bridge_socket(socket: WebSocket, session_id: String, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let (command_tx, mut command_rx) = mpsc::unbounded_channel::<Value>();
    let mut send_task = tokio::spawn(async move {
        let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
        loop {
            tokio::select! {
                _ = heartbeat.tick() => {
                    if sender.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                }
                command = command_rx.recv() => {
                    let Some(command) = command else { break };
                    if sender.send(Message::Text(command.to_string().into())).await.is_err() { break; }
                }
            }
        }
    });

    let mut last_received = tokio::time::Instant::now();
    let mut liveness = tokio::time::interval(Duration::from_secs(15));
    loop {
        let message = tokio::select! {
            _ = &mut send_task => break,
            _ = liveness.tick() => {
                if last_received.elapsed() >= Duration::from_secs(45) { break; }
                continue;
            }
            message = receiver.next() => message,
        };
        let text = match message {
            Some(Ok(Message::Text(text))) => text,
            Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
            Some(Ok(_)) => { last_received = tokio::time::Instant::now(); continue; }
        };
        last_received = tokio::time::Instant::now();
        let Ok(value) = serde_json::from_str::<Value>(&text) else { continue };
        // An old socket can finish closing after a replacement already registered:
        // once retired it may never act for the session again, so drop it.
        if value.get("type").and_then(Value::as_str) != Some("register") {
            let sessions = state.sessions.read().await;
            let owns_session = sessions.get(&session_id).and_then(|s| s.command_tx.as_ref())
                .is_some_and(|tx| tx.same_channel(&command_tx));
            if !owns_session { break; }
        }
        match value.get("type").and_then(Value::as_str) {
            Some("register") => {
                let snapshot = value.get("session").cloned().unwrap_or(Value::Null);
                {
                    let mut sessions = state.sessions.write().await;
                    sessions.insert(session_id.clone(), Session { snapshot: snapshot.clone(), command_tx: Some(command_tx.clone()) });
                    broadcast(&state, serde_json::json!({ "type": "session.register", "session": snapshot }));
                }
                notify_session_files(&state, &session_id).await;
            }
            Some("session.update") => {
                // Validate ownership under the same lock as mutation/publication:
                // a retired socket must never stop or hide its replacement.
                let mut sessions = state.sessions.write().await;
                let Some(session) = sessions.get_mut(&session_id) else { break };
                if !session.command_tx.as_ref().is_some_and(|tx| tx.same_channel(&command_tx)) { break; }
                if let (Some(patch), Some(snapshot)) = (value.get("session").and_then(Value::as_object), session.snapshot.as_object_mut()) {
                    for (key, value) in patch {
                        snapshot.insert(key.clone(), value.clone());
                    }
                    broadcast(&state, serde_json::json!({
                        "type": "session.update",
                        "sessionId": session_id,
                        "patch": patch
                    }));
                }
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
                // Hold the log lock while publishing so seq order matches broadcast order.
                let mut log = state.activity.write().await;
                let message = if activity::is_activity(&value) { log.record(&session_id, value) } else { value };
                broadcast(&state, serde_json::json!({
                    "type": "bridge.event",
                    "sessionId": session_id,
                    "message": message
                }));
            }
        }
    }

    let stopped = {
        let mut sessions = state.sessions.write().await;
        if let Some(session) = sessions.get_mut(&session_id)
            && session.command_tx.as_ref().is_some_and(|tx| tx.same_channel(&command_tx)) {
            if let Some(snapshot) = session.snapshot.as_object_mut() {
                snapshot.insert("status".into(), Value::String("stopped".into()));
                snapshot.insert("disconnectedAt".into(), Value::from(now_secs()));
            }
            session.command_tx = None;
            broadcast(&state, serde_json::json!({
                "type": "session.update", "sessionId": session_id, "patch": { "status": "stopped" }
            }));
            true
        } else { false }
    };
    send_task.abort();
    if !stopped { return; }

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
