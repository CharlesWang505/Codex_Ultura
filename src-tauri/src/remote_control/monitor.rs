use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::RwLock;

use super::protocol::{RemoteMessage, unix_timestamp_ms};

pub const MONITOR_EVENT: &str = "remote-control-monitor";
pub const STATUS_EVENT: &str = "remote-control-status";
const MAX_SESSIONS: usize = 24;
const MAX_MESSAGES: usize = 120;
const MAX_ACTIVITIES: usize = 80;
const MAX_MESSAGE_CHARS: usize = 64_000;
const MAX_ACTIVITY_CHARS: usize = 8_000;
const EMIT_INTERVAL_MS: u64 = 100;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMonitorMessage {
    pub id: String,
    pub role: String,
    pub text: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMonitorActivity {
    pub id: String,
    pub kind: String,
    pub summary: String,
    pub timestamp: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMonitorSession {
    pub session_id: String,
    pub title: String,
    pub workspace: String,
    pub remote_device_id: String,
    pub status: String,
    pub turn_id: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub messages: Vec<RemoteMonitorMessage>,
    pub activities: Vec<RemoteMonitorActivity>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMonitorSnapshot {
    pub sequence: u64,
    pub sessions: Vec<RemoteMonitorSession>,
}

#[derive(Default)]
struct MonitorState {
    sequence: u64,
    sessions: HashMap<String, RemoteMonitorSession>,
    order: VecDeque<String>,
    last_emit_at: u64,
}

#[derive(Clone)]
pub struct RemoteMonitor {
    app: AppHandle,
    state: Arc<RwLock<MonitorState>>,
}

impl RemoteMonitor {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            state: Arc::new(RwLock::new(MonitorState::default())),
        }
    }

    pub async fn snapshot(&self) -> RemoteMonitorSnapshot {
        let state = self.state.read().await;
        snapshot_from_state(&state)
    }

    pub async fn status_changed(&self) {
        let _ = self.app.emit(STATUS_EVENT, ());
    }

    pub async fn active_count(&self) -> usize {
        self.state
            .read()
            .await
            .sessions
            .values()
            .filter(|session| matches!(session.status.as_str(), "waiting" | "running"))
            .count()
    }

    pub async fn session_created(
        &self,
        session_id: &str,
        title: &str,
        workspace: &str,
        remote_device_id: &str,
    ) {
        let now = unix_timestamp_ms();
        self.mutate(true, |state| {
            let session =
                ensure_session(state, session_id, title, workspace, remote_device_id, now);
            session.status = "ready".into();
        })
        .await;
    }

    pub async fn session_resumed(
        &self,
        session_id: &str,
        title: &str,
        workspace: &str,
        remote_device_id: &str,
    ) {
        let now = unix_timestamp_ms();
        self.mutate(true, |state| {
            let session =
                ensure_session(state, session_id, title, workspace, remote_device_id, now);
            session.status = "ready".into();
            push_activity(session, "session", "手机继续了这个会话", now);
        })
        .await;
    }

    pub async fn replace_history(
        &self,
        session_id: &str,
        workspace: &str,
        remote_device_id: &str,
        payload: &Value,
    ) {
        let now = unix_timestamp_ms();
        self.mutate(true, |state| {
            let title = payload
                .pointer("/session/title")
                .and_then(Value::as_str)
                .unwrap_or("远程会话");
            let session =
                ensure_session(state, session_id, title, workspace, remote_device_id, now);
            let mut messages = Vec::new();
            for item in payload
                .get("turns")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .flat_map(|turn| {
                    turn.get("items")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                })
            {
                let Some(text) = normalized_text(item.get("text")) else {
                    continue;
                };
                let role = item.get("role").and_then(Value::as_str).unwrap_or("tool");
                messages.push(RemoteMonitorMessage {
                    id: uuid::Uuid::new_v4().to_string(),
                    role: role.to_string(),
                    text: truncate_chars(&text, MAX_MESSAGE_CHARS),
                    timestamp: now,
                });
            }
            if messages.len() > MAX_MESSAGES {
                messages.drain(0..messages.len() - MAX_MESSAGES);
            }
            session.messages = messages;
            session.status = "ready".into();
            push_activity(session, "history", "已同步会话历史", now);
        })
        .await;
    }

    pub async fn user_input(
        &self,
        session_id: &str,
        workspace: &str,
        remote_device_id: &str,
        text: &str,
        attachment_count: usize,
        skill_count: usize,
    ) {
        let now = unix_timestamp_ms();
        self.mutate(true, |state| {
            let session = ensure_session(
                state,
                session_id,
                "远程会话",
                workspace,
                remote_device_id,
                now,
            );
            push_message(session, "user", text, now);
            session.status = "waiting".into();
            if attachment_count > 0 || skill_count > 0 {
                push_activity(
                    session,
                    "input",
                    &format!("附件 {attachment_count} 个 · Skills {skill_count} 个"),
                    now,
                );
            }
        })
        .await;
    }

    pub async fn normalized_event(&self, message: &RemoteMessage) {
        let Some(session_id) = message.session_id.as_deref() else {
            return;
        };
        let now = unix_timestamp_ms();
        let force_emit = !matches!(
            message.message_type.as_str(),
            "response.delta" | "reasoning.delta" | "command.output"
        );
        self.mutate(force_emit, |state| {
            let Some(session) = state.sessions.get_mut(session_id) else {
                return;
            };
            session.updated_at = now;
            if let Some(turn_id) = message.turn_id.as_deref() {
                session.turn_id = Some(turn_id.to_string());
            }
            match message.message_type.as_str() {
                "turn.started" => {
                    session.status = "running".into();
                    push_activity(session, "turn", "Codex 开始执行", now);
                }
                "response.delta" => {
                    let delta = message
                        .payload
                        .get("delta")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    append_assistant_delta(session, delta, now);
                }
                "reasoning.delta" => {
                    session.status = "running".into();
                }
                "command.output" => {
                    let delta = message
                        .payload
                        .get("delta")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    append_activity_delta(session, "command", delta, now);
                }
                "file.diff" => {
                    let diff = message
                        .payload
                        .get("diff")
                        .and_then(Value::as_str)
                        .unwrap_or("文件已变更");
                    append_activity_delta(session, "file", diff, now);
                }
                "response.completed" => {
                    session.status = "completed".into();
                    session.turn_id = None;
                    push_activity(session, "turn", "任务已完成", now);
                }
                "turn.interrupted" => {
                    session.status = "stopped".into();
                    session.turn_id = None;
                    push_activity(session, "turn", "任务已停止", now);
                }
                "turn.failed" => {
                    session.status = "failed".into();
                    session.turn_id = None;
                    let summary = message
                        .payload
                        .get("message")
                        .or_else(|| message.payload.get("error"))
                        .and_then(Value::as_str)
                        .unwrap_or("任务失败");
                    push_activity(session, "error", summary, now);
                }
                _ => {}
            }
        })
        .await;
    }

    pub async fn disconnected(&self) {
        self.mutate(true, |state| {
            let now = unix_timestamp_ms();
            for session in state.sessions.values_mut() {
                if matches!(session.status.as_str(), "waiting" | "running") {
                    session.status = "disconnected".into();
                    session.turn_id = None;
                    session.updated_at = now;
                    push_activity(session, "connection", "远控后端已断开", now);
                }
            }
        })
        .await;
    }

    async fn mutate(&self, force_emit: bool, update: impl FnOnce(&mut MonitorState)) {
        let now = unix_timestamp_ms();
        let snapshot = {
            let mut state = self.state.write().await;
            update(&mut state);
            state.sequence = state.sequence.saturating_add(1);
            trim_sessions(&mut state);
            let should_emit =
                force_emit || now.saturating_sub(state.last_emit_at) >= EMIT_INTERVAL_MS;
            if !should_emit {
                return;
            }
            state.last_emit_at = now;
            snapshot_from_state(&state)
        };
        let _ = self.app.emit(MONITOR_EVENT, snapshot);
    }
}

fn ensure_session<'a>(
    state: &'a mut MonitorState,
    session_id: &str,
    title: &str,
    workspace: &str,
    remote_device_id: &str,
    now: u64,
) -> &'a mut RemoteMonitorSession {
    if !state.sessions.contains_key(session_id) {
        state.order.push_front(session_id.to_string());
        state.sessions.insert(
            session_id.to_string(),
            RemoteMonitorSession {
                session_id: session_id.to_string(),
                title: title.to_string(),
                workspace: workspace.to_string(),
                remote_device_id: remote_device_id.to_string(),
                status: "ready".into(),
                turn_id: None,
                created_at: now,
                updated_at: now,
                messages: Vec::new(),
                activities: Vec::new(),
            },
        );
    } else {
        state.order.retain(|id| id != session_id);
        state.order.push_front(session_id.to_string());
    }
    let session = state
        .sessions
        .get_mut(session_id)
        .expect("session inserted");
    if !title.trim().is_empty() && title != "远程会话" {
        session.title = title.to_string();
    }
    if !workspace.trim().is_empty() {
        session.workspace = workspace.to_string();
    }
    if !remote_device_id.trim().is_empty() {
        session.remote_device_id = remote_device_id.to_string();
    }
    session.updated_at = now;
    session
}

