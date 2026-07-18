import { createHash, timingSafeEqual } from 'node:crypto'

export const PROTOCOL_VERSION = 1
export const MAX_MESSAGE_BYTES = 512 * 1024
export const MAX_MESSAGES_PER_MINUTE = 600
export const PAIRING_TTL_MS = 2 * 60 * 1_000
export const MAX_DISCOVERY_MOBILES = 64

const DEVICE_ID_PATTERN = /^[A-Za-z0-9-]{8,128}$/
const PAIRING_KINDS = new Set([
  'pairing.request',
  'pairing.invite',
  'pairing.challenge',
  'pairing.proof',
  'pairing.completed',
  'pairing.rejected',
  'pairing.cancelled',
  'pairing.error',
])

export function tokenDigest(token) {
  return createHash('sha256').update(String(token), 'utf8').digest()
}

export function tokenMatches(token, digest) {
  const candidate = tokenDigest(token)
  return candidate.length === digest.length && timingSafeEqual(candidate, digest)
}

export function validateAuth(value) {
  if (!value || value.protocolVersion !== PROTOCOL_VERSION || value.kind !== 'auth') {
    return '协议版本或认证消息无效'
  }
  if (!['desktop', 'mobile'].includes(value.role)) return '设备角色无效'
  if (!/^[A-Za-z0-9-]{16,128}$/.test(value.roomId || '')) return '房间 ID 无效'
  if (!DEVICE_ID_PATTERN.test(value.deviceId || '')) return '设备 ID 无效'
  if (typeof value.token !== 'string' || value.token.length < 32 || value.token.length > 256) {
    return '访问密钥无效'
  }
  return null
}

function cleanText(value, maxLength, fallback = '') {
  const cleaned = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, maxLength)
  return cleaned || fallback
}

export function validateMobilePresence(value) {
  if (!value || value.protocolVersion !== PROTOCOL_VERSION || value.kind !== 'presence.mobile.register') {
    return '设备发现消息无效'
  }
  if (!DEVICE_ID_PATTERN.test(value.deviceId || '')) return '设备 ID 无效'
  if (typeof value.deviceName !== 'string' || value.deviceName.length > 80) return '设备名称无效'
  if (typeof value.browser !== 'string' || value.browser.length > 240) return '浏览器信息无效'
  if (typeof value.platform !== 'string' || value.platform.length > 120) return '系统信息无效'
  return null
}

export function validateDesktopPresence(value, connection) {
  if (!value || value.protocolVersion !== PROTOCOL_VERSION || value.kind !== 'presence.desktop.status') return false
  if (connection.role !== 'desktop') return false
  if (value.senderDeviceId != null && value.senderDeviceId !== connection.deviceId) return false
  return value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
}

export function validatePairingFrame(value, connection) {
  if (!value || value.protocolVersion !== PROTOCOL_VERSION || !PAIRING_KINDS.has(value.kind)) return false
  if (!DEVICE_ID_PATTERN.test(value.senderDeviceId || '') || value.senderDeviceId !== connection.deviceId) return false
  if (!DEVICE_ID_PATTERN.test(value.targetDeviceId || '')) return false
  if (typeof value.pairingId !== 'string' || value.pairingId.length < 16 || value.pairingId.length > 128) return false
  return value.payload == null || (typeof value.payload === 'object' && !Array.isArray(value.payload))
}

export function validateRelayFrame(value, connection) {
  if (!value || value.protocolVersion !== PROTOCOL_VERSION || value.kind !== 'relay') return false
  if (value.roomId !== connection.roomId || value.senderDeviceId !== connection.deviceId) return false
  if (typeof value.messageId !== 'string' || value.messageId.length < 8 || value.messageId.length > 128) return false
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 1) return false
  if (typeof value.nonce !== 'string' || typeof value.payload !== 'string') return false
  if (value.targetDeviceId != null && typeof value.targetDeviceId !== 'string') return false
  return true
}

export class SlidingRateLimit {
  constructor(limit = MAX_MESSAGES_PER_MINUTE, windowMs = 60_000) {
    this.limit = limit
    this.windowMs = windowMs
    this.timestamps = []
  }

  accept(now = Date.now()) {
    while (this.timestamps.length && this.timestamps[0] <= now - this.windowMs) this.timestamps.shift()
    if (this.timestamps.length >= this.limit) return false
    this.timestamps.push(now)
    return true
  }
}

export class RoomRegistry {
  constructor() {
    this.rooms = new Map()
  }

  authenticate(auth, socket) {
    const error = validateAuth(auth)
    if (error) return { error }
    let room = this.rooms.get(auth.roomId)
    if (!room) {
      if (auth.role !== 'desktop') return { error: '电脑设备离线或尚未注册房间' }
      room = { tokenDigest: tokenDigest(auth.token), connections: new Map() }
      this.rooms.set(auth.roomId, room)
    } else if (!tokenMatches(auth.token, room.tokenDigest)) {
      return { error: '房间访问密钥不匹配' }
    }
    const existing = room.connections.get(auth.deviceId)
    if (existing && existing.socket !== socket) existing.socket.close(4002, 'replaced')
    const connection = {
      socket,
      channel: 'room',
      roomId: auth.roomId,
      deviceId: auth.deviceId,
      role: auth.role,
      limiter: new SlidingRateLimit(),
      pairingLimiter: new SlidingRateLimit(12, 2 * 60_000),
      uploadLimiter: new SlidingRateLimit(30),
    }
    room.connections.set(auth.deviceId, connection)
    return { room, connection }
  }

