use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio::sync::{Mutex, RwLock, mpsc, watch};
use tokio_tungstenite::tungstenite::Message;

use super::attachments::{RemoteAttachment, prepare_attachments};
use super::codex_adapter::{AppServerClient, AppServerEvent, CodexProject, CodexProjectCatalog};
use super::crypto::{ReplayGuard, decrypt_message, encrypt_message};
use super::monitor::RemoteMonitor;
use super::protocol::{
    MAX_RELAY_MESSAGE_BYTES, PROTOCOL_VERSION, RelayAuth, RelayFrame, RemoteMessage,
    unix_timestamp_ms,
};
use super::relay_pairing::RelayPairingManager;
use super::sessions::list_remote_sessions;
use super::settings::RemoteSettings;
use super::workspace::{AuthorizedWorkspace, authorized_workspace_for_path};

#[derive(Debug, Clone, Default)]
pub struct RuntimeStatus {
    pub connection: String,
    pub codex_version: Option<String>,
    pub auth_type: Option<String>,
    pub last_connected_at: Option<u64>,
    pub last_mobile_at: Option<u64>,
    pub last_error: Option<String>,
    pub active_sessions: usize,
}

const MAX_CACHED_COMMANDS: usize = 2_048;

#[derive(Debug, Default)]
pub struct CommandCache {
    responses: HashMap<String, Vec<RemoteMessage>>,
    order: VecDeque<String>,
}

impl CommandCache {
    fn get(&self, message_id: &str) -> Option<Vec<RemoteMessage>> {
        self.responses.get(message_id).cloned()
    }

    fn insert(&mut self, message_id: String, responses: Vec<RemoteMessage>) {
        if self.responses.contains_key(&message_id) {
            self.responses.insert(message_id, responses);
            return;
        }
        while self.order.len() >= MAX_CACHED_COMMANDS {
            if let Some(oldest) = self.order.pop_front() {
                self.responses.remove(&oldest);
            }
        }
        self.order.push_back(message_id.clone());
        self.responses.insert(message_id, responses);
    }
}