fn push_message(session: &mut RemoteMonitorSession, role: &str, text: &str, timestamp: u64) {
    session.messages.push(RemoteMonitorMessage {
        id: uuid::Uuid::new_v4().to_string(),
        role: role.to_string(),
        text: truncate_chars(text, MAX_MESSAGE_CHARS),
        timestamp,
    });
    if session.messages.len() > MAX_MESSAGES {
        session.messages.remove(0);
    }
}

fn append_assistant_delta(session: &mut RemoteMonitorSession, delta: &str, timestamp: u64) {
    if delta.is_empty() {
        return;
    }
    if let Some(message) = session.messages.last_mut()
        && message.role == "assistant"
        && message.text.chars().count() < MAX_MESSAGE_CHARS
    {
        message.text.push_str(delta);
        message.text = truncate_chars(&message.text, MAX_MESSAGE_CHARS);
        message.timestamp = timestamp;
        return;
    }
    push_message(session, "assistant", delta, timestamp);
}

fn push_activity(session: &mut RemoteMonitorSession, kind: &str, summary: &str, timestamp: u64) {
    session.activities.push(RemoteMonitorActivity {
        id: uuid::Uuid::new_v4().to_string(),
        kind: kind.to_string(),
        summary: truncate_chars(summary, MAX_ACTIVITY_CHARS),
        timestamp,
    });
    if session.activities.len() > MAX_ACTIVITIES {
        session.activities.remove(0);
    }
}

