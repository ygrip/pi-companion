//! Persistent daemon state: user settings and paired devices.
//!
//! Stored as JSON in `~/.pi/agent/pi-companion/state.json` (override the directory with
//! `PI_COMPANION_HOME`). Device credentials are kept only as SHA-256 hashes, next to the
//! device metadata (name, client, pairing and last-seen times). The directory is 0700 and the
//! file 0600 on Unix; the file is created with 0600 before any byte is written and replaced
//! atomically, and a looser mode found on load is tightened.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tokio::{fs, io::AsyncWriteExt};

pub const DEFAULT_PUBLIC_URL: &str = "http://127.0.0.1:43722";
pub const MAX_UPLOAD_MB_LIMIT: u64 = 100;
const MAX_UPLOAD_TYPES: usize = 50;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Address paired devices use to reach the daemon (tunnel / reverse proxy URL).
    /// Empty means "use PI_COMPANION_PUBLIC_URL or the loopback default".
    pub public_url: String,
    /// Lifetime of a pairing invitation, in minutes.
    pub pairing_ttl_minutes: u64,
    /// Largest file a browser may hand to a session, in MiB.
    pub max_upload_mb: u64,
    /// Optional MIME allowlist for uploads (`image/png`, `image/*`). Empty allows every type.
    pub allowed_upload_types: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self { public_url: String::new(), pairing_ttl_minutes: 5, max_upload_mb: 25, allowed_upload_types: Vec::new() }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<Settings, String> {
        let public_url = self.public_url.trim().trim_end_matches('/').to_string();
        if !public_url.is_empty() && !(public_url.starts_with("http://") || public_url.starts_with("https://")) {
            return Err("Public address must start with http:// or https://".into());
        }
        if public_url.len() > 300 {
            return Err("Public address is too long.".into());
        }
        if !(1..=60).contains(&self.pairing_ttl_minutes) {
            return Err("Invitation lifetime must be between 1 and 60 minutes.".into());
        }
        if !(1..=MAX_UPLOAD_MB_LIMIT).contains(&self.max_upload_mb) {
            return Err(format!("Upload limit must be between 1 and {MAX_UPLOAD_MB_LIMIT} MiB."));
        }
        let mut allowed_upload_types: Vec<String> = Vec::new();
        for entry in &self.allowed_upload_types {
            let entry = entry.trim().to_ascii_lowercase();
            if entry.is_empty() {
                continue;
            }
            if !is_mime_pattern(&entry) {
                return Err(format!("\"{entry}\" is not a MIME type like image/png or image/*."));
            }
            if !allowed_upload_types.contains(&entry) {
                allowed_upload_types.push(entry);
            }
        }
        if allowed_upload_types.len() > MAX_UPLOAD_TYPES {
            return Err(format!("Allow at most {MAX_UPLOAD_TYPES} upload types."));
        }
        Ok(Settings { public_url, allowed_upload_types, ..self.clone() })
    }

    /// Whether an upload of `mime` passes the allowlist (always true when the list is empty).
    pub fn allows_upload_type(&self, mime: &str) -> bool {
        if self.allowed_upload_types.is_empty() {
            return true;
        }
        let mime = mime.split(';').next().unwrap_or_default().trim().to_ascii_lowercase();
        let Some((kind, _)) = mime.split_once('/') else { return false };
        self.allowed_upload_types.iter().any(|pattern| match pattern.strip_suffix("/*") {
            Some(prefix) => prefix == kind,
            None => *pattern == mime,
        })
    }
}

fn is_mime_pattern(value: &str) -> bool {
    let token = |part: &str| {
        !part.is_empty()
            && part.len() <= 100
            && part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '+' | '-' | '_'))
    };
    match value.split_once('/') {
        Some((kind, sub)) => token(kind) && (sub == "*" || token(sub)),
        None => false,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDevice {
    pub id: String,
    pub name: String,
    /// SHA-256 of the bearer credential; the credential itself is never stored.
    pub token_hash: String,
    pub paired_at: u64,
    pub last_seen: u64,
    /// Browser user agent at pairing time, shortened. Helps tell devices apart.
    #[serde(default)]
    pub user_agent: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Persisted {
    pub settings: Settings,
    pub devices: Vec<StoredDevice>,
}

pub fn data_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("PI_COMPANION_HOME") {
        return PathBuf::from(dir);
    }
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    home.join(".pi").join("agent").join("pi-companion")
}

pub fn state_file(dir: &Path) -> PathBuf {
    dir.join("state.json")
}

pub async fn load(dir: &Path) -> Persisted {
    let path = state_file(dir);
    match fs::read(&path).await {
        Ok(bytes) => {
            tighten_permissions(&path).await;
            serde_json::from_slice(&bytes).unwrap_or_else(|error| {
                tracing::warn!("ignoring unreadable state file: {error}");
                Persisted::default()
            })
        }
        Err(_) => Persisted::default(),
    }
}

pub async fn save(dir: &Path, state: &Persisted) -> std::io::Result<()> {
    fs::create_dir_all(dir).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).await?;
    }
    let target = state_file(dir);
    let staging = dir.join(format!(".state.{}.{}.tmp", std::process::id(), uuid::Uuid::new_v4().simple()));
    let bytes = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let result = async {
        let mut file = options.open(&staging).await?;
        file.write_all(&bytes).await?;
        file.sync_all().await?;
        drop(file);
        fs::rename(&staging, &target).await
    }
    .await;
    if result.is_err() {
        let _ = fs::remove_file(&staging).await;
    }
    result
}

#[cfg(unix)]
async fn tighten_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(metadata) = fs::metadata(path).await {
        if metadata.permissions().mode() & 0o077 != 0 {
            if let Err(error) = fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await {
                tracing::warn!("could not restrict {}: {error}", path.display());
            }
        }
    }
}

#[cfg(not(unix))]
async fn tighten_permissions(_path: &Path) {}