pub async fn run(
    settings: RemoteSettings,
    workspaces: Vec<AuthorizedWorkspace>,
    status: Arc<RwLock<RuntimeStatus>>,
    replay: Arc<Mutex<HashMap<String, ReplayGuard>>>,
    commands: Arc<Mutex<HashMap<String, CommandCache>>>,
    monitor: RemoteMonitor,
    relay_pairing: RelayPairingManager,
    mut stop: watch::Receiver<bool>,
) -> Result<(), String> {
    status.write().await.connection = "connecting".into();
    monitor.status_changed().await;
    let (socket, _) = tokio_tungstenite::connect_async(&settings.relay_url)
        .await
        .map_err(|error| format!("无法连接中继服务器：{error}"))?;
    let (mut writer, mut reader) = socket.split();
    let auth = RelayAuth {
        protocol_version: PROTOCOL_VERSION,
        kind: "auth".into(),
        role: "desktop".into(),
        room_id: settings.room_id.clone(),
        device_id: settings.desktop_device_id.clone(),
        token: settings.access_token.clone(),
    };
    writer
        .send(Message::Text(
            serde_json::to_string(&auth)
                .map_err(|_| "无法编码中继认证消息".to_string())?
                .into(),
        ))
        .await
        .map_err(|_| "无法向中继服务器发送认证消息".to_string())?;

    let authenticated = tokio::time::timeout(Duration::from_secs(10), reader.next())
        .await
        .map_err(|_| "中继服务器认证超时".to_string())?
        .ok_or_else(|| "中继服务器在认证前断开".to_string())?
        .map_err(|_| "中继服务器认证失败".to_string())?;
    let auth_value = parse_json_message(authenticated)?;
    if auth_value.get("kind").and_then(Value::as_str) != Some("authenticated") {
        return Err(auth_value
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("中继服务器拒绝设备认证")
            .to_string());
    }

    let (pairing_outbound, mut pairing_incoming) = mpsc::unbounded_channel();
    relay_pairing
        .start_runtime(&settings, pairing_outbound)
        .await;
    send_plain(
        &mut writer,
        json!({
            "protocolVersion": PROTOCOL_VERSION,
            "kind": "presence.desktop.status",
            "messageId": uuid::Uuid::new_v4().to_string(),
            "senderDeviceId": settings.desktop_device_id,
            "payload": {
                "deviceName": settings.device_name,
                "remoteEnabled": settings.enabled,
                "paused": settings.paused,
                "codexInstalled": false,
                "codexRunning": false,
                "codexAuthenticated": false,
                "appServerAvailable": false,
                "activeSessions": 0,
            }
        }),
    )
    .await?;

    let app_server = match AppServerClient::start().await {
        Ok(app_server) => app_server,
        Err(error) => {
            let _ = send_plain(
                &mut writer,
                json!({
                    "protocolVersion": PROTOCOL_VERSION,
                    "kind": "presence.desktop.status",
                    "messageId": uuid::Uuid::new_v4().to_string(),
                    "senderDeviceId": settings.desktop_device_id,
                    "payload": {
                        "deviceName": settings.device_name,
                        "remoteEnabled": settings.enabled,
                        "paused": settings.paused,
                        "codexInstalled": true,
                        "codexRunning": false,
                        "codexAuthenticated": false,
                        "appServerAvailable": false,
                        "activeSessions": 0,
                    }
                }),
            )
            .await;
            relay_pairing.stop_runtime().await;
            return Err(error);
        }
    };
    let account = app_server.account_status().await?;
    let auth_type = account
        .pointer("/account/type")
        .and_then(Value::as_str)
        .map(str::to_string);
    {
        let mut current = status.write().await;
        current.connection = "connected".into();
        current.codex_version = Some(app_server.version().await);
        current.auth_type = auth_type;
        current.last_connected_at = Some(unix_timestamp_ms());
        current.last_error = None;
    }
    monitor.status_changed().await;
    send_plain(
        &mut writer,
        presence_status_message(&settings, &status).await,
    )
    .await?;

    let mut events = app_server.subscribe();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(settings.heartbeat_seconds));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let outgoing_sequence = AtomicU64::new(unix_timestamp_ms().saturating_mul(1_000));
    let mut allowed_sessions = HashSet::new();

    send_remote(
        &mut writer,
        &settings,
        &outgoing_sequence,
        None,
        RemoteMessage::event(
            "device.status",
            None,
            None,
            None,
            status_payload(&settings, &status, &workspaces).await,
        ),
    )
    .await?;

    let loop_result = loop {
        tokio::select! {
            incoming = reader.next() => {
                let Some(incoming) = incoming else {
                    break Err("中继连接已关闭".to_string());
                };
                let message = match incoming {
                    Ok(message) => message,
                    Err(error) => break Err(format!("中继连接异常：{error}")),
                };
                if matches!(message, Message::Close(_)) {
                    break Err("中继连接已关闭".to_string());
                }
                let value = match parse_json_message(message) {
                    Ok(value) => value,
                    Err(_) => continue,
                };
                if value.get("kind").and_then(Value::as_str) == Some("ack") {
                    continue;
                }
                if relay_pairing.handle_server_message(value.clone()).await {
                    continue;
                }
                let frame: RelayFrame = match serde_json::from_value(value) {
                    Ok(frame) => frame,
                    Err(_) => continue,
                };
                if frame.protocol_version != PROTOCOL_VERSION
                    || frame.room_id != settings.room_id
                    || frame.sender_device_id == settings.desktop_device_id
                    || frame.target_device_id.as_deref().is_some_and(|id| id != settings.desktop_device_id)
                {
                    continue;
                }
                let command = match decrypt_message(&settings.encryption_key, &frame) {
                    Ok(command) if command.protocol_version == PROTOCOL_VERSION => command,
                    _ => continue,
                };
                if !replay
                    .lock()
                    .await
                    .entry(frame.sender_device_id.clone())
                    .or_default()
                    .accept(&frame.message_id, frame.sequence)
                {
                    continue;
                }
                status.write().await.last_mobile_at = Some(unix_timestamp_ms());
                let command_id = command.message_id.clone();
                let cached = commands
                    .lock()
                    .await
                    .get(&frame.sender_device_id)
                    .and_then(|cache| cache.get(&command_id));
                let responses = if let Some(cached) = cached {
                    cached
                } else {
                    let responses = handle_command(
                        &settings,
                        &workspaces,
                        &app_server,
                        &status,
                        &mut allowed_sessions,
                        &monitor,
                        &frame.sender_device_id,
                        command,
                    ).await;
                    status.write().await.active_sessions = monitor.active_count().await;
                    commands
                        .lock()
                        .await
                        .entry(frame.sender_device_id.clone())
                        .or_default()
                        .insert(command_id, responses.clone());
                    responses
                };
                for response in responses {
                    send_remote(
                        &mut writer,
                        &settings,
                        &outgoing_sequence,
                        Some(frame.sender_device_id.clone()),
                        response,
                    ).await?;
                }
            }
            event = events.recv() => {
                let Ok(event) = event else { continue; };
                if event.method == "server/disconnected" {
                    break Err("Codex app-server 已断开".to_string());
                }
                if let Some(message) = normalize_event(event, &allowed_sessions) {
                    monitor.normalized_event(&message).await;
                    status.write().await.active_sessions = monitor.active_count().await;
                    send_remote(&mut writer, &settings, &outgoing_sequence, None, message).await?;
                }
            }
            _ = heartbeat.tick() => {
                send_plain(
                    &mut writer,
                    presence_status_message(&settings, &status).await,
                ).await?;
                send_remote(
                    &mut writer,
                    &settings,
                    &outgoing_sequence,
                    None,
                    RemoteMessage::event("device.heartbeat", None, None, None, json!({"at": unix_timestamp_ms()})),
                ).await?;
            }
            outgoing = pairing_incoming.recv() => {
                let Some(outgoing) = outgoing else {
                    break Err("公网配对消息通道已关闭".to_string());
                };
                send_plain(&mut writer, outgoing).await?;
            }
            changed = stop.changed() => {
                if changed.is_err() || *stop.borrow() {
                    break Ok(());
                }
            }
        }
    };

    app_server.stop().await;
    relay_pairing.stop_runtime().await;
    monitor.disconnected().await;
    monitor.status_changed().await;
    loop_result
}

