mod attachments;
mod codex_adapter;
mod crypto;
mod lan_pairing;
mod manager;
mod monitor;
mod protocol;
mod relay_client;
mod relay_pairing;
mod sessions;
mod settings;
mod workspace;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

pub use manager::{RemoteControlManager, RemoteControlSnapshot};
use monitor::RemoteMonitorSnapshot;
use settings::PublicSettings;
use workspace::{AuthorizedWorkspace, WorkspaceImportResult};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PairingInfo {
    pub pairing_url: String,
    pub room_id: String,
    pub desktop_device_id: String,
}

pub fn setup(app: &AppHandle) -> Result<RemoteControlManager, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("remote-control");
    Ok(RemoteControlManager::new(root, app.clone()))
}

#[tauri::command]
pub async fn remote_control_status(
    manager: State<'_, RemoteControlManager>,
) -> Result<RemoteControlSnapshot, String> {
    manager.snapshot().await
}

#[tauri::command]
pub async fn remote_control_monitor_snapshot(
    manager: State<'_, RemoteControlManager>,
) -> Result<RemoteMonitorSnapshot, String> {
    Ok(manager.monitor_snapshot().await)
}

#[tauri::command]
pub async fn remote_control_save_settings(
    manager: State<'_, RemoteControlManager>,
    settings: PublicSettings,
) -> Result<RemoteControlSnapshot, String> {
    manager.save_settings(settings).await
}

#[tauri::command]
pub async fn remote_control_reconnect(
    manager: State<'_, RemoteControlManager>,
) -> Result<RemoteControlSnapshot, String> {
    manager.restart().await?;
    manager.snapshot().await
}

#[tauri::command]
pub async fn remote_control_set_paused(
    manager: State<'_, RemoteControlManager>,
    paused: bool,
) -> Result<RemoteControlSnapshot, String> {
    manager.set_paused(paused).await
}

#[tauri::command]
pub async fn remote_control_pairing_info(
    manager: State<'_, RemoteControlManager>,
) -> Result<PairingInfo, String> {
    let settings = manager.private_settings()?;
    if !settings.enabled {
        return Err("请先配置并开启手机远控".to_string());
    }
    settings::validate_settings(&settings)?;
    let separator = if settings.public_web_url.contains('?') {
        '&'
    } else {
        '?'
    };
    let pairing_url = format!(
        "{}{}room={}&desktop={}#token={}&key={}",
        settings.public_web_url.trim_end_matches('/'),
        separator,
        urlencoding::encode(&settings.room_id),
        urlencoding::encode(&settings.desktop_device_id),
        urlencoding::encode(&settings.access_token),
        urlencoding::encode(&settings.encryption_key),
    );
    Ok(PairingInfo {
        pairing_url,
        room_id: settings.room_id,
        desktop_device_id: settings.desktop_device_id,
    })
}

#[tauri::command]
pub async fn remote_control_create_lan_pairing(
    manager: State<'_, RemoteControlManager>,
) -> Result<lan_pairing::LanPairingInvitation, String> {
    manager.create_lan_pairing().await
}

#[tauri::command]
pub async fn remote_control_cancel_lan_pairing(
    manager: State<'_, RemoteControlManager>,
) -> Result<RemoteControlSnapshot, String> {
    manager.cancel_lan_pairing().await;
    manager.snapshot().await
}

#[tauri::command]
pub async fn remote_control_approve_lan_pairing(
    manager: State<'_, RemoteControlManager>,
    request_id: String,
) -> Result<RemoteControlSnapshot, String> {
    manager.approve_lan_pairing(&request_id).await?;
    manager.snapshot().await
}

#[tauri::command]
pub async fn remote_control_reject_lan_pairing(
    manager: State<'_, RemoteControlManager>,
    request_id: String,
) -> Result<RemoteControlSnapshot, String> {
    manager.reject_lan_pairing(&request_id).await?;
    manager.snapshot().await
}

#[tauri::command]
pub async fn remote_control_invite_relay_mobile(
    manager: State<'_, RemoteControlManager>,
    device_id: String,
) -> Result<relay_pairing::RelayPairingInvitation, String> {
    manager.invite_relay_mobile(&device_id).await
}

#[tauri::command]
pub async fn remote_control_reject_relay_pairing(
    manager: State<'_, RemoteControlManager>,
    pairing_id: String,
) -> Result<RemoteControlSnapshot, String> {
    manager.reject_relay_pairing(&pairing_id).await?;
    manager.snapshot().await
}

#[tauri::command]
pub async fn remote_control_refresh_relay_mobiles(
    manager: State<'_, RemoteControlManager>,
) -> Result<RemoteControlSnapshot, String> {
    manager.refresh_relay_mobiles().await?;
    tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    manager.snapshot().await
}

#[tauri::command]
pub async fn remote_control_add_workspace(
    manager: State<'_, RemoteControlManager>,
    name: String,
    path: String,
    allow_write: bool,
    allow_commands: bool,
    allow_uploads: bool,
) -> Result<Vec<AuthorizedWorkspace>, String> {
    let workspaces =
        manager.add_workspace(name, path, allow_write, allow_commands, allow_uploads)?;
    manager.restart().await?;
    Ok(workspaces)
}

#[tauri::command]
pub async fn remote_control_remove_workspace(
    manager: State<'_, RemoteControlManager>,
    id: String,
) -> Result<Vec<AuthorizedWorkspace>, String> {
    let workspaces = manager.remove_workspace(&id)?;
    manager.restart().await?;
    Ok(workspaces)
}

#[tauri::command]
pub async fn remote_control_update_workspace_permissions(
    manager: State<'_, RemoteControlManager>,
    id: String,
    allow_write: bool,
    allow_commands: bool,
    allow_uploads: bool,
) -> Result<Vec<AuthorizedWorkspace>, String> {
    let workspaces =
        manager.update_workspace_permissions(&id, allow_write, allow_commands, allow_uploads)?;
    manager.restart().await?;
    Ok(workspaces)
}

#[tauri::command]
pub async fn remote_control_update_all_workspace_permissions(
    manager: State<'_, RemoteControlManager>,
    allow_write: Option<bool>,
    allow_commands: Option<bool>,
    allow_uploads: Option<bool>,
) -> Result<Vec<AuthorizedWorkspace>, String> {
    let workspaces =
        manager.update_all_workspace_permissions(allow_write, allow_commands, allow_uploads)?;
    manager.restart().await?;
    Ok(workspaces)
}

#[tauri::command]
pub fn remote_control_discover_codex_projects(
    manager: State<'_, RemoteControlManager>,
) -> Result<Vec<codex_adapter::CodexProject>, String> {
    manager.discover_codex_projects()
}

#[tauri::command]
pub async fn remote_control_import_codex_projects(
    manager: State<'_, RemoteControlManager>,
) -> Result<WorkspaceImportResult, String> {
    let result = manager.import_codex_projects()?;
    manager.restart().await?;
    Ok(result)
}
