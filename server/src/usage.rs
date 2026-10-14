//! Retained, allowlisted usage snapshots. Session removal never deletes account reports.
use std::{collections::HashMap, path::Path};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Window {
    used_percent: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    resets_at: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyUsage {
    starts_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cost: Option<f64>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    provider: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<String>,
    updated_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    weekly: Option<Window>,
    #[serde(skip_serializing_if = "Option::is_none")]
    five_hour: Option<Window>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_updated_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    weekly_usage: Option<WeeklyUsage>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Telemetry { pub providers: Vec<Provider> }

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub id: String,
    pub status: String,
    pub remote_enabled: bool,
    pub telemetry: Telemetry,
}

#[derive(Default, Serialize, Deserialize)]
pub struct Store { sessions: HashMap<String, Snapshot> }

fn text(value: &Value) -> Option<String> {
    value.as_str().map(str::trim).filter(|s| !s.is_empty()).map(|s| s.chars().take(160).collect())
}
fn date(value: &Value) -> Option<String> {
    let raw = value.as_str()?;
    chrono::DateTime::parse_from_rfc3339(raw).ok().map(|d| d.to_rfc3339())
}
fn number(value: &Value) -> Option<f64> { value.as_f64().filter(|n| n.is_finite() && *n >= 0.0) }
fn window(value: &Value) -> Option<Window> {
    let used = number(&value["usedPercent"])?;
    (used <= 100.0).then(|| Window { used_percent: used, resets_at: date(&value["resetsAt"]) })
}
fn time(value: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(value).map(|d| d.timestamp_millis()).unwrap_or(i64::MIN)
}
fn week_start(value: &str) -> Option<String> {
    use chrono::{Datelike, TimeZone};
    let date = chrono::DateTime::parse_from_rfc3339(value).ok()?.with_timezone(&chrono::Utc).date_naive();
    let monday = date - chrono::Duration::days(date.weekday().num_days_from_monday().into());
    Some(chrono::Utc.from_utc_datetime(&monday.and_hms_opt(0, 0, 0)?).to_rfc3339())
}
impl Provider {
    // Only the daemon creates these buckets; never trust a client-supplied accumulator.
    fn accumulate(&mut self, next: &Self) {
        let Some(starts_at) = week_start(next.session_updated_at.as_deref().unwrap_or(&next.updated_at)) else { return };
        let bucket = self.weekly_usage.get_or_insert_with(|| WeeklyUsage { starts_at: starts_at.clone(), ..Default::default() });
        if time(&starts_at) < time(&bucket.starts_at) { return; }
        if starts_at != bucket.starts_at { *bucket = WeeklyUsage { starts_at, ..Default::default() }; }
        if let Some(tokens) = next.session_tokens {
            bucket.tokens = Some(bucket.tokens.unwrap_or(0.0) + (tokens - self.session_tokens.unwrap_or(0.0)).max(0.0));
        }
        if let Some(cost) = next.session_cost {
            bucket.cost = Some(bucket.cost.unwrap_or(0.0) + (cost - self.session_cost.unwrap_or(0.0)).max(0.0));
        }
    }
    fn initialize_weekly_usage(&mut self) {
        if self.weekly_usage.is_none() && (self.session_tokens.is_some() || self.session_cost.is_some()) {
            self.weekly_usage = week_start(self.session_updated_at.as_deref().unwrap_or(&self.updated_at)).map(|starts_at| WeeklyUsage {
                starts_at, tokens: self.session_tokens, cost: self.session_cost,
            });
        }
    }
    fn parse(value: &Value) -> Option<Self> {
        let result = Self {
            provider: text(&value["provider"])? , source: text(&value["source"]),
            updated_at: date(&value["updatedAt"])? ,
            weekly: window(&value["weekly"]), five_hour: window(&value["fiveHour"]),
            session_tokens: number(&value["sessionTokens"]), session_cost: number(&value["sessionCost"]),
            session_updated_at: date(&value["sessionUpdatedAt"]), weekly_usage: None,
        };
        (result.weekly.is_some() || result.five_hour.is_some() || result.session_tokens.is_some() || result.session_cost.is_some()).then_some(result)
    }
    fn merge(&mut self, next: Self) {
        let had_session = self.session_tokens.is_some() || self.session_cost.is_some();
        let old_session_at = time(self.session_updated_at.as_deref().unwrap_or(&self.updated_at));
        if (next.weekly.is_some() || next.five_hour.is_some()) && time(&next.updated_at) >= time(&self.updated_at) {
            self.weekly = next.weekly.clone();
            self.five_hour = next.five_hour.clone();
            self.updated_at = next.updated_at.clone();
            self.source = next.source.clone();
        }
        let next_at = next.session_updated_at.as_deref().unwrap_or(&next.updated_at);
        if (next.session_tokens.is_some() || next.session_cost.is_some()) && (!had_session || time(next_at) >= old_session_at) {
            self.initialize_weekly_usage();
            self.accumulate(&next);
            // Cumulative counters cannot go backwards; a duplicate or partial report
            // must not erase the baseline and count already observed work again.
            if let Some(tokens) = next.session_tokens { self.session_tokens = Some(tokens.max(self.session_tokens.unwrap_or(0.0))); }
            if let Some(cost) = next.session_cost { self.session_cost = Some(cost.max(self.session_cost.unwrap_or(0.0))); }
            self.session_updated_at = Some(next_at.to_string());
        }
    }
}
impl Store {
    pub fn snapshot(&self, id: &str) -> Option<&Snapshot> { self.sessions.get(id) }
    pub fn snapshots(&self, remote: bool) -> Vec<Snapshot> {
        self.sessions.values().filter(|s| !remote || s.remote_enabled).cloned().collect()
    }
    pub fn capture(&mut self, id: &str, session: &Value) -> bool {
        let old = self.sessions.get(id).cloned();
        let mut providers = old.as_ref().map(|s| s.telemetry.providers.clone()).unwrap_or_default();
        if let Some(items) = session["telemetry"]["providers"].as_array() {
            for value in items.iter().take(100) {
                let Some(mut next) = Provider::parse(value) else { continue };
                if (next.session_tokens.is_some() || next.session_cost.is_some()) && next.session_updated_at.is_none() {
                    next.session_updated_at = Some(next.updated_at.clone());
                }
                if let Some(previous) = providers.iter_mut().find(|p| p.provider.eq_ignore_ascii_case(&next.provider)) {
                    previous.merge(next);
                } else if providers.len() < 100 { next.initialize_weekly_usage(); providers.push(next); }
            }
        }
        if providers.is_empty() { return false; }
        let snapshot = Snapshot {
            id: id.to_string(),
            status: if session["status"].as_str() == Some("stopped") { "stopped" } else { "idle" }.to_string(),
            remote_enabled: session["remoteEnabled"].as_bool() == Some(true),
            telemetry: Telemetry { providers },
        };
        if old.as_ref() == Some(&snapshot) { return false; }
        self.sessions.insert(id.to_string(), snapshot);
        self.trim();
        true
    }
    fn trim(&mut self) {
        while self.sessions.len() > 500 {
            let oldest = self.sessions.iter().min_by_key(|(id, snapshot)| (
                snapshot.telemetry.providers.iter().map(|p| time(p.session_updated_at.as_deref().unwrap_or(&p.updated_at)).max(time(&p.updated_at))).max().unwrap_or(i64::MIN),
                (*id).clone(),
            )).map(|(id, _)| id.clone());
            if let Some(id) = oldest { self.sessions.remove(&id); } else { break; }
        }
    }
    pub fn mark_stopped(&mut self) {
        for snapshot in self.sessions.values_mut() {
            snapshot.status = "stopped".into();
            for provider in &mut snapshot.telemetry.providers { provider.initialize_weekly_usage(); }
        }
    }
}

pub async fn load(dir: &Path) -> Store {
    match tokio::fs::read(dir.join("usage.json")).await {
        Ok(bytes) => match serde_json::from_slice::<Store>(&bytes) {
            Ok(mut store) => { store.mark_stopped(); store.trim(); store },
            Err(error) => { tracing::warn!("could not read usage snapshots: {error}"); Store::default() }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Store::default(),
        Err(error) => { tracing::warn!("could not read usage snapshots: {error}"); Store::default() }
    }
}