fn append_activity_delta(
    session: &mut RemoteMonitorSession,
    kind: &str,
    delta: &str,
    timestamp: u64,
) {
    if delta.is_empty() {
        return;
    }
    if let Some(activity) = session.activities.last_mut()
        && activity.kind == kind
        && activity.summary.chars().count() < MAX_ACTIVITY_CHARS
    {
        activity.summary.push_str(delta);
        activity.summary = truncate_chars(&activity.summary, MAX_ACTIVITY_CHARS);
        activity.timestamp = timestamp;
        return;
    }
    push_activity(session, kind, delta, timestamp);
}

fn normalized_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => Some(
            parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join(""),
        ),
        _ => None,
    }
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

fn trim_sessions(state: &mut MonitorState) {
    while state.order.len() > MAX_SESSIONS {
        if let Some(session_id) = state.order.pop_back() {
            state.sessions.remove(&session_id);
        }
    }
}

fn snapshot_from_state(state: &MonitorState) -> RemoteMonitorSnapshot {
    RemoteMonitorSnapshot {
        sequence: state.sequence,
        sessions: state
            .order
            .iter()
            .filter_map(|session_id| state.sessions.get(session_id).cloned())
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::truncate_chars;

    #[test]
    fn truncates_monitor_text_on_character_boundaries() {
        assert_eq!(truncate_chars("测试abc", 3), "测试a");
    }
}