async fn presence_status_message(
    settings: &RemoteSettings,
    status: &Arc<RwLock<RuntimeStatus>>,
) -> Value {
    let current = status.read().await.clone();
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "kind": "presence.desktop.status",
        "messageId": uuid::Uuid::new_v4().to_string(),
        "senderDeviceId": settings.desktop_device_id,
        "payload": {
            "deviceName": settings.device_name,
            "remoteEnabled": settings.enabled,
            "paused": settings.paused,
            "codexInstalled": current.codex_version.is_some(),
            "codexRunning": current.codex_version.is_some(),
            "codexAuthenticated": current.auth_type.is_some(),
            "appServerAvailable": current.codex_version.is_some(),
            "codexVersion": current.codex_version,
            "activeSessions": current.active_sessions,
        }
    })
}

async fn send_plain<S>(writer: &mut S, value: Value) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    let text = serde_json::to_string(&value).map_err(|_| "无法编码设备发现消息".to_string())?;
    if text.len() > MAX_RELAY_MESSAGE_BYTES {
        return Err("设备发现消息超过大小限制".to_string());
    }
    writer
        .send(Message::Text(text.into()))
        .await
        .map_err(|error| format!("无法发送设备发现消息：{error}"))
}

async fn handle_command(
    settings: &RemoteSettings,
    workspaces: &[AuthorizedWorkspace],
    app_server: &AppServerClient,
    status: &Arc<RwLock<RuntimeStatus>>,
    allowed_sessions: &mut HashSet<String>,
    monitor: &RemoteMonitor,
    remote_device_id: &str,
    command: RemoteMessage,
) -> Vec<RemoteMessage> {
    if settings.paused
        && !matches!(
            command.message_type.as_str(),
            "device.status.request" | "workspace.list"
        )
    {
        return vec![error_message(
            &command,
            "remote_paused",
            "电脑已暂停手机远控",
        )];
    }
    let result = match command.message_type.as_str() {
        "device.status.request" => Ok(RemoteMessage::event(
            "device.status",
            Some(command.message_id.clone()),
            None,
            None,
            status_payload(settings, status, workspaces).await,
        )),
        "workspace.list" => Ok(RemoteMessage::event(
            "workspace.list.result",
            Some(command.message_id.clone()),
            None,
            None,
            json!({"workspaces": workspaces}),
        )),
        "model.list" => app_server.list_models().await.map(|value| {
            RemoteMessage::event(
                "model.list.result",
                Some(command.message_id.clone()),
                None,
                None,
                normalize_model_list(value),
            )
        }),
        "capability.list" => {
            let workspace = if let Some(workspace_id) = command
                .payload
                .get("workspaceId")
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
            {
                workspaces
                    .iter()
                    .find(|workspace| workspace.id == workspace_id)
                    .cloned()
            } else if let Some(session_id) = command
                .session_id
                .as_deref()
                .filter(|value| !value.is_empty())
            {
                authorized_session(app_server, workspaces, session_id)
                    .await
                    .map(|(workspace, _)| workspace)
            } else {
                None
            };
            let Some(workspace) = workspace else {
                return vec![error_message(
                    &command,
                    "workspace_unauthorized",
                    "读取插件和 Skills 前必须选择已授权工作区",
                )];
            };
            match tokio::try_join!(
                app_server.list_skills(&workspace.path),
                app_server.list_installed_plugins(&workspace.path)
            ) {
                Ok((skills, plugins)) => Ok(RemoteMessage::event(
                    "capability.list.result",
                    Some(command.message_id.clone()),
                    command.session_id.clone(),
                    None,
                    normalize_capabilities(skills, plugins),
                )),
                Err(error) => Err(error),
            }
        }
        "session.list.request" => {
            match list_remote_sessions(app_server, workspaces, &command.payload).await {
                Ok(payload) => Ok(RemoteMessage::event(
                    "session.list.result",
                    Some(command.message_id.clone()),
                    None,
                    None,
                    payload,
                )),
                Err(error) => Err(error),
            }
        }
        "session.create" => {
            let workspace_id = command
                .payload
                .get("workspaceId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let Some(workspace) = workspaces.iter().find(|item| item.id == workspace_id) else {
                return vec![error_message(
                    &command,
                    "workspace_unauthorized",
                    "工作区未授权",
                )];
            };
            let requested_model = command
                .payload
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let model = match validate_requested_model(app_server, requested_model).await {
                Ok(model) => model,
                Err(error) => {
                    return vec![error_message(&command, "model_unavailable", &error)];
                }
            };
            match app_server
                .create_session(
                    &workspace.path,
                    workspace.allow_write,
                    workspace.allow_commands,
                    model.as_deref(),
                )
                .await
            {
                Ok(value) => {
                    let session_id = value
                        .pointer("/thread/id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    if !session_id.is_empty() {
                        allowed_sessions.insert(session_id.clone());
                        let normalized =
                            normalize_thread(value.get("thread").cloned().unwrap_or(Value::Null));
                        monitor
                            .session_created(
                                &session_id,
                                normalized
                                    .get("title")
                                    .and_then(Value::as_str)
                                    .unwrap_or("远程会话"),
                                &workspace.name,
                                remote_device_id,
                            )
                            .await;
                    }
                    Ok(RemoteMessage::event(
                        "session.created",
                        Some(command.message_id.clone()),
                        Some(session_id),
                        None,
                        normalize_thread(value.get("thread").cloned().unwrap_or(Value::Null)),
                    ))
                }
                Err(error) => Err(error),
            }
        }
        "session.history.request" => {
            let session_id = command.session_id.as_deref().unwrap_or("");
            let Some(access) = discoverable_session(app_server, workspaces, session_id).await
            else {
                return vec![error_message(
                    &command,
                    "session_unavailable",
                    "该会话不属于 Codex 项目列表",
                )];
            };
            match app_server
                .request(
                    "thread/read",
                    json!({"threadId": session_id, "includeTurns": true}),
                )
                .await
            {
                Ok(value) => {
                    let history = normalize_history(value);
                    monitor
                        .replace_history(
                            session_id,
                            &access.project.name,
                            remote_device_id,
                            &history,
                        )
                        .await;
                    Ok(RemoteMessage::event(
                        "session.history.result",
                        Some(command.message_id.clone()),
                        Some(session_id.to_string()),
                        None,
                        history,
                    ))
                }
                Err(error) => Err(error),
            }
        }
        "session.resume" | "conversation.input" => {
            let session_id = command.session_id.as_deref().unwrap_or("");
            let Some((workspace, existing_thread)) =
                authorized_session(app_server, workspaces, session_id).await
            else {
                return vec![error_message(
                    &command,
                    "workspace_unauthorized",
                    "该会话不属于已授权工作区",
                )];
            };
            allowed_sessions.insert(session_id.to_string());
            if command.message_type == "session.resume" {
                match app_server
                    .resume_session(
                        session_id,
                        &workspace.path,
                        workspace.allow_write,
                        workspace.allow_commands,
                    )
                    .await
                {
                    Ok(value) => {
                        let normalized =
                            normalize_thread(value.get("thread").cloned().unwrap_or(Value::Null));
                        let title = normalized
                            .get("title")
                            .and_then(Value::as_str)
                            .or_else(|| existing_thread.get("preview").and_then(Value::as_str))
                            .unwrap_or("远程会话");
                        monitor
                            .session_resumed(session_id, title, &workspace.name, remote_device_id)
                            .await;
                        Ok(RemoteMessage::event(
                            "session.resumed",
                            Some(command.message_id.clone()),
                            Some(session_id.to_string()),
                            None,
                            normalized,
                        ))
                    }
                    Err(error) => Err(error),
                }
            } else {
                let text = command
                    .payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let attachments = match command
                    .payload
                    .get("attachments")
                    .cloned()
                    .unwrap_or_else(|| json!([]))
                {
                    Value::Array(items) => {
                        let mut parsed = Vec::with_capacity(items.len());
                        for item in items {
                            match serde_json::from_value::<RemoteAttachment>(item) {
                                Ok(attachment) => parsed.push(attachment),
                                Err(_) => {
                                    return vec![error_message(
                                        &command,
                                        "invalid_attachment",
                                        "附件描述格式无效",
                                    )];
                                }
                            }
                        }
                        parsed
                    }
                    _ => {
                        return vec![error_message(
                            &command,
                            "invalid_attachment",
                            "附件描述格式无效",
                        )];
                    }
                };
                let requested_skills = match requested_skill_names(&command.payload) {
                    Ok(skills) => skills,
                    Err(error) => {
                        return vec![error_message(&command, "invalid_skill", &error)];
                    }
                };
                if text.len() > 32_000
                    || (text.is_empty() && attachments.is_empty() && requested_skills.is_empty())
                {
                    return vec![error_message(
                        &command,
                        "invalid_input",
                        "消息为空或超过 32000 字符",
                    )];
                }
                let prepared = match prepare_attachments(
                    settings,
                    &workspace,
                    session_id,
                    remote_device_id,
                    attachments,
                )
                .await
                {
                    Ok(prepared) => prepared,
                    Err(error) => {
                        return vec![error_message(&command, "attachment_rejected", &error)];
                    }
                };
                let skill_inputs = match resolve_skill_inputs(
                    app_server,
                    &workspace.path,
                    &requested_skills,
                )
                .await
                {
                    Ok(inputs) => inputs,
                    Err(error) => {
                        return vec![error_message(&command, "skill_unavailable", &error)];
                    }
                };
                let mut effective_text = text.to_string();
                if !prepared.references.is_empty() {
                    if effective_text.is_empty() {
                        effective_text.push_str("请查看并处理我上传的文件。");
                    }
                    effective_text.push_str("\n\n电脑端已将上传文件保存到当前授权工作区：\n");
                    for path in &prepared.references {
                        effective_text.push_str("- ");
                        effective_text.push_str(path);
                        effective_text.push('\n');
                    }
                } else if effective_text.is_empty() && !prepared.image_inputs.is_empty() {
                    effective_text.push_str("请查看并处理我上传的图片。");
                } else if effective_text.is_empty() {
                    effective_text.push_str("请使用所选 Skills 继续当前任务。");
                }
                let attachment_count = prepared
                    .references
                    .len()
                    .saturating_add(prepared.image_inputs.len());
                let mut inputs = skill_inputs;
                inputs.extend(prepared.image_inputs);
                inputs.push(json!({"type": "text", "text": effective_text}));
                monitor
                    .user_input(
                        session_id,
                        &workspace.name,
                        remote_device_id,
                        &effective_text,
                        attachment_count,
                        requested_skills.len(),
                    )
                    .await;
                app_server
                    .send_message(
                        session_id,
                        &workspace.path,
                        workspace.allow_write,
                        workspace.allow_commands,
                        inputs,
                    )
                    .await
                    .map(|value| {
                        let turn_id = value
                            .pointer("/turn/id")
                            .and_then(Value::as_str)
                            .map(str::to_string);
                        RemoteMessage::event(
                            "conversation.accepted",
                            Some(command.message_id.clone()),
                            Some(session_id.to_string()),
                            turn_id,
                            json!({}),
                        )
                    })
            }
        }
        "turn.interrupt" => {
            let session_id = command.session_id.as_deref().unwrap_or("");
            let turn_id = command.turn_id.as_deref().unwrap_or("");
            if !allowed_sessions.contains(session_id) {
                return vec![error_message(
                    &command,
                    "session_unauthorized",
                    "远程会话未授权",
                )];
            }
            app_server.interrupt(session_id, turn_id).await.map(|_| {
                RemoteMessage::event(
                    "turn.interrupt.accepted",
                    Some(command.message_id.clone()),
                    Some(session_id.to_string()),
                    Some(turn_id.to_string()),
                    json!({}),
                )
            })
        }
        _ => Err("不支持的远控消息类型".to_string()),
    };
    vec![match result {
        Ok(message) => message,
        Err(error) => error_message(&command, "codex_error", &error),
    }]
}

