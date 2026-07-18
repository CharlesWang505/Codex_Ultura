export type RemoteSettings = {
  enabled: boolean
  paused: boolean
  relayUrl: string
  publicWebUrl: string
  deviceName: string
  desktopDeviceId: string
  roomId: string
  autoReconnect: boolean
  heartbeatSeconds: number
  lanPairingEnabled: boolean
  lanPairingPort: number
  lanAllowTailscale: boolean
}

export type AuthorizedWorkspace = {
  id: string
  name: string
  path: string
  allowWrite: boolean
  allowCommands: boolean
  allowUploads: boolean
}

export type WorkspacePermissionPatch = Partial<
  Pick<AuthorizedWorkspace, 'allowWrite' | 'allowCommands' | 'allowUploads'>
>

export type CodexProject = {
  id: string
  name: string
  path: string
  authorized: boolean
}

export type WorkspaceImportResult = {
  workspaces: AuthorizedWorkspace[]
  discovered: number
  imported: number
  skipped: number
}

export type RemoteControlSnapshot = {
  settings: RemoteSettings
  workspaces: AuthorizedWorkspace[]
  connection: 'disabled' | 'connecting' | 'connected' | 'disconnected'
  codexVersion?: string
  authType?: 'apiKey' | 'chatgpt' | string
  lastConnectedAt?: number
  lastMobileAt?: number
  lastError?: string
  activeSessions: number
  lanPairing: LanPairingSnapshot
  relayPairing: RelayPairingSnapshot
}

export type PairingInfo = {
  pairingUrl: string
  roomId: string
  desktopDeviceId: string
}

export type LanPairingInvitation = {
  code: string
  pairingUrls: string[]
  expiresAt: number
}

export type PendingLanPairing = {
  requestId: string
  deviceName: string
  browser: string
  platform: string
  remoteAddress: string
  requestedAt: number
  expiresAt: number
  verificationCode: string
  mode: 'invite' | 'direct' | string
}

export type LanPairingSnapshot = {
  status: 'disabled' | 'listening' | 'error' | string
  urls: string[]
  lastError?: string
  invitation?: {
    code: string
    expiresAt: number
  }
  pendingRequests: PendingLanPairing[]
}

export type OnlineRelayMobile = {
  deviceId: string
  deviceName: string
  browser: string
  platform: string
  connectedAt: number
  lastSeenAt: number
}

export type PendingRelayPairing = {
  pairingId: string
  remoteDeviceId: string
  deviceName: string
  browser: string
  platform: string
  mode: 'desktop_invite' | 'mobile_request' | string
  code: string
  requestedAt: number
  expiresAt: number
}

export type RelayPairingSnapshot = {
  onlineMobiles: OnlineRelayMobile[]
  pendingRequests: PendingRelayPairing[]
  lastError?: string
}

export type RelayPairingInvitation = {
  pairingId: string
  remoteDeviceId: string
  deviceName: string
  code: string
  expiresAt: number
}

export type RemoteMonitorMessage = {
  id: string
  role: 'user' | 'assistant' | 'tool' | string
  text: string
  timestamp: number
}

export type RemoteMonitorActivity = {
  id: string
  kind: string
  summary: string
  timestamp: number
}

export type RemoteMonitorSession = {
  sessionId: string
  title: string
  workspace: string
  remoteDeviceId: string
  status: 'ready' | 'waiting' | 'running' | 'completed' | 'stopped' | 'failed' | 'disconnected' | string
  turnId?: string
  createdAt: number
  updatedAt: number
  messages: RemoteMonitorMessage[]
  activities: RemoteMonitorActivity[]
}

export type RemoteMonitorSnapshot = {
  sequence: number
  sessions: RemoteMonitorSession[]
}