  remove(connection) {
    const room = this.rooms.get(connection.roomId)
    if (!room) return
    if (room.connections.get(connection.deviceId)?.socket === connection.socket) {
      room.connections.delete(connection.deviceId)
    }
    if (room.connections.size === 0) this.rooms.delete(connection.roomId)
  }

  authorizeDevice({ roomId, deviceId, token, role }) {
    const room = this.rooms.get(roomId)
    if (!room || !tokenMatches(token, room.tokenDigest)) return false
    const connection = room.connections.get(deviceId)
    return connection?.role === role
  }

  authorizeUpload({ roomId, deviceId, targetDeviceId, token }) {
    const room = this.rooms.get(roomId)
    if (!room || !tokenMatches(token, room.tokenDigest)) return false
    const sender = room.connections.get(deviceId)
    const target = room.connections.get(targetDeviceId)
    return sender?.role === 'mobile'
      && target?.role === 'desktop'
      && sender.uploadLimiter.accept()
  }

  targets(connection, targetDeviceId) {
    const room = this.rooms.get(connection.roomId)
    if (!room) return []
    if (targetDeviceId) {
      const target = room.connections.get(targetDeviceId)
      const validRoles = connection.role === 'mobile'
        ? target?.role === 'desktop'
        : connection.role === 'desktop' && target?.role === 'mobile'
      return target && target.socket !== connection.socket && validRoles ? [target] : []
    }
    if (connection.role !== 'desktop') return []
    return [...room.connections.values()].filter((item) => item.socket !== connection.socket && item.role === 'mobile')
  }
}

export class PresenceRegistry {
  constructor({
    pairingTtlMs = PAIRING_TTL_MS,
    maxMobiles = MAX_DISCOVERY_MOBILES,
  } = {}) {
    this.pairingTtlMs = pairingTtlMs
    this.maxMobiles = maxMobiles
    this.mobiles = new Map()
    this.desktops = new Map()
    this.pairings = new Map()
  }

  registerMobile(value, socket, remoteAddress = '') {
    const error = validateMobilePresence(value)
    if (error) return { error }
    this.purge()
    const existing = this.mobiles.get(value.deviceId)
    if (!existing && this.mobiles.size >= this.maxMobiles) {
      return { error: '临时在线手机数量已达上限' }
    }
    if (existing && existing.socket !== socket) existing.socket.close(4002, 'replaced')
    const now = Date.now()
    const connection = {
      socket,
      channel: 'presence',
      role: 'mobile',
      deviceId: value.deviceId,
      deviceName: cleanText(value.deviceName, 80, '未命名手机'),
      browser: cleanText(value.browser, 240, '手机浏览器'),
      platform: cleanText(value.platform, 120, '未知系统'),
      remoteAddress: cleanText(remoteAddress, 80),
      connectedAt: existing?.connectedAt || now,
      lastSeenAt: now,
      limiter: new SlidingRateLimit(120),
      pairingLimiter: new SlidingRateLimit(12, 2 * 60_000),
    }
    this.mobiles.set(connection.deviceId, connection)
    return { connection }
  }

  registerDesktop(connection, value) {
    if (!validateDesktopPresence(value, connection)) return { error: '电脑在线状态无效' }
    const now = Date.now()
    const previous = this.desktops.get(connection.deviceId)
    const payload = value.payload || {}
    const status = {
      deviceId: connection.deviceId,
      deviceName: cleanText(payload.deviceName, 80, 'Codex Compass'),
      online: true,
      remoteEnabled: Boolean(payload.remoteEnabled),
      paused: Boolean(payload.paused),
      codexInstalled: Boolean(payload.codexInstalled),
      codexRunning: Boolean(payload.codexRunning),
      codexAuthenticated: Boolean(payload.codexAuthenticated),
      appServerAvailable: Boolean(payload.appServerAvailable),
      codexVersion: cleanText(payload.codexVersion, 80),
      activeSessions: Number.isSafeInteger(payload.activeSessions)
        ? Math.max(0, Math.min(payload.activeSessions, 10_000))
        : 0,
      lastHeartbeatAt: now,
      connectedAt: previous?.status.connectedAt || now,
    }
    this.desktops.set(connection.deviceId, { connection, status })
    return { status }
  }

  touchMobile(connection) {
    const current = this.mobiles.get(connection.deviceId)
    if (!current || current.socket !== connection.socket) return false
    current.lastSeenAt = Date.now()
    return true
  }