struct DiscoverableSession {
    project: CodexProject,
}

async fn discoverable_session(
    app_server: &AppServerClient,
    workspaces: &[AuthorizedWorkspace],
    session_id: &str,
) -> Option<DiscoverableSession> {
    if session_id.is_empty() {
        return None;
    }
    let value = app_server
        .request(
            "thread/read",
            json!({"threadId": session_id, "includeTurns": false}),
        )
        .await
        .ok()?;
    let cwd = value.pointer("/thread/cwd").and_then(Value::as_str)?;
    let project = CodexProjectCatalog::load(workspaces)
        .ok()?
        .project_for_thread(session_id, cwd)?;
    Some(DiscoverableSession { project })
}

async fn authorized_session(
    app_server: &AppServerClient,
    workspaces: &[AuthorizedWorkspace],
    session_id: &str,
) -> Option<(AuthorizedWorkspace, Value)> {
    if session_id.is_empty() {
        return None;
    }
    let value = app_server
        .request(
            "thread/read",
            json!({"threadId": session_id, "includeTurns": false}),
        )
        .await
        .ok()?;
    let workspace = value
        .pointer("/thread/cwd")
        .and_then(Value::as_str)
        .and_then(|cwd| authorized_workspace_for_path(workspaces, cwd))?;
    Some((
        workspace,
        value.get("thread").cloned().unwrap_or(Value::Null),
    ))
}

