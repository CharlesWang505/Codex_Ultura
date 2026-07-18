import { invoke } from '@tauri-apps/api/core'
import type {
  AuthorizedWorkspace,
  CodexProject,
  LanPairingInvitation,
  PairingInfo,
  RelayPairingInvitation,
  RemoteControlSnapshot,
  RemoteMonitorSnapshot,
  RemoteSettings,
  WorkspaceImportResult,
  WorkspacePermissionPatch,
} from './types'

export const getRemoteStatus = () => invoke<RemoteControlSnapshot>('remote_control_status')
export const getRemoteMonitorSnapshot = () =>
  invoke<RemoteMonitorSnapshot>('remote_control_monitor_snapshot')
export const saveRemoteSettings = (settings: RemoteSettings) =>
  invoke<RemoteControlSnapshot>('remote_control_save_settings', { settings })
export const reconnectRemote = () => invoke<RemoteControlSnapshot>('remote_control_reconnect')
export const setRemotePaused = (paused: boolean) =>
  invoke<RemoteControlSnapshot>('remote_control_set_paused', { paused })
export const getPairingInfo = () => invoke<PairingInfo>('remote_control_pairing_info')
export const createLanPairing = () =>
  invoke<LanPairingInvitation>('remote_control_create_lan_pairing')
export const cancelLanPairing = () =>
  invoke<RemoteControlSnapshot>('remote_control_cancel_lan_pairing')
export const approveLanPairing = (requestId: string) =>
  invoke<RemoteControlSnapshot>('remote_control_approve_lan_pairing', { requestId })
export const rejectLanPairing = (requestId: string) =>
  invoke<RemoteControlSnapshot>('remote_control_reject_lan_pairing', { requestId })
export const inviteRelayMobile = (deviceId: string) =>
  invoke<RelayPairingInvitation>('remote_control_invite_relay_mobile', { deviceId })
export const rejectRelayPairing = (pairingId: string) =>
  invoke<RemoteControlSnapshot>('remote_control_reject_relay_pairing', { pairingId })
export const refreshRelayMobiles = () =>
  invoke<RemoteControlSnapshot>('remote_control_refresh_relay_mobiles')
export const addRemoteWorkspace = (input: Omit<AuthorizedWorkspace, 'id'>) =>
  invoke<AuthorizedWorkspace[]>('remote_control_add_workspace', input)
export const removeRemoteWorkspace = (id: string) =>
  invoke<AuthorizedWorkspace[]>('remote_control_remove_workspace', { id })
export const updateRemoteWorkspacePermissions = (workspace: AuthorizedWorkspace) =>
  invoke<AuthorizedWorkspace[]>('remote_control_update_workspace_permissions', {
    id: workspace.id,
    allowWrite: workspace.allowWrite,
    allowCommands: workspace.allowCommands,
    allowUploads: workspace.allowUploads,
  })
export const updateAllRemoteWorkspacePermissions = (permissions: WorkspacePermissionPatch) =>
  invoke<AuthorizedWorkspace[]>('remote_control_update_all_workspace_permissions', {
    allowWrite: permissions.allowWrite ?? null,
    allowCommands: permissions.allowCommands ?? null,
    allowUploads: permissions.allowUploads ?? null,
  })
export const discoverCodexProjects = () =>
  invoke<CodexProject[]>('remote_control_discover_codex_projects')
export const importCodexProjects = () =>
  invoke<WorkspaceImportResult>('remote_control_import_codex_projects')
