//! Persistent daemon state: user settings and paired devices.
//!
//! Stored as JSON in `~/.pi/agent/pi-companion/state.json` (override the directory with
//! `PI_COMPANION_HOME`). Device credentials are kept only as SHA-256 hashes. The file is
//! written atomically and, on Unix, with mode 0600.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tokio::fs;

pub const DEFAULT_PUBLIC_URL: &str = "http://127.0.0.1:43722";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Address paired devices use to reach the daemon (tunnel / reverse proxy URL).
    /// Empty means "use PI_COMPANION_PUBLIC_URL or the loopback default".
    pub public_url: String,
    /// Lifetime of a pairing invitation, in minutes.
    pub pairing_ttl_minutes: u64,
    /// Largest file a browser may hand to a session, in MiB.
    pub max_upload_mb: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self { public_url: String::new(), pairing_ttl_minutes: 5, max_upload_mb: 25 }
    }
}

pub const MAX_UPLOAD_MB_LIMIT: u64 = 100;

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
        Ok(Settings { public_url, ..self.clone() })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredDevice {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub paired_at: u64,
    pub last_seen: u64,
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

fn state_file() -> PathBuf {
    data_dir().join("state.json")
}

pub async fn load() -> Persisted {
    match fs::read(state_file()).await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|error| {
            tracing::warn!("ignoring unreadable state file: {error}");
            Persisted::default()
        }),
        Err(_) => Persisted::default(),
    }
}

pub async fn save(state: &Persisted) -> std::io::Result<()> {
    let dir = data_dir();
    fs::create_dir_all(&dir).await?;
    let target = state_file();
    let staging = dir.join(format!(".state.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(state).map_err(std::io::Error::other)?;
    fs::write(&staging, bytes).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staging, std::fs::Permissions::from_mode(0o600)).await?;
    }
    fs::rename(&staging, &target).await
}
