//! Local, persisted automation definitions and bounded run history.
use super::*;
use chrono::{Datelike, Timelike};
use std::process::Stdio;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
};

const OUTPUT_LIMIT: usize = 128 * 1024;
const HISTORY_LIMIT: usize = 100;
#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    Command {
        command: String,
        #[serde(default)]
        args: Vec<String>,
        cwd: Option<String>,
        #[serde(rename = "timeoutSeconds")]
        timeout_seconds: Option<u64>,
    },
    Pi {
        prompt: String,
        cwd: String,
        #[serde(rename = "timeoutSeconds")]
        timeout_seconds: Option<u64>,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Definition {
    #[serde(default)]
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub preconditions: Vec<Action>,
    pub actions: Vec<Action>,
    #[serde(default)]
    pub post_actions: Vec<Action>,
    #[serde(default)]
    pub schedule: Option<String>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub automation_id: String,
    pub started_at: u64,
    pub finished_at: Option<u64>,
    pub status: String,
    pub result: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}
#[derive(Default, Serialize, Deserialize)]
struct Persisted {
    definitions: Vec<Definition>,
    runs: Vec<Run>,
}
#[derive(Default)]
pub struct Store {
    data: Persisted,
    active: HashMap<String, watch::Sender<bool>>,
    last_minute: Option<u64>,
}
fn bad(message: impl Into<String>) -> ApiError {
    (StatusCode::BAD_REQUEST, message.into())
}
struct Schedule {
    fields: [Vec<u32>; 5],
    any_dom: bool,
    any_dow: bool,
}
impl Schedule {
    fn matches(&self, at: chrono::DateTime<chrono::Utc>) -> bool {
        let dom = self.fields[2].contains(&at.day());
        let dow = self.fields[4].contains(&at.weekday().num_days_from_sunday());
        self.fields[0].contains(&at.minute())
            && self.fields[1].contains(&at.hour())
            && self.fields[3].contains(&at.month())
            && if self.any_dom || self.any_dow {
                dom && dow
            } else {
                dom || dow
            }
    }
}
fn schedule(value: &str) -> Result<Schedule, ApiError> {
    let raw: Vec<_> = value.split_whitespace().collect();
    if raw.len() != 5 || value.len() > 256 {
        return Err(bad("Schedule must have five UTC cron fields."));
    }
    let bounds = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 7)];
    let mut fields: [Vec<u32>; 5] = Default::default();
    for (index, text) in raw.iter().enumerate() {
        let (min, max) = bounds[index];
        for item in text.split(',') {
            let parts: Vec<_> = item.split('/').collect();
            if parts.len() > 2 {
                return Err(bad("Invalid cron step."));
            }
            let number = |s: &str| {
                s.parse::<u32>()
                    .map_err(|_| bad("Cron fields must use numbers, *, ranges, lists, or steps."))
            };
            let step = if parts.len() == 2 {
                number(parts[1])?
            } else {
                1
            };
            if step == 0 || step > max - min + 1 {
                return Err(bad("Invalid cron step."));
            }
            let (start, end) = if parts[0] == "*" {
                (min, max)
            } else if let Some((a, b)) = parts[0].split_once('-') {
                (number(a)?, number(b)?)
            } else {
                let n = number(parts[0])?;
                (n, if parts.len() == 2 { max } else { n })
            };
            if start < min || end > max || start > end {
                return Err(bad("Cron field out of range."));
            }
            for n in (start..=end).step_by(step as usize) {
                let n = if index == 4 && n == 7 { 0 } else { n };
                if !fields[index].contains(&n) {
                    fields[index].push(n);
                }
            }
        }
        if fields[index].is_empty() {
            return Err(bad("Empty cron field."));
        }
    }
    Ok(Schedule {
        fields,
        any_dom: raw[2].starts_with('*'),
        any_dow: raw[4].starts_with('*'),
    })
}
fn validate(d: &Definition) -> ApiResult<()> {
    if d.name.trim().is_empty() || d.name.len() > 120 {
        return Err(bad("Name must contain 1–120 characters."));
    }
    if d.actions.is_empty() || d.preconditions.len() + d.actions.len() + d.post_actions.len() > 50 {
        return Err(bad("Provide 1–50 actions."));
    }
    if let Some(s) = &d.schedule {
        schedule(s)?;
    }
    for a in d
        .preconditions
        .iter()
        .chain(&d.actions)
        .chain(&d.post_actions)
    {
        let (text, cwd, timeout) = match a {
            Action::Command {
                command,
                args,
                cwd,
                timeout_seconds,
            } => {
                if args.len() > 100 || args.iter().any(|a| a.len() > 16384 || a.contains('\0')) {
                    return Err(bad("Invalid command arguments."));
                }
                (command, cwd.as_deref(), timeout_seconds)
            }
            Action::Pi {
                prompt,
                cwd,
                timeout_seconds,
            } => (prompt, Some(cwd.as_str()), timeout_seconds),
        };
        if text.trim().is_empty() || text.len() > 65536 || text.contains('\0') {
            return Err(bad("Invalid action."));
        }
        if cwd.is_some_and(|p| !FsPath::new(p).is_absolute() || p.contains('\0')) {
            return Err(bad("Working directory must be absolute."));
        }
        if timeout.is_some_and(|t| t == 0 || t > 86400) {
            return Err(bad("Timeout must be 1–86400 seconds."));
        }
    }
    Ok(())
}
async fn persist(state: &AppState, store: &Store) -> ApiResult<()> {
    fs::create_dir_all(&state.data_dir)
        .await
        .map_err(internal_error)?;
    let bytes = serde_json::to_vec(&store.data).map_err(internal_error)?;
    let path = state.data_dir.join("automations.json");
    let tmp = state
        .data_dir
        .join(format!("automations-{}.tmp", Uuid::new_v4()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&state.data_dir, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(internal_error)?;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp).await.map_err(internal_error)?;
    let result: std::io::Result<()> = async {
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        drop(file);
        fs::rename(&tmp, path).await
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&tmp).await;
    }
    result.map_err(internal_error)
}
pub async fn initialize(state: &AppState) -> ApiResult<()> {
    let mut store = state.automations.lock().await;
    match fs::read(state.data_dir.join("automations.json")).await {
        Ok(bytes) => {
            store.data = serde_json::from_slice(&bytes).map_err(internal_error)?;
            for d in &store.data.definitions {
                validate(d)?;
            }
            for r in &mut store.data.runs {
                if r.status == "running" {
                    r.status = "failed".into();
                    r.finished_at = Some(now_secs());
                    r.result.push_str("\nDaemon restarted before completion.");
                }
            }
            persist(state, &store).await?;
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(internal_error(e)),
    }
    Ok(())
}
pub fn router(remote: bool) -> Router<AppState> {
    let router = Router::new()
        .route("/api/automations", get(list))
        .route("/api/automations/{id}", get(detail))
        .route("/api/automations/{id}/start", post(start))
        .route("/api/automations/{id}/stop", post(stop))
        .route("/api/automations/{id}/runs", get(runs))
        .route("/api/automations/{id}/runs/{run}", get(run_detail));
    if remote {
        router
    } else {
        router.route("/api/automations", post(create)).route(
            "/api/automations/{id}",
            axum::routing::put(update).delete(remove),
        )
    }
}
pub async fn authenticate(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let result = match bearer_token(request.headers()) {
        Ok(token) => authorize_device(&state, token).await.map(|_| ()),
        Err(e) => Err(e),
    };
    match result {
        Ok(()) => next.run(request).await,
        Err(e) => e.into_response(),
    }
}
async fn list(State(state): State<AppState>) -> Json<Value> {
    Json(serde_json::json!({"automations":state.automations.lock().await.data.definitions}))
}
async fn detail(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Definition>> {
    state
        .automations
        .lock()
        .await
        .data
        .definitions
        .iter()
        .find(|d| d.id == id)
        .cloned()
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "Automation not found.".into()))
}
async fn create(
    State(state): State<AppState>,
    Json(mut d): Json<Definition>,
) -> ApiResult<Json<Definition>> {
    validate(&d)?;
    d.id = Uuid::new_v4().to_string();
    d.created_at = now_secs();
    d.updated_at = d.created_at;
    let mut store = state.automations.lock().await;
    if store.data.definitions.len() >= 200 {
        return Err(bad("Maximum 200 automations."));
    }
    store.data.definitions.push(d.clone());
    if let Err(e) = persist(&state, &store).await {
        store.data.definitions.pop();
        return Err(e);
    }
    Ok(Json(d))
}
async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(mut d): Json<Definition>,
) -> ApiResult<Json<Definition>> {
    validate(&d)?;
    let mut store = state.automations.lock().await;
    let i = store
        .data
        .definitions
        .iter()
        .position(|d| d.id == id)
        .ok_or((StatusCode::NOT_FOUND, "Automation not found.".into()))?;
    let old = store.data.definitions[i].clone();
    d.id = id;
    d.created_at = old.created_at;
    d.updated_at = now_secs();
    store.data.definitions[i] = d.clone();
    if let Err(e) = persist(&state, &store).await {
        store.data.definitions[i] = old;
        return Err(e);
    }
    Ok(Json(d))
}
async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let mut store = state.automations.lock().await;
    if store.active.contains_key(&id) {
        return Err((
            StatusCode::CONFLICT,
            "Stop the automation before deleting it.".into(),
        ));
    }
    let i = store
        .data
        .definitions
        .iter()
        .position(|d| d.id == id)
        .ok_or((StatusCode::NOT_FOUND, "Automation not found.".into()))?;
    let old = store.data.definitions.remove(i);
    let old_runs = store.data.runs.clone();
    store.data.runs.retain(|run| run.automation_id != id);
    if let Err(e) = persist(&state, &store).await {
        store.data.definitions.insert(i, old);
        store.data.runs = old_runs;
        return Err(e);
    }
    Ok(StatusCode::NO_CONTENT)
}
async fn runs(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let store = state.automations.lock().await;
    if !store.data.definitions.iter().any(|d| d.id == id) {
        return Err((StatusCode::NOT_FOUND, "Automation not found.".into()));
    }
    let mut runs: Vec<_> = store
        .data
        .runs
        .iter()
        .filter(|r| r.automation_id == id)
        .cloned()
        .collect();
    runs.reverse();
    Ok(Json(serde_json::json!({"runs":runs})))
}
async fn run_detail(
    State(state): State<AppState>,
    Path((id, run)): Path<(String, String)>,
) -> ApiResult<Json<Run>> {
    state
        .automations
        .lock()
        .await
        .data
        .runs
        .iter()
        .find(|r| r.automation_id == id && r.id == run)
        .cloned()
        .map(Json)
        .ok_or((StatusCode::NOT_FOUND, "Run not found.".into()))
}
async fn start(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<Run>> {
    launch(state, id).await.map(Json)
}
async fn stop(State(state): State<AppState>, Path(id): Path<String>) -> ApiResult<StatusCode> {
    let store = state.automations.lock().await;
    if !store.data.definitions.iter().any(|d| d.id == id) {
        return Err((StatusCode::NOT_FOUND, "Automation not found.".into()));
    }
    if let Some(tx) = store.active.get(&id) {
        let _ = tx.send(true);
    }
    Ok(StatusCode::NO_CONTENT)
}
async fn launch(state: AppState, id: String) -> ApiResult<Run> {
    let mut store = state.automations.lock().await;
    let d = store
        .data
        .definitions
        .iter()
        .find(|d| d.id == id)
        .cloned()
        .ok_or((StatusCode::NOT_FOUND, "Automation not found.".into()))?;
    if store.active.contains_key(&id) {
        return Err((
            StatusCode::CONFLICT,
            "Automation is already running.".into(),
        ));
    }
    let run = Run {
        id: Uuid::new_v4().to_string(),
        automation_id: id.clone(),
        started_at: now_secs(),
        finished_at: None,
        status: "running".into(),
        result: String::new(),
        session_id: None,
    };
    let (tx, rx) = watch::channel(false);
    store.active.insert(id.clone(), tx);
    store.data.runs.push(run.clone());
    if let Err(e) = persist(&state, &store).await {
        store.active.remove(&id);
        store.data.runs.pop();
        return Err(e);
    }
    drop(store);
    let run_id = run.id.clone();
    tokio::spawn(async move {
        execute(state, d, run_id, rx).await;
    });
    Ok(run)
}
fn append(out: &mut String, text: &str) {
    let left = OUTPUT_LIMIT.saturating_sub(out.len());
    let mut end = text.len().min(left);
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    out.push_str(&text[..end]);
}
async fn drain<R: tokio::io::AsyncRead + Unpin>(mut reader: R) -> String {
    let mut bytes = Vec::new();
    let mut buf = [0u8; 4096];
    while let Ok(n) = reader.read(&mut buf).await {
        if n == 0 {
            break;
        }
        let keep = n.min(OUTPUT_LIMIT.saturating_sub(bytes.len()));
        bytes.extend_from_slice(&buf[..keep]);
        // Keep draining after the capture limit so child processes never block on a full pipe.
    }
    let mut output = String::new();
    append(&mut output, &String::from_utf8_lossy(&bytes));
    output
}
async fn execute(
    state: AppState,
    d: Definition,
    run_id: String,
    mut cancel: watch::Receiver<bool>,
) {
    let mut result = String::new();
    let mut status = "succeeded";
    for (phase, actions) in [
        ("precondition", &d.preconditions),
        ("action", &d.actions),
        ("post-action", &d.post_actions),
    ] {
        if phase == "action" && status != "succeeded" {
            continue;
        }
        for action in actions {
            if *cancel.borrow() {
                status = "stopped";
                break;
            }
            append(&mut result, &format!("\n[{phase}]\n"));
            match execute_action(&state, &d.id, &run_id, action, &mut cancel).await {
                Ok(text) => append(&mut result, &text),
                Err((kind, text)) => {
                    append(&mut result, &text);
                    status = if kind == "stopped" {
                        "stopped"
                    } else if phase == "precondition" {
                        "skipped"
                    } else {
                        "failed"
                    };
                    break;
                }
            }
        }
        // Finalize failures/skips too, but cancellation stops everything.
        if status == "stopped" {
            break;
        }
    }
    let mut store = state.automations.lock().await;
    if let Some(run) = store.data.runs.iter_mut().find(|r| r.id == run_id) {
        run.result = result;
        run.status = status.into();
        run.finished_at = Some(now_secs());
    }
    store.active.remove(&d.id);
    let mut count = 0;
    store.data.runs.reverse();
    store.data.runs.retain(|r| {
        if r.automation_id == d.id {
            count += 1;
            count <= HISTORY_LIMIT
        } else {
            true
        }
    });
    store.data.runs.reverse();
    if let Err((_, e)) = persist(&state, &store).await {
        tracing::error!("Cannot persist automation completion: {e}");
    }
}
async fn execute_action(
    state: &AppState,
    id: &str,
    run: &str,
    a: &Action,
    cancel: &mut watch::Receiver<bool>,
) -> Result<String, (&'static str, String)> {
    execute_action_program(state, id, run, a, cancel, FsPath::new("pi")).await
}
async fn execute_action_program(
    state: &AppState,
    id: &str,
    run: &str,
    a: &Action,
    cancel: &mut watch::Receiver<bool>,
    pi_program: &FsPath,
) -> Result<String, (&'static str, String)> {
    if *cancel.borrow() {
        return Err(("stopped", "Stopped by user.".into()));
    }
    let (mut cmd, timeout) = match a {
        Action::Command {
            command,
            args,
            cwd,
            timeout_seconds,
        } => {
            let mut c = Command::new(command);
            c.args(args);
            if let Some(cwd) = cwd {
                c.current_dir(cwd);
            }
            (c, timeout_seconds.unwrap_or(3600))
        }
        Action::Pi {
            prompt,
            cwd,
            timeout_seconds,
        } => {
            let mut c = Command::new(pi_program);
            c.args(["--mode", "rpc", "--no-session"]);
            c.current_dir(cwd);
            c.env("PI_COMPANION_AUTOMATION_ID", id)
                .env("PI_COMPANION_AUTOMATION_RUN_ID", run)
                .env("PI_COMPANION_ADMIN_ADDR", local_addr());
            let _ = prompt;
            (c, timeout_seconds.unwrap_or(3600))
        }
    };
    let is_pi = matches!(a, Action::Pi { .. });
    cmd.stdin(if is_pi { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
    #[cfg(unix)]
    cmd.process_group(0);
    let mut child = cmd.spawn().map_err(|e| ("failed", e.to_string()))?;
    let pid = child.id();
    let mut stdin = child.stdin.take();
    let prompt_record = if let Action::Pi { prompt, .. } = a {
        Some(format!(
            "{}\n",
            serde_json::json!({"id":"automation-prompt","type":"prompt","message":prompt})
        ))
    } else {
        None
    };
    // Read both streams continuously; only agent_settled completes a Pi action.
    let stdout = child.stdout.take().unwrap();
    let stderr = tokio::spawn(drain(child.stderr.take().unwrap()));
    let session_id = Uuid::new_v4().to_string();
    let (tx, mut commands) = mpsc::unbounded_channel::<Value>();
    if let Action::Pi { cwd, .. } = a {
        let snapshot = serde_json::json!({"id":session_id,"name":"Automation", "shortTitle":"Automation run", "cwd":cwd,"pid":pid,"status":"active","remoteEnabled":true,"readOnly":true,"automationId":id,"automationRunId":run,"connectedAt":chrono::Utc::now().to_rfc3339(),"asks":[]});
        state.sessions.write().await.insert(
            session_id.clone(),
            Session {
                snapshot: snapshot.clone(),
                command_tx: Some(tx),
            },
        );
        broadcast(
            state,
            serde_json::json!({"type":"session.register","session":snapshot}),
        );
        let mut store = state.automations.lock().await;
        if let Some(r) = store.data.runs.iter_mut().find(|r| r.id == run) {
            r.session_id = Some(session_id.clone());
        }
        let _ = persist(state, &store).await;
    }
    let reader_state = state.clone();
    let reader_session = session_id.clone();
    let output = tokio::spawn(async move {
        if !is_pi {
            return (drain(stdout).await, false);
        }
        if let (Some(record), Some(input)) = (prompt_record, stdin.as_mut()) {
            if let Err(error) = input.write_all(record.as_bytes()).await {
                return (error.to_string(), false);
            }
        }
        use tokio::io::{AsyncBufReadExt, BufReader};
        let mut lines = BufReader::new(stdout).lines();
        let mut result = String::new();
        let mut asks: HashMap<String, String> = HashMap::new();
        let mut failed = false;
        let mut ask_deadlines: HashMap<String, tokio::time::Instant> = HashMap::new();
        loop {
            let next_ask_deadline = ask_deadlines
                .values()
                .min()
                .copied()
                .unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(86400));
            let line = tokio::select! {
                _=tokio::time::sleep_until(next_ask_deadline)=>{
                    let expired:Vec<_>=ask_deadlines.iter().filter(|(_,at)|**at<=tokio::time::Instant::now()).map(|(id,_)|id.clone()).collect();
                    for id in expired {ask_deadlines.remove(&id);asks.remove(&id);clear_ask(&reader_state,&reader_session,&id).await;}continue;
                }
                line=lines.next_line()=>match line{Ok(Some(line))=>line,_=>break},
                command=commands.recv()=>{
                    let Some(command)=command else{break};let command=&command["command"];
                    let request=command["requestId"].as_str().unwrap_or_default();
                    if let Some(method)=asks.remove(request){
                        ask_deadlines.remove(request);
                        let answer=command["answers"][request].as_array().and_then(|a|a.first()).and_then(Value::as_str).unwrap_or_default();
                        let response=if command["type"]=="ask_cancel"{serde_json::json!({"type":"extension_ui_response","id":request,"cancelled":true})}
                        else if method=="confirm"{serde_json::json!({"type":"extension_ui_response","id":request,"confirmed":answer=="Yes"})}
                        else{serde_json::json!({"type":"extension_ui_response","id":request,"value":answer})};
                        if let Some(input)=stdin.as_mut(){let _=input.write_all(format!("{response}\n").as_bytes()).await;}
                        clear_ask(&reader_state,&reader_session,request).await;
                    }continue;
                }
            };
            if let Ok(event) = serde_json::from_str::<Value>(&line) {
                if event["type"] == "extension_ui_request" {
                    let method = event["method"].as_str().unwrap_or_default();
                    let request = event["id"].as_str().unwrap_or_default();
                    if matches!(method, "select" | "input" | "editor" | "confirm") {
                        asks.insert(request.into(), method.into());
                        if let Some(timeout) = event["timeout"].as_u64() {
                            ask_deadlines.insert(
                                request.into(),
                                tokio::time::Instant::now()
                                    + Duration::from_millis(timeout.min(86400000)),
                            );
                        }
                        let options = if method == "confirm" {
                            vec![
                                serde_json::json!({"label":"Yes"}),
                                serde_json::json!({"label":"No"}),
                            ]
                        } else {
                            event["options"]
                                .as_array()
                                .map(|a| a.iter().map(|v| serde_json::json!({"label":v})).collect())
                                .unwrap_or_default()
                        };
                        let ask = serde_json::json!({"requestId":request,"source":if method=="editor"{"input"}else{method},"title":event["title"],"createdAt":chrono::Utc::now().to_rfc3339(),"questions":[{"id":request,"question":event["message"].as_str().or(event["title"].as_str()).unwrap_or("Question"),"options":options,"allowCustom":matches!(method,"input"|"editor"),"placeholder":event["placeholder"]}]});
                        let mut sessions = reader_state.sessions.write().await;
                        if let Some(s) = sessions.get_mut(&reader_session) {
                            let list = s.snapshot["asks"].as_array_mut().unwrap();
                            list.push(ask);
                            let patch = serde_json::json!({"asks":list});
                            broadcast(
                                &reader_state,
                                serde_json::json!({"type":"session.update","sessionId":reader_session,"patch":patch}),
                            );
                        }
                    }
                }
                if matches!(
                    event["type"].as_str(),
                    Some("tool_execution_start" | "tool_execution_end")
                ) {
                    let start = event["type"] == "tool_execution_start";
                    let result = event["result"]["content"]
                        .as_array()
                        .map(|parts| {
                            parts
                                .iter()
                                .filter_map(|part| part["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_else(|| event["result"].to_string());
                    let payload = if start {
                        serde_json::json!({"toolCallId":event["toolCallId"],"toolName":event["toolName"],"input":event["args"],"args":event["args"].to_string()})
                    } else {
                        serde_json::json!({"toolCallId":event["toolCallId"],"toolName":event["toolName"],"result":result,"isError":event["isError"]})
                    };
                    let message = serde_json::json!({"type":"event","event":if start{"tool.start"}else{"tool.end"},"payload":payload});
                    let message = reader_state
                        .activity
                        .write()
                        .await
                        .record(&reader_session, message);
                    broadcast(
                        &reader_state,
                        serde_json::json!({"type":"bridge.event","sessionId":reader_session,"message":message}),
                    );
                }
                if event["type"] == "message_update"
                    && event["assistantMessageEvent"]["type"] == "text_delta"
                {
                    let message = serde_json::json!({"type":"event","event":"assistant.delta","payload":{"kind":"text","delta":event["assistantMessageEvent"]["delta"]}});
                    let message = reader_state
                        .activity
                        .write()
                        .await
                        .record(&reader_session, message);
                    broadcast(
                        &reader_state,
                        serde_json::json!({"type":"bridge.event","sessionId":reader_session,"message":message}),
                    );
                }
                if event["type"] == "message_end" && event["message"]["role"] == "assistant" {
                    result.clear();
                    if let Some(parts) = event["message"]["content"].as_array() {
                        for p in parts {
                            if let Some(text) = p["text"].as_str() {
                                append(&mut result, text);
                                append(&mut result, "\n");
                            }
                        }
                    }
                    failed = matches!(
                        event["message"]["stopReason"].as_str(),
                        Some("error" | "aborted")
                    );
                }
                if event["type"] == "agent_settled" {
                    return (result, !failed);
                }
                if event["type"] == "response" && event["success"] == false {
                    append(&mut result, &line);
                    return (result, false);
                }
                if event["type"] == "response"
                    && event["command"] == "prompt"
                    && event["data"]["disposition"] == "handled"
                {
                    return (result, true);
                }
            }
        }
        (result, false)
    });
    let mut output = output;
    let outcome = tokio::select! {
        _=cancel.changed()=>Err(("stopped","Stopped by user.".into())),
        _=tokio::time::sleep_until(deadline)=>Err(("failed","Action timed out.".into())),
        value=&mut output=>{
            let (text,finished)=value.unwrap_or_default();
            if is_pi {if finished{Ok(text)}else{Err(("failed",text))}}
            else {tokio::select!{ _=cancel.changed()=>Err(("stopped","Stopped by user.".into())), _=tokio::time::sleep_until(deadline)=>Err(("failed","Action timed out.".into())), status=child.wait()=>match status {Ok(s) if s.success()=>Ok(text),Ok(s)=>Err(("failed",format!("{text}\nExit status: {s}"))),Err(e)=>Err(("failed",e.to_string()))}}}
        }
    };
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    if let Some(pid) = pid {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status()
            .await;
    }
    let _ = child.kill().await;
    let _ = child.wait().await;
    output.abort();
    if is_pi {
        let mut sessions = state.sessions.write().await;
        if let Some(s) = sessions.get_mut(&session_id) {
            s.command_tx = None;
            s.snapshot["status"] = Value::from("stopped");
            s.snapshot["asks"] = serde_json::json!([]);
            s.snapshot["disconnectedAt"] = Value::from(now_secs());
            broadcast(
                state,
                serde_json::json!({"type":"session.update","sessionId":session_id,"patch":{"status":"stopped","asks":[]}}),
            );
        }
    }
    let error = tokio::time::timeout(Duration::from_secs(2), stderr)
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or_default();
    let _ = state;
    match outcome {
        Ok(mut text) => {
            append(&mut text, &error);
            Ok(text)
        }
        Err((kind, mut text)) => {
            append(&mut text, &error);
            Err((kind, text))
        }
    }
}
async fn clear_ask(state: &AppState, session: &str, request: &str) {
    let mut sessions = state.sessions.write().await;
    if let Some(s) = sessions.get_mut(session) {
        if let Some(list) = s.snapshot["asks"].as_array_mut() {
            list.retain(|a| a["requestId"] != request);
            broadcast(
                state,
                serde_json::json!({"type":"session.update","sessionId":session,"patch":{"asks":list}}),
            );
        }
    }
}
pub async fn cancel_all(state: &AppState) {
    {
        let store = state.automations.lock().await;
        for tx in store.active.values() {
            let _ = tx.send(true);
        }
    }
    // Keep the runtime alive until cancellation has killed child process groups and saved history.
    let _ = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if state.automations.lock().await.active.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
}
pub async fn tick(state: &AppState) {
    let minute = now_secs() / 60;
    let due = {
        let mut store = state.automations.lock().await;
        if store.last_minute == Some(minute) {
            return;
        }
        store.last_minute = Some(minute);
        let at = chrono::DateTime::from_timestamp((minute * 60) as i64, 0).unwrap();
        store
            .data
            .definitions
            .iter()
            .filter(|d| {
                d.enabled
                    && !store.active.contains_key(&d.id)
                    && d.schedule
                        .as_ref()
                        .is_some_and(|s| schedule(s).is_ok_and(|cron| cron.matches(at)))
            })
            .map(|d| d.id.clone())
            .collect::<Vec<_>>()
    };
    for id in due {
        if let Err((_, e)) = launch(state.clone(), id).await {
            tracing::warn!("Scheduled automation could not start: {e}");
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_cron() {
        assert!(schedule("* * * * *").is_ok());
        assert!(schedule("* * * * * *").is_err());
        assert!(schedule("invalid").is_err());
    }
    #[test]
    fn bounds_utf8() {
        let mut s = String::new();
        append(&mut s, &"é".repeat(OUTPUT_LIMIT));
        assert!(s.len() <= OUTPUT_LIMIT);
    }
    #[test]
    fn cron_uses_unix_weekdays_and_day_or_semantics() {
        let monday = chrono::DateTime::parse_from_rfc3339("2026-10-12T09:00:00Z")
            .unwrap()
            .with_timezone(&chrono::Utc);
        assert!(schedule("0 9 * * 1-5").unwrap().matches(monday));
        assert!(!schedule("0 9 * * 0,7").unwrap().matches(monday));
        assert!(schedule("*/15 9 1 * 1").unwrap().matches(monday));
        assert!(!schedule("*/15 9 * * 2").unwrap().matches(monday));
        for invalid in [
            "60 * * * *",
            "* 24 * * *",
            "* * 0 * *",
            "* * * 13 *",
            "* * * * 8",
            "*/0 * * * *",
            "1-0 * * * *",
        ] {
            assert!(schedule(invalid).is_err(), "{invalid}");
        }
    }
    #[cfg(unix)]
    fn isolated_state() -> AppState {
        let root = std::env::temp_dir().join(format!("companion-automation-{}", Uuid::new_v4()));
        AppState::new(
            config::Persisted::default(),
            root.join("tmp"),
            root.join("data"),
            None,
            vec![],
        )
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn command_stdin_is_closed_and_timeout_is_total() {
        let state = isolated_state();
        let (_tx, mut rx) = watch::channel(false);
        let action = Action::Command {
            command: "cat".into(),
            args: vec![],
            cwd: None,
            timeout_seconds: Some(1),
        };
        assert!(
            execute_action(&state, "a", "r", &action, &mut rx)
                .await
                .is_ok()
        );
        let action = Action::Command {
            command: "sh".into(),
            args: vec!["-c".into(), "exec 1>&-; sleep 30".into()],
            cwd: None,
            timeout_seconds: Some(1),
        };
        let start = tokio::time::Instant::now();
        assert_eq!(
            execute_action(&state, "a", "r", &action, &mut rx)
                .await
                .unwrap_err()
                .0,
            "failed"
        );
        assert!(start.elapsed() < Duration::from_secs(4));
    }
    #[cfg(unix)]
    #[tokio::test]
    async fn rpc_session_relays_asks_and_waits_for_settled_summary() {
        use std::os::unix::fs::PermissionsExt;
        let state = isolated_state();
        fs::create_dir_all(&state.data_dir).await.unwrap();
        let binary = state.data_dir.join("fake-pi");
        fs::write(&binary,r##"#!/bin/sh
read -r prompt
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Not settled yet"}],"stopReason":"stop"}}' '{"type":"agent_end"}' '{"type":"extension_ui_request","id":"ask-1","method":"select","title":"Release?","options":["Ship","Wait"]}'
read -r answer
printf '%s\n' "$answer" >&2
printf '%s\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Final summary"}],"stopReason":"stop"}}' '{"type":"agent_settled"}'
"##).await.unwrap();
        fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700))
            .await
            .unwrap();
        let action = Action::Pi {
            prompt: "Review".into(),
            cwd: state.data_dir.to_string_lossy().into(),
            timeout_seconds: Some(5),
        };
        let (_tx, mut rx) = watch::channel(false);
        let running_state = state.clone();
        let task = tokio::spawn(async move {
            execute_action_program(&running_state, "a", "r", &action, &mut rx, &binary).await
        });
        let session = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let sessions = state.sessions.read().await;
                let found = sessions
                    .values()
                    .find(|s| s.snapshot["asks"].as_array().is_some_and(|a| !a.is_empty()))
                    .map(|s| s.snapshot["id"].as_str().unwrap().to_owned());
                drop(sessions);
                if let Some(id) = found {
                    break id;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(state.sessions.read().await[&session].snapshot["readOnly"] == true);
        forward_browser_command(&state,&serde_json::json!({"sessionId":session,"command":{"type":"ask_answer","requestId":"ask-1","answers":{"ask-1":["Ship"]}}}).to_string(),false).await;
        let result = task.await.unwrap().unwrap();
        assert!(result.contains("Final summary"));
        assert!(!result.contains("Not settled yet"));
        assert!(result.contains("extension_ui_response"));
        assert!(result.contains("Ship"));
        let sessions = state.sessions.read().await;
        assert_eq!(sessions[&session].snapshot["status"], "stopped");
        assert!(sessions[&session].command_tx.is_none());
        drop(sessions);
        fs::remove_dir_all(state.data_dir.parent().unwrap())
            .await
            .unwrap();
    }
}