fn normalize_model_list(value: Value) -> Value {
    let models = value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| {
            !model
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .filter_map(|model| {
            let id = model
                .get("model")
                .or_else(|| model.get("id"))
                .and_then(Value::as_str)?;
            Some(json!({
                "id": id,
                "displayName": model.get("displayName").and_then(Value::as_str).unwrap_or(id),
                "isDefault": model.get("isDefault").and_then(Value::as_bool).unwrap_or(false),
                "defaultReasoningEffort": model.get("defaultReasoningEffort").cloned().unwrap_or(Value::Null),
            }))
        })
        .collect::<Vec<_>>();
    json!({"models": models})
}

fn requested_skill_names(payload: &Value) -> Result<Vec<String>, String> {
    const MAX_SELECTED_SKILLS: usize = 8;
    let Some(items) = payload.get("skills") else {
        return Ok(Vec::new());
    };
    let Some(items) = items.as_array() else {
        return Err("Skills 选择格式无效".to_string());
    };
    if items.len() > MAX_SELECTED_SKILLS {
        return Err(format!("单次最多选择 {MAX_SELECTED_SKILLS} 个 Skills"));
    }
    let mut unique = HashSet::new();
    let mut names = Vec::new();
    for item in items {
        let Some(name) = item.as_str().map(str::trim) else {
            return Err("Skill 名称无效".to_string());
        };
        if name.is_empty() || name.chars().count() > 160 {
            return Err("Skill 名称无效".to_string());
        }
        if unique.insert(name.to_string()) {
            names.push(name.to_string());
        }
    }
    Ok(names)
}

async fn resolve_skill_inputs(
    app_server: &AppServerClient,
    cwd: &str,
    requested_names: &[String],
) -> Result<Vec<Value>, String> {
    if requested_names.is_empty() {
        return Ok(Vec::new());
    }
    let response = app_server.list_skills(cwd).await?;
    let mut enabled = HashMap::new();
    for skill in response
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            entry
                .get("skills")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
    {
        if !skill
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let Some(name) = skill.get("name").and_then(Value::as_str) else {
            continue;
        };
        let Some(path) = skill.get("path").and_then(Value::as_str) else {
            continue;
        };
        enabled.insert(name.to_string(), path.to_string());
    }
    requested_names
        .iter()
        .map(|name| {
            enabled
                .get(name)
                .map(|path| json!({"type": "skill", "name": name, "path": path}))
                .ok_or_else(|| format!("Skill “{name}”未安装、已禁用或不适用于当前工作区"))
        })
        .collect()
}

fn normalize_capabilities(skills_value: Value, plugins_value: Value) -> Value {
    let mut plugins = plugins_value
        .get("marketplaces")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|marketplace| {
            marketplace
                .get("plugins")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter(|plugin| {
            plugin
                .get("installed")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && plugin
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
        .filter_map(|plugin| {
            let id = plugin.get("id").and_then(Value::as_str)?;
            let name = plugin
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or(id);
            let interface = plugin.get("interface").unwrap_or(&Value::Null);
            Some(json!({
                "id": id,
                "name": name,
                "displayName": interface.get("displayName").and_then(Value::as_str).unwrap_or(name),
                "description": interface.get("shortDescription").and_then(Value::as_str).unwrap_or(""),
                "skillNames": [],
            }))
        })
        .collect::<Vec<_>>();
    let plugin_aliases = plugins
        .iter()
        .enumerate()
        .flat_map(|(index, plugin)| {
            ["id", "name"].into_iter().filter_map(move |key| {
                plugin
                    .get(key)
                    .and_then(Value::as_str)
                    .map(|value| (value, index))
            })
        })
        .map(|(value, index)| (value.to_ascii_lowercase(), index))
        .collect::<HashMap<_, _>>();

    let mut skills = Vec::new();
    for skill in skills_value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|entry| {
            entry
                .get("skills")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
    {
        if !skill
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            continue;
        }
        let Some(name) = skill.get("name").and_then(Value::as_str) else {
            continue;
        };
        let prefix = name.split(':').next().unwrap_or(name).to_ascii_lowercase();
        let plugin_index = plugin_aliases.get(&prefix).copied();
        if let Some(index) = plugin_index
            && let Some(skill_names) = plugins[index]
                .get_mut("skillNames")
                .and_then(Value::as_array_mut)
        {
            skill_names.push(Value::String(name.to_string()));
        }
        let interface = skill.get("interface").unwrap_or(&Value::Null);
        skills.push(json!({
            "name": name,
            "displayName": interface.get("displayName").and_then(Value::as_str).unwrap_or(name),
            "description": interface.get("shortDescription").and_then(Value::as_str)
                .or_else(|| skill.get("shortDescription").and_then(Value::as_str))
                .or_else(|| skill.get("description").and_then(Value::as_str))
                .unwrap_or(""),
            "scope": skill.get("scope").cloned().unwrap_or(Value::Null),
            "pluginId": plugin_index.and_then(|index| plugins[index].get("id").cloned()),
        }));
    }
    plugins.retain(|plugin| {
        plugin
            .get("skillNames")
            .and_then(Value::as_array)
            .is_some_and(|items| !items.is_empty())
    });
    json!({"plugins": plugins, "skills": skills})
}

async fn validate_requested_model(
    app_server: &AppServerClient,
    requested: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(requested) = requested else {
        return Ok(None);
    };
    let value = app_server.list_models().await?;
    let allowed = value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|model| {
            !model
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .find_map(|model| {
            let id = model.get("id").and_then(Value::as_str);
            let model_name = model.get("model").and_then(Value::as_str);
            if id == Some(requested) || model_name == Some(requested) {
                model_name.or(id).map(str::to_string)
            } else {
                None
            }
        });
    allowed
        .map(Some)
        .ok_or_else(|| "所选模型不在本机 Codex 可用模型目录中".to_string())
}

fn normalize_thread(thread: Value) -> Value {
    json!({
        "id": thread.get("id").cloned().unwrap_or(Value::Null),
        "title": thread.get("name").cloned().or_else(|| thread.get("preview").cloned()).unwrap_or(Value::Null),
        "preview": thread.get("preview").cloned().unwrap_or(Value::Null),
        "cwd": thread.get("cwd").cloned().unwrap_or(Value::Null),
        "status": thread.pointer("/status/type").cloned().unwrap_or_else(|| thread.get("status").cloned().unwrap_or(Value::Null)),
        "createdAt": thread.get("createdAt").cloned().unwrap_or(Value::Null),
        "updatedAt": thread.get("updatedAt").cloned().unwrap_or(Value::Null),
    })
}

fn normalize_history(value: Value) -> Value {
    let thread = value.get("thread").cloned().unwrap_or(Value::Null);
    let turns = thread
        .get("turns")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let normalized = turns.into_iter().map(|turn| {
        let items = turn.get("items").and_then(Value::as_array).into_iter().flatten().filter_map(|item| {
            match item.get("type").and_then(Value::as_str) {
                Some("userMessage") => Some(json!({"role": "user", "text": item.get("content").cloned().unwrap_or(Value::Null)})),
                Some("agentMessage") => Some(json!({"role": "assistant", "text": item.get("text").cloned().unwrap_or(Value::Null)})),
                Some("commandExecution") => Some(json!({"role": "tool", "kind": "command", "status": item.get("status").cloned().unwrap_or(Value::Null)})),
                Some("fileChange") => Some(json!({"role": "tool", "kind": "file", "status": item.get("status").cloned().unwrap_or(Value::Null)})),
                _ => None,
            }
        }).collect::<Vec<_>>();
        json!({"id": turn.get("id"), "status": turn.get("status"), "items": items})
    }).collect::<Vec<_>>();
    json!({"session": normalize_thread(thread), "turns": normalized})
}

fn normalize_event(
    event: AppServerEvent,
    allowed_sessions: &HashSet<String>,
) -> Option<RemoteMessage> {
    let session_id = event
        .params
        .get("threadId")
        .and_then(Value::as_str)?
        .to_string();
    if !allowed_sessions.contains(&session_id) {
        return None;
    }
    let turn_id = event
        .params
        .get("turnId")
        .and_then(Value::as_str)
        .or_else(|| event.params.pointer("/turn/id").and_then(Value::as_str))
        .map(str::to_string);
    let (message_type, payload) = match event.method.as_str() {
        "turn/started" => ("turn.started", json!({"status": "running"})),
        "item/agentMessage/delta" => (
            "response.delta",
            json!({"delta": event.params.get("delta").cloned().unwrap_or(Value::Null)}),
        ),
        "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => (
            "reasoning.delta",
            json!({"delta": event.params.get("delta").cloned().unwrap_or(Value::Null)}),
        ),
        "item/commandExecution/outputDelta" => (
            "command.output",
            json!({"delta": event.params.get("delta").cloned().unwrap_or(Value::Null)}),
        ),
        "turn/diff/updated" => (
            "file.diff",
            json!({"diff": event.params.get("diff").cloned().unwrap_or(Value::Null)}),
        ),
        "thread/tokenUsage/updated" => (
            "usage.updated",
            json!({"usage": event.params.get("tokenUsage").cloned().unwrap_or(Value::Null)}),
        ),
        "turn/completed" => {
            let status = event
                .params
                .pointer("/turn/status")
                .and_then(Value::as_str)
                .unwrap_or("failed");
            let kind = match status {
                "completed" => "response.completed",
                "interrupted" => "turn.interrupted",
                _ => "turn.failed",
            };
            (
                kind,
                json!({"status": status, "error": event.params.pointer("/turn/error/message").cloned().unwrap_or(Value::Null)}),
            )
        }
        "error" => (
            "turn.failed",
            json!({"message": event.params.pointer("/error/message").cloned().unwrap_or(Value::Null)}),
        ),
        "server/disconnected" => ("server.disconnected", json!({})),
        _ => return None,
    };
    Some(RemoteMessage::event(
        message_type,
        None,
        Some(session_id),
        turn_id,
        payload,
    ))
}

async fn status_payload(
    settings: &RemoteSettings,
    status: &Arc<RwLock<RuntimeStatus>>,
    workspaces: &[AuthorizedWorkspace],
) -> Value {
    let current = status.read().await.clone();
    json!({
        "connection": current.connection,
        "paused": settings.paused,
        "deviceName": settings.device_name,
        "codexVersion": current.codex_version,
        "authType": current.auth_type,
        "codexAuthenticated": current.auth_type.is_some(),
        "workspaceCount": workspaces.len(),
        "activeSessions": current.active_sessions,
        "lastConnectedAt": current.last_connected_at,
    })
}

fn error_message(command: &RemoteMessage, code: &str, message: &str) -> RemoteMessage {
    RemoteMessage::event(
        "error",
        Some(command.message_id.clone()),
        command.session_id.clone(),
        command.turn_id.clone(),
        json!({"code": code, "message": message}),
    )
}

async fn send_remote<S>(
    writer: &mut S,
    settings: &RemoteSettings,
    sequence: &AtomicU64,
    target: Option<String>,
    message: RemoteMessage,
) -> Result<(), String>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    let frame = RelayFrame {
        protocol_version: PROTOCOL_VERSION,
        kind: "relay".into(),
        room_id: settings.room_id.clone(),
        sender_device_id: settings.desktop_device_id.clone(),
        target_device_id: target,
        message_id: uuid::Uuid::new_v4().to_string(),
        sequence: sequence.fetch_add(1, Ordering::Relaxed),
        nonce: String::new(),
        payload: String::new(),
    };
    let encrypted = encrypt_message(&settings.encryption_key, frame, &message)?;
    let text = serde_json::to_string(&encrypted).map_err(|_| "无法编码远控消息".to_string())?;
    if text.len() > MAX_RELAY_MESSAGE_BYTES {
        return Err("远控消息超过大小限制".to_string());
    }
    writer
        .send(Message::Text(text.into()))
        .await
        .map_err(|error| format!("无法发送远控消息：{error}"))
}

fn parse_json_message(message: Message) -> Result<Value, String> {
    match message {
        Message::Text(text) if text.len() <= MAX_RELAY_MESSAGE_BYTES => {
            serde_json::from_str(&text).map_err(|_| "中继消息格式无效".to_string())
        }
        Message::Binary(bytes) if bytes.len() <= MAX_RELAY_MESSAGE_BYTES => {
            serde_json::from_slice(&bytes).map_err(|_| "中继消息格式无效".to_string())
        }
        _ => Err("中继消息类型无效".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(kind: &str) -> RemoteMessage {
        RemoteMessage::event(kind, Some("request".into()), None, None, json!({}))
    }

    #[test]
    fn duplicate_inner_command_returns_cached_response() {
        let mut cache = CommandCache::default();
        cache.insert("command-1".into(), vec![response("session.created")]);

        let cached = cache.get("command-1").expect("response should be cached");
        assert_eq!(cached.len(), 1);
        assert_eq!(cached[0].message_type, "session.created");
        assert_eq!(cached[0].request_id.as_deref(), Some("request"));
    }

    #[test]
    fn command_caches_are_isolated_per_device() {
        let mut devices = HashMap::<String, CommandCache>::new();
        devices
            .entry("phone-a".into())
            .or_default()
            .insert("same-id".into(), vec![response("phone-a.response")]);
        devices
            .entry("phone-b".into())
            .or_default()
            .insert("same-id".into(), vec![response("phone-b.response")]);

        assert_eq!(
            devices["phone-a"].get("same-id").unwrap()[0].message_type,
            "phone-a.response"
        );
        assert_eq!(
            devices["phone-b"].get("same-id").unwrap()[0].message_type,
            "phone-b.response"
        );
    }

    #[test]
    fn command_cache_evicts_oldest_entry_at_limit() {
        let mut cache = CommandCache::default();
        for index in 0..=MAX_CACHED_COMMANDS {
            cache.insert(format!("command-{index}"), vec![response("ok")]);
        }

        assert_eq!(cache.responses.len(), MAX_CACHED_COMMANDS);
        assert_eq!(cache.order.len(), MAX_CACHED_COMMANDS);
        assert!(cache.get("command-0").is_none());
        assert!(
            cache
                .get(&format!("command-{MAX_CACHED_COMMANDS}"))
                .is_some()
        );
    }
}