  remove(connection) {
    const events = []
    if (connection.channel === 'presence') {
      const mobile = this.mobiles.get(connection.deviceId)
      if (mobile?.socket === connection.socket) {
        this.mobiles.delete(connection.deviceId)
        events.push({
          recipients: this.desktopConnections(),
          message: {
            protocolVersion: PROTOCOL_VERSION,
            kind: 'presence.mobile.offline',
            deviceId: connection.deviceId,
            timestamp: Date.now(),
          },
        })
      }
    } else if (connection.role === 'desktop') {
      const desktop = this.desktops.get(connection.deviceId)
      if (desktop?.connection.socket === connection.socket) {
        this.desktops.delete(connection.deviceId)
        events.push({
          recipients: [...this.mobiles.values()],
          message: {
            protocolVersion: PROTOCOL_VERSION,
            kind: 'presence.desktop.offline',
            deviceId: connection.deviceId,
            timestamp: Date.now(),
          },
        })
      }
    }
    for (const [pairingId, pairing] of this.pairings) {
      if (pairing.mobileDeviceId === connection.deviceId || pairing.desktopDeviceId === connection.deviceId) {
        this.pairings.delete(pairingId)
      }
    }
    return events
  }

  mobileList() {
    this.purge()
    return [...this.mobiles.values()]
      .map((connection) => this.mobileStatus(connection))
      .sort((left, right) => right.connectedAt - left.connectedAt)
  }

  desktopList() {
    this.purge()
    return [...this.desktops.values()]
      .map(({ status }) => ({ ...status }))
      .sort((left, right) => right.connectedAt - left.connectedAt)
  }

  mobileStatus(connection) {
    return {
      deviceId: connection.deviceId,
      deviceName: connection.deviceName,
      browser: connection.browser,
      platform: connection.platform,
      connectedAt: connection.connectedAt,
      lastSeenAt: connection.lastSeenAt,
    }
  }

  desktopConnections() {
    return [...this.desktops.values()].map(({ connection }) => connection)
  }

  mobileConnections() {
    return [...this.mobiles.values()]
  }

  pairingRoute(value, connection, now = Date.now()) {
    this.purge(now)
    if (!validatePairingFrame(value, connection)) return { error: '配对消息无效' }
    if (!connection.pairingLimiter?.accept(now)) return { error: '配对请求过于频繁' }
    const senderIsDesktop = connection.role === 'desktop' && connection.channel === 'room'
    const senderIsMobile = connection.role === 'mobile' && connection.channel === 'presence'
    const expectedDesktopKinds = new Set([
      'pairing.invite',
      'pairing.challenge',
      'pairing.completed',
      'pairing.rejected',
      'pairing.error',
      'pairing.cancelled',
    ])
    const expectedMobileKinds = new Set([
      'pairing.request',
      'pairing.proof',
      'pairing.cancelled',
    ])
    if ((senderIsDesktop && !expectedDesktopKinds.has(value.kind))
      || (senderIsMobile && !expectedMobileKinds.has(value.kind))) {
      return { error: '配对消息角色无效' }
    }
    const target = senderIsDesktop
      ? this.mobiles.get(value.targetDeviceId)
      : this.desktops.get(value.targetDeviceId)?.connection
    if (!target) return { error: '目标设备已离线' }

    let pairing = this.pairings.get(value.pairingId)
    if (value.kind === 'pairing.request' || value.kind === 'pairing.invite') {
      if (pairing) return { error: '配对请求已经存在' }
      pairing = {
        pairingId: value.pairingId,
        mobileDeviceId: senderIsMobile ? connection.deviceId : value.targetDeviceId,
        desktopDeviceId: senderIsDesktop ? connection.deviceId : value.targetDeviceId,
        expiresAt: now + this.pairingTtlMs,
        state: value.kind === 'pairing.request' ? 'requested' : 'invited',
      }
      this.pairings.set(value.pairingId, pairing)
    } else {
      if (!pairing || pairing.expiresAt <= now) return { error: '配对请求不存在或已过期' }
      if (pairing.mobileDeviceId !== (senderIsMobile ? connection.deviceId : value.targetDeviceId)
        || pairing.desktopDeviceId !== (senderIsDesktop ? connection.deviceId : value.targetDeviceId)) {
        return { error: '配对请求设备不匹配' }
      }
      if (value.kind === 'pairing.challenge' && pairing.state !== 'requested') {
        return { error: '配对请求状态无效' }
      }
      if (value.kind === 'pairing.proof' && !['invited', 'challenged', 'proof'].includes(pairing.state)) {
        return { error: '配对请求尚未接受验证码' }
      }
      if (value.kind === 'pairing.completed' && pairing.state !== 'proof') {
        return { error: '配对证明尚未验证' }
      }
    }

    if (value.kind === 'pairing.challenge') pairing.state = 'challenged'
    if (value.kind === 'pairing.proof') pairing.state = 'proof'
    const terminal = ['pairing.completed', 'pairing.rejected', 'pairing.cancelled'].includes(value.kind)
    const forwarded = {
      ...value,
      expiresAt: pairing.expiresAt,
      timestamp: now,
    }
    if (terminal) this.pairings.delete(value.pairingId)
    return { target, message: forwarded }
  }

  purge(now = Date.now()) {
    for (const [pairingId, pairing] of this.pairings) {
      if (pairing.expiresAt <= now) this.pairings.delete(pairingId)
    }
  }
}
