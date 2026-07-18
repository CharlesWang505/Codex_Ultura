import {
  capabilitySearchText,
  localizePlugin,
  localizeScope,
  localizeSkill,
} from './capability-i18n.js'
import {
  createRelayPairingExchange,
  decryptRelayPairingCredentials,
} from './relay-pairing-crypto.js'
import { renderMessageMarkdown } from './message-format.js'

const PROTOCOL_VERSION = 1
const MAX_MESSAGE_BYTES = 512 * 1024
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENTS = 5
const MAX_SELECTED_SKILLS = 8
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]))
const query = new URLSearchParams(location.search)
const fragment = new URLSearchParams(location.hash.slice(1))
const storedCredentialsKey = 'codexCompassRemoteCredentials:v1'
const suppliedCredentials = {
  roomId: query.get('room') || '',
  desktopDeviceId: query.get('desktop') || '',
  token: fragment.get('token') || '',
  key: fragment.get('key') || '',
}
const storedCredentials = (() => {
  try {
    return JSON.parse(localStorage.getItem(storedCredentialsKey) || 'null') || {}
  } catch {
    return {}
  }
})()
const suppliedCredentialsComplete = suppliedCredentials.roomId
  && suppliedCredentials.desktopDeviceId
  && suppliedCredentials.token.length >= 32
  && suppliedCredentials.key.length >= 32
const credentials = suppliedCredentialsComplete ? suppliedCredentials : {
  roomId: storedCredentials.roomId || '',
  desktopDeviceId: storedCredentials.desktopDeviceId || '',
  token: storedCredentials.token || '',
  key: storedCredentials.key || '',
}
const credentialsComplete = Boolean(
  credentials.roomId
  && credentials.desktopDeviceId
  && credentials.token.length >= 32
  && credentials.key.length >= 32,
)
if (suppliedCredentialsComplete) {
  localStorage.setItem(storedCredentialsKey, JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    ...suppliedCredentials,
  }))
  query.delete('room')
  query.delete('desktop')
  const cleanSearch = query.toString()
  history.replaceState(null, '', `${location.pathname}${cleanSearch ? `?${cleanSearch}` : ''}`)
}
const outgoingSequenceKey = `codexCompassRemoteSequence:${credentials.roomId}:${credentials.desktopDeviceId}`
const incomingSequenceKey = `codexCompassRemoteHighestSequence:${credentials.roomId}:${credentials.desktopDeviceId}`
const storedOutgoingSequence = Number(localStorage.getItem(outgoingSequenceKey))
const storedIncomingSequence = Number(localStorage.getItem(incomingSequenceKey))

const state = {
  socket: null,
  presenceSocket: null,
  cryptoKey: null,
  sequence: Math.max(
    Date.now() * 1000,
    Number.isSafeInteger(storedOutgoingSequence) ? storedOutgoingSequence + 1 : 1,
  ),
  highestSequence: Number.isSafeInteger(storedIncomingSequence) ? storedIncomingSequence : 0,
  seenMessages: new Set(),
  deviceId: localStorage.getItem('codexCompassRemoteDeviceId') || crypto.randomUUID(),
  connected: false,
  presenceConnected: false,
  desktopOnline: false,
  desktops: [],
  pairing: null,
  pairingTimer: null,
  presenceHeartbeatTimer: null,
  presenceReconnectTimer: null,
  presenceIntentionalClose: false,
  status: null,
  workspaces: [],
  models: [],
  sessions: [],
  sessionProjects: [],
  sessionPage: {
    nextCursor: null,
    total: 0,
    active: 0,
    archived: 0,
    loaded: 0,
  },
  sessionStatus: 'active',
  sessionLoading: false,
  sessionGeneration: 0,
  sessionRequests: new Map(),
  projectPages: new Map(),
  loadingProjects: new Set(),
  collapsedProjects: new Set(),
  currentSession: null,
  currentTurnId: null,
  pendingAssistant: null,
  reconnectTimer: null,
  intentionalClose: false,
  queuedPrompt: null,
  sessionFilter: '',
  attachments: {
    new: [],
    composer: [],
  },
  selectedSkills: {
    new: new Set(),
    composer: new Set(),
  },
  capabilities: {
    new: null,
    composer: null,
  },
  capabilityRequests: new Map(),
  capabilityTarget: 'new',
  capabilitySearch: '',
  uploading: false,
}
localStorage.setItem('codexCompassRemoteDeviceId', state.deviceId)

function icon(name, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  if (className) svg.setAttribute('class', className)
  const definitions = {
    task: ['<path d="M9 5h9M9 12h9M9 19h9"></path>', '<path d="m3 5 1 1 2-2M3 12h3M3 19h3"></path>'],
    chevron: ['<path d="m9 18 6-6-6-6"></path>'],
    folder: ['<path d="M3 6.5h6l2 2h10v9.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path>', '<path d="M3 10h18"></path>'],
    archive: ['<path d="M4 7h16M5 7v12h14V7M3 4h18v3H3Z"></path>', '<path d="M10 11h4"></path>'],
    empty: ['<rect width="16" height="18" x="4" y="3" rx="2"></rect>', '<path d="M8 8h8M8 12h8M8 16h5"></path>'],
    close: ['<path d="m7 7 10 10M17 7 7 17"></path>'],
    file: ['<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path>', '<path d="M14 2v6h6"></path>'],
    skill: ['<rect width="7" height="7" x="3" y="3" rx="1"></rect>', '<rect width="7" height="7" x="14" y="3" rx="1"></rect>', '<rect width="7" height="7" x="3" y="14" rx="1"></rect>', '<path d="M17.5 14v7M14 17.5h7"></path>'],
    computer: ['<rect width="18" height="12" x="3" y="3" rx="1.5"></rect>', '<path d="M8 21h8M12 15v6"></path>'],
  }
  svg.innerHTML = (definitions[name] || []).join('')
  return svg
}

function base64UrlToBytes(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

function bytesToBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function associatedData(frame) {
  return encoder.encode(
    `${frame.protocolVersion}\n${frame.kind}\n${frame.roomId}\n${frame.senderDeviceId}\n${frame.targetDeviceId || ''}\n${frame.messageId}\n${frame.sequence}`,
  )
}

async function encryptMessage(message, targetDeviceId = credentials.desktopDeviceId) {
  const frame = {
    protocolVersion: PROTOCOL_VERSION,
    kind: 'relay',
    roomId: credentials.roomId,
    senderDeviceId: state.deviceId,
    targetDeviceId,
    messageId: crypto.randomUUID(),
    sequence: state.sequence++,
    nonce: '',
    payload: '',
  }
  localStorage.setItem(outgoingSequenceKey, String(frame.sequence))
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: associatedData(frame), tagLength: 128 },
    state.cryptoKey,
    encoder.encode(JSON.stringify(message)),
  )
  frame.nonce = bytesToBase64Url(nonce)
  frame.payload = bytesToBase64Url(new Uint8Array(ciphertext))
  return frame
}

async function decryptMessage(frame) {
  if (frame.protocolVersion !== PROTOCOL_VERSION || frame.roomId !== credentials.roomId) throw new Error('协议不兼容')
  if (frame.senderDeviceId !== credentials.desktopDeviceId) throw new Error('来源设备无效')
  if (frame.targetDeviceId && frame.targetDeviceId !== state.deviceId) throw new Error('目标设备无效')
  if (!Number.isSafeInteger(frame.sequence) || frame.sequence <= state.highestSequence || state.seenMessages.has(frame.messageId)) {
    throw new Error('消息重复或乱序')
  }
  const plaintext = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64UrlToBytes(frame.nonce),
      additionalData: associatedData(frame),
      tagLength: 128,
    },
    state.cryptoKey,
    base64UrlToBytes(frame.payload),
  )
  state.highestSequence = frame.sequence
  localStorage.setItem(incomingSequenceKey, String(frame.sequence))
  state.seenMessages.add(frame.messageId)
  if (state.seenMessages.size > 2048) state.seenMessages.delete(state.seenMessages.values().next().value)
  return JSON.parse(decoder.decode(plaintext))
}

function remoteMessage(type, payload = {}, sessionId = null, turnId = null) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    messageId: crypto.randomUUID(),
    timestamp: Date.now(),
    requestId: null,
    sessionId,
    turnId,
    type,
    payload,
  }
}

async function send(type, payload = {}, sessionId = null, turnId = null) {
  if (!state.connected || state.socket?.readyState !== WebSocket.OPEN) throw new Error('尚未连接中继服务器')
  const message = remoteMessage(type, payload, sessionId, turnId)
  const frame = await encryptMessage(message)
  const serialized = JSON.stringify(frame)
  if (encoder.encode(serialized).length > MAX_MESSAGE_BYTES) throw new Error('消息超过大小限制')
  state.socket.send(serialized)
  return message.messageId
}

function websocketUrl() {
  const url = new URL('/ws', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}

const mobileDeviceNameKey = 'codexCompassRemoteDeviceName'

function browserName() {
  const brands = navigator.userAgentData?.brands
  if (Array.isArray(brands) && brands.length > 0) {
    return brands
      .filter((brand) => !/Not.A.Brand/i.test(brand.brand))
      .map((brand) => `${brand.brand} ${brand.version}`)
      .join(', ')
      .slice(0, 240)
  }
  const agent = navigator.userAgent
  if (/Edg\//.test(agent)) return 'Microsoft Edge'
  if (/CriOS|Chrome\//.test(agent)) return 'Google Chrome'
  if (/FxiOS|Firefox\//.test(agent)) return 'Mozilla Firefox'
  if (/Safari\//.test(agent)) return 'Safari'
  return '手机浏览器'
}

function platformName() {
  return String(navigator.userAgentData?.platform || navigator.platform || '未知系统').slice(0, 120)
}

function defaultMobileDeviceName() {
  const platform = platformName()
  return `${platform === '未知系统' ? '我的' : platform} 手机`.slice(0, 80)
}

function currentMobileDeviceName() {
  return (elements.mobileDeviceName?.value || localStorage.getItem(mobileDeviceNameKey) || defaultMobileDeviceName())
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 80) || '未命名手机'
}

function sendPresence(value) {
  if (!state.presenceConnected || state.presenceSocket?.readyState !== WebSocket.OPEN) {
    throw new Error('手机网页尚未连接中继服务器')
  }
  state.presenceSocket.send(JSON.stringify({
    protocolVersion: PROTOCOL_VERSION,
    messageId: crypto.randomUUID(),
    ...value,
  }))
}

function discoveryAvailability(desktop) {
  if (!desktop.remoteEnabled) return { available: false, text: '远控未开启', level: '' }
  if (desktop.paused) return { available: false, text: '电脑已暂停远控', level: 'warn' }
  if (!desktop.appServerAvailable) return { available: false, text: 'Codex 后端不可用', level: 'warn' }
  if (!desktop.codexAuthenticated) return { available: false, text: 'Codex 尚未登录', level: 'warn' }
  return {
    available: true,
    text: `Codex 在线 · ${desktop.activeSessions || 0} 个活动任务`,
    level: 'online',
  }
}

function renderDesktopDiscovery() {
  if (!elements.desktopDiscoveryList) return
  elements.desktopDiscoveryList.replaceChildren()
  if (state.desktops.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'desktop-discovery-empty'
    empty.textContent = state.presenceConnected
      ? '暂未发现在线电脑。请确认电脑端已开启手机远控并连接同一个中继网站。'
      : '正在连接中继网站并查找在线电脑...'
    elements.desktopDiscoveryList.append(empty)
    return
  }
  for (const desktop of state.desktops) {
    const availability = discoveryAvailability(desktop)
    const row = document.createElement('article')
    row.className = 'desktop-discovery-row'
    const symbol = document.createElement('div')
    symbol.className = 'desktop-discovery-icon'
    symbol.append(icon('computer'))
    const copy = document.createElement('div')
    copy.className = 'desktop-discovery-copy'
    const name = document.createElement('strong')
    name.textContent = desktop.deviceName || 'Codex Compass'
    const detail = document.createElement('span')
    detail.textContent = desktop.codexVersion
      ? `${desktop.codexVersion} · ${desktop.deviceId.slice(0, 8)}`
      : `设备 ${desktop.deviceId.slice(0, 8)}`
    const health = document.createElement('div')
    health.className = 'desktop-discovery-health'
    const indicator = document.createElement('i')
    indicator.className = availability.level
    const status = document.createElement('span')
    status.textContent = availability.text
    health.append(indicator, status)
    copy.append(name, detail, health)
    const connectButton = document.createElement('button')
    connectButton.type = 'button'
    connectButton.disabled = !availability.available || Boolean(state.pairing)
    connectButton.textContent = availability.available ? '连接' : '不可连接'
    connectButton.addEventListener('click', () => requestDesktopPairing(desktop))
    row.append(symbol, copy, connectButton)
    elements.desktopDiscoveryList.append(row)
  }
}

function applyDesktopPresence(desktop) {
  if (!desktop?.deviceId) return
  const existing = state.desktops.findIndex((item) => item.deviceId === desktop.deviceId)
  if (existing >= 0) state.desktops[existing] = desktop
  else state.desktops.push(desktop)
  state.desktops.sort((left, right) => (right.connectedAt || 0) - (left.connectedAt || 0))
  if (credentialsComplete && desktop.deviceId === credentials.desktopDeviceId) {
    state.desktopOnline = true
    state.status = { ...(state.status || {}), ...desktop }
    updateDeviceStatus()
  }
  renderDesktopDiscovery()
}

function removeDesktopPresence(deviceId) {
  state.desktops = state.desktops.filter((desktop) => desktop.deviceId !== deviceId)
  if (credentialsComplete && deviceId === credentials.desktopDeviceId) {
    state.desktopOnline = false
    updateDeviceStatus()
  }
  renderDesktopDiscovery()
}

function updatePairingDialog() {
  const pairing = state.pairing
  elements.pairingDialog.hidden = !pairing
  if (!pairing) return
  const ready = Boolean(pairing.desktopPublicKey)
  const verifying = pairing.stage === 'verifying'
  elements.pairingDialogMode.textContent = pairing.mode === 'desktop_invite'
    ? '电脑发起邀请'
    : '手机发起请求'
  elements.pairingDialogTitle.textContent = pairing.desktopName || '连接电脑'
  elements.pairingDialogMessage.textContent = ready
    ? '请查看电脑端“手机远控”页面显示的六位配对码，并在这里输入。'
    : '请求已发送。请在电脑端打开“手机远控”，等待电脑生成六位配对码。'
  elements.pairingDialogStatus.textContent = verifying
    ? '正在验证并接收加密凭据'
    : ready ? '等待输入电脑配对码' : '等待电脑响应'
  elements.relayPairingCode.disabled = !ready || verifying
  elements.submitPairingButton.disabled = !ready || verifying
  const seconds = Math.max(0, Math.ceil(((pairing.expiresAt || Date.now()) - Date.now()) / 1000))
  elements.pairingDialogExpiry.textContent = seconds > 0 ? `${seconds} 秒后失效` : '配对请求已失效'
  if (seconds <= 0) {
    elements.relayPairingCode.disabled = true
    elements.submitPairingButton.disabled = true
  } else if (ready && !verifying) {
    elements.relayPairingCode.focus()
  }
}

function beginPairingDialog(pairing) {
  state.pairing = pairing
  elements.relayPairingCode.value = ''
  clearInterval(state.pairingTimer)
  state.pairingTimer = setInterval(updatePairingDialog, 1_000)
  updatePairingDialog()
  renderDesktopDiscovery()
}

function closePairingDialog({ notifyDesktop = false } = {}) {
  const pairing = state.pairing
  if (notifyDesktop && pairing && state.presenceConnected) {
    try {
      sendPresence({
        kind: 'pairing.cancelled',
        pairingId: pairing.pairingId,
        senderDeviceId: state.deviceId,
        targetDeviceId: pairing.desktopDeviceId,
        payload: {},
      })
    } catch {
      // The presence socket may already be closing.
    }
  }
  clearInterval(state.pairingTimer)
  state.pairingTimer = null
  state.pairing = null
  elements.pairingDialog.hidden = true
  elements.relayPairingCode.value = ''
  renderDesktopDiscovery()
}

function requestDesktopPairing(desktop) {
  if (!state.presenceConnected || state.pairing) return
  const pairingId = crypto.randomUUID()
  beginPairingDialog({
    pairingId,
    desktopDeviceId: desktop.deviceId,
    desktopName: desktop.deviceName || 'Codex Compass',
    desktopPublicKey: '',
    expiresAt: Date.now() + 120_000,
    mode: 'mobile_request',
    stage: 'waiting',
  })
  try {
    sendPresence({
      kind: 'pairing.request',
      pairingId,
      senderDeviceId: state.deviceId,
      targetDeviceId: desktop.deviceId,
      payload: {
        deviceId: state.deviceId,
        deviceName: currentMobileDeviceName(),
        browser: browserName(),
        platform: platformName(),
      },
    })
  } catch (error) {
    closePairingDialog()
    showToast(error.message)
  }
}

function submitRelayPairingCode() {
  const pairing = state.pairing
  if (!pairing?.desktopPublicKey || pairing.stage === 'verifying') return
  const code = elements.relayPairingCode.value.replace(/\D/g, '').slice(0, 6)
  if (code.length !== 6) {
    showToast('请输入电脑端显示的六位配对码')
    return
  }
  try {
    const exchange = createRelayPairingExchange({
      code,
      pairingId: pairing.pairingId,
      mobileDeviceId: state.deviceId,
      desktopDeviceId: pairing.desktopDeviceId,
      desktopPublicKey: pairing.desktopPublicKey,
    })
    pairing.exchange = exchange
    pairing.stage = 'verifying'
    sendPresence({
      kind: 'pairing.proof',
      pairingId: pairing.pairingId,
      senderDeviceId: state.deviceId,
      targetDeviceId: pairing.desktopDeviceId,
      payload: {
        clientPublicKey: exchange.clientPublicKey,
        requestNonce: exchange.requestNonce,
        proof: exchange.proof,
      },
    })
    updatePairingDialog()
  } catch (error) {
    pairing.stage = 'ready'
    updatePairingDialog()
    showToast(error.message || '无法提交配对码')
  }
}

function completeRelayPairing(value) {
  const pairing = state.pairing
  if (!pairing || value.pairingId !== pairing.pairingId || !pairing.exchange) return
  try {
    const pairedCredentials = decryptRelayPairingCredentials(pairing.exchange.pairingKey, value.payload)
    if (pairedCredentials.desktopDeviceId !== pairing.desktopDeviceId) {
      throw new Error('电脑返回的设备身份不匹配')
    }
    localStorage.setItem(storedCredentialsKey, JSON.stringify(pairedCredentials))
    closePairingDialog()
    elements.setupMessage.textContent = '配对完成，正在建立加密远控连接...'
    location.reload()
  } catch (error) {
    pairing.stage = 'ready'
    updatePairingDialog()
    showToast(error.message || '无法解密电脑配对凭据')
  }
}

function handlePresenceMessage(value) {
  switch (value.kind) {
    case 'presence.registered':
      state.presenceConnected = true
      if (!credentialsComplete) {
        setConnection('online', '手机网页已上线')
        elements.setupMessage.textContent = '选择一台在线电脑连接，或等待电脑主动向这台手机发出邀请。'
      }
      clearInterval(state.presenceHeartbeatTimer)
      state.presenceHeartbeatTimer = setInterval(() => {
        try {
          sendPresence({ kind: 'presence.mobile.heartbeat' })
        } catch {
          // Reconnect logic handles a closed socket.
        }
      }, 20_000)
      renderDesktopDiscovery()
      break
    case 'presence.desktop.list':
      state.desktops = Array.isArray(value.desktops) ? value.desktops : []
      state.desktops.sort((left, right) => (right.connectedAt || 0) - (left.connectedAt || 0))
      for (const desktop of state.desktops) {
        if (credentialsComplete && desktop.deviceId === credentials.desktopDeviceId) {
          state.desktopOnline = true
          state.status = { ...(state.status || {}), ...desktop }
        }
      }
      renderDesktopDiscovery()
      if (credentialsComplete) updateDeviceStatus()
      break
    case 'presence.desktop.online':
      applyDesktopPresence(value.desktop)
      break
    case 'presence.desktop.offline':
      removeDesktopPresence(value.deviceId)
      break
    case 'pairing.invite': {
      const payload = value.payload || {}
      beginPairingDialog({
        pairingId: value.pairingId,
        desktopDeviceId: value.senderDeviceId,
        desktopName: payload.desktopName || 'Codex Compass',
        desktopPublicKey: payload.desktopPublicKey || '',
        expiresAt: value.expiresAt || Date.now() + 120_000,
        mode: 'desktop_invite',
        stage: 'ready',
      })
      break
    }
    case 'pairing.challenge': {
      const pairing = state.pairing
      if (!pairing || pairing.pairingId !== value.pairingId) return
      pairing.desktopName = value.payload?.desktopName || pairing.desktopName
      pairing.desktopPublicKey = value.payload?.desktopPublicKey || ''
      pairing.expiresAt = value.expiresAt || pairing.expiresAt
      pairing.stage = 'ready'
      updatePairingDialog()
      break
    }
    case 'pairing.completed':
      completeRelayPairing(value)
      break
    case 'pairing.error':
      if (state.pairing?.pairingId === value.pairingId) {
        state.pairing.stage = 'ready'
        state.pairing.exchange = null
        elements.relayPairingCode.value = ''
        updatePairingDialog()
      }
      showToast(value.payload?.message || value.message || '配对验证失败')
      break
    case 'pairing.rejected':
    case 'pairing.cancelled':
      if (state.pairing?.pairingId === value.pairingId) closePairingDialog()
      showToast(value.payload?.message || (value.kind === 'pairing.rejected' ? '电脑已拒绝配对请求' : '配对已取消'))
      break
    case 'error':
      if (value.pairingId && state.pairing?.pairingId === value.pairingId) {
        state.pairing.stage = state.pairing.desktopPublicKey ? 'ready' : 'waiting'
        updatePairingDialog()
      }
      showToast(value.message || '设备发现连接失败')
      break
  }
}

function startPresence() {
  clearTimeout(state.presenceReconnectTimer)
  if (
    state.presenceSocket?.readyState === WebSocket.OPEN
    || state.presenceSocket?.readyState === WebSocket.CONNECTING
  ) return
  if (!credentialsComplete) {
    elements.setupView.classList.add('discovery-mode')
    elements.discoveryControls.hidden = false
    elements.connectButton.hidden = true
    setConnection('connecting', '正在上线')
  }
  const socket = new WebSocket(websocketUrl())
  state.presenceSocket = socket
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'presence.mobile.register',
      deviceId: state.deviceId,
      deviceName: currentMobileDeviceName(),
      browser: browserName(),
      platform: platformName(),
    }))
  })
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_BYTES) return
    try {
      handlePresenceMessage(JSON.parse(event.data))
    } catch {
      // Invalid discovery frames never reach the encrypted command channel.
    }
  })
  socket.addEventListener('close', () => {
    if (state.presenceSocket !== socket) return
    state.presenceSocket = null
    state.presenceConnected = false
    state.desktops = []
    clearInterval(state.presenceHeartbeatTimer)
    state.presenceHeartbeatTimer = null
    renderDesktopDiscovery()
    if (!credentialsComplete) {
      setConnection('offline', '手机在线连接断开')
      elements.setupMessage.textContent = '无法连接中继网站，正在自动重试。'
    }
    state.presenceReconnectTimer = setTimeout(startPresence, 3_000)
  })
  socket.addEventListener('error', () => socket.close())
}

function restartPresence() {
  const previous = state.presenceSocket
  state.presenceSocket = null
  state.presenceConnected = false
  clearTimeout(state.presenceReconnectTimer)
  clearInterval(state.presenceHeartbeatTimer)
  previous?.close(1000, 'device name changed')
  setTimeout(startPresence, 120)
}

function refreshPresenceDesktops() {
  if (!state.presenceConnected) {
    startPresence()
    return
  }
  try {
    sendPresence({ kind: 'presence.desktop.list.request' })
  } catch (error) {
    showToast(error.message)
  }
}

async function connect() {
  startPresence()
  clearTimeout(state.reconnectTimer)
  if (!credentialsComplete) {
    elements.setupView.hidden = false
    elements.deviceView.hidden = true
    renderDesktopDiscovery()
    return
  }
  elements.setupView.classList.remove('discovery-mode')
  elements.discoveryControls.hidden = true
  elements.connectButton.hidden = false
  try {
    state.cryptoKey = await crypto.subtle.importKey('raw', base64UrlToBytes(credentials.key), 'AES-GCM', false, ['encrypt', 'decrypt'])
  } catch {
    elements.setupMessage.textContent = '配对加密钥无效，请在电脑端重新生成配对信息。'
    return
  }
  state.intentionalClose = false
  setConnection('connecting', '连接中')
  const socket = new WebSocket(websocketUrl())
  state.socket = socket
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      kind: 'auth',
      role: 'mobile',
      roomId: credentials.roomId,
      deviceId: state.deviceId,
      token: credentials.token,
    }))
  })
  socket.addEventListener('message', async (event) => {
    if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_BYTES) return
    let value
    try { value = JSON.parse(event.data) } catch { return }
    if (value.kind === 'authenticated') {
      state.connected = true
      setConnection('online', '中继已连接')
      elements.setupView.hidden = true
      elements.deviceView.hidden = false
      await Promise.allSettled([
        send('device.status.request'),
        send('workspace.list'),
        send('model.list'),
        loadSessions(true),
      ])
      return
    }
    if (value.kind === 'ack') return
    if (value.kind === 'error') {
      showToast(value.message || '中继认证失败')
      return
    }
    if (value.kind !== 'relay') return
    try {
      handleRemoteMessage(await decryptMessage(value))
    } catch (error) {
      showToast(error.message || '消息解密失败')
    }
  })
  socket.addEventListener('close', () => {
    state.connected = false
    state.desktopOnline = false
    setConnection('offline', '连接已断开')
    updateDeviceStatus()
    if (!state.intentionalClose) state.reconnectTimer = setTimeout(connect, 3000)
  })
  socket.addEventListener('error', () => socket.close())
}

function handleRemoteMessage(message) {
  switch (message.type) {
    case 'device.status':
      state.status = message.payload
      state.desktopOnline = true
      updateDeviceStatus()
      break
    case 'device.heartbeat':
      state.desktopOnline = true
      break
    case 'workspace.list.result':
      state.workspaces = message.payload.workspaces || []
      renderWorkspaces()
      break
    case 'model.list.result':
      state.models = message.payload.models || []
      renderModels()
      break
    case 'capability.list.result':
      handleCapabilityListResult(message)
      break
    case 'session.list.result':
      handleSessionListResult(message)
      break
    case 'session.created':
      openSession({
        ...message.payload,
        id: message.sessionId,
        canViewHistory: true,
        canContinue: true,
      }, false)
      if (state.queuedPrompt) {
        const queued = state.queuedPrompt
        state.queuedPrompt = null
        appendMessage('user', queued.displayText)
        void send('conversation.input', {
          text: queued.text,
          attachments: queued.attachments,
          skills: queued.skills,
        }, message.sessionId).catch((error) => showToast(error.message))
      }
      break
    case 'session.resumed':
      if (
        state.currentSession?.id === message.sessionId
        && elements.conversationState.textContent.startsWith('正在读取历史')
      ) {
        setConversationState('会话已继续，正在读取历史', true)
      }
      break
    case 'session.history.result':
      renderHistory(message.payload)
      break
    case 'conversation.accepted':
      state.currentTurnId = message.turnId
      setGenerating(true)
      break
    case 'turn.started':
      state.currentTurnId = message.turnId
      setGenerating(true)
      ensureAssistantMessage()
      break
    case 'response.delta':
      appendMessageText(ensureAssistantMessage(), message.payload.delta || '')
      break
    case 'reasoning.delta':
      setConversationState('Codex 正在思考', true)
      break
    case 'command.output':
      appendMessage('tool', message.payload.delta || '命令正在执行')
      break
    case 'file.diff':
      appendMessage('tool', message.payload.diff || '文件已变更')
      break
    case 'usage.updated':
      break
    case 'response.completed':
      finishTurn('任务已完成')
      break
    case 'turn.interrupted':
      finishTurn('已停止生成')
      break
    case 'turn.failed':
      finishTurn(message.payload.message || message.payload.error || '任务失败')
      break
    case 'error':
      if (state.capabilityRequests.has(message.requestId)) {
        const target = state.capabilityRequests.get(message.requestId)
        state.capabilityRequests.delete(message.requestId)
        state.capabilities[target] = {
          workspaceId: workspaceForTarget(target)?.id || '',
          error: message.payload.message || '读取插件和技能失败',
          plugins: [],
          skills: [],
        }
        renderCapabilityDialog()
      }
      showToast(message.payload.message || '请求失败')
      if (message.sessionId === state.currentSession?.id) finishTurn('请求失败')
      break
  }
}

function setConnection(kind, text) {
  elements.connectionBadge.className = `connection-state ${kind}`
  const label = elements.connectionBadge.lastElementChild
  if (label) label.textContent = text
  elements.statusConnection.textContent = text
}

function updateDeviceStatus() {
  const status = state.status || {}
  elements.deviceName.textContent = status.deviceName || 'Codex Compass'
  elements.codexStatus.textContent = status.codexAuthenticated ? '可用' : state.desktopOnline ? '未认证' : '离线'
  elements.remoteStatus.textContent = status.paused ? '已暂停' : state.desktopOnline ? '已开启' : '离线'
  elements.desktopConnectionStatus.textContent = state.desktopOnline ? '在线' : '离线'
  elements.codexIndicator.className = `health-indicator ${status.codexAuthenticated ? 'online' : state.desktopOnline ? 'warn' : 'danger'}`
  elements.remoteIndicator.className = `health-indicator ${status.paused ? 'warn' : state.desktopOnline ? 'online' : 'danger'}`
  elements.statusVersion.textContent = status.codexVersion || '-'
  elements.statusAuth.textContent = status.authType === 'chatgpt' ? 'ChatGPT 账号' : status.authType === 'apiKey' ? 'API Key' : '未检测到'
  elements.statusWorkspaces.textContent = String(status.workspaceCount ?? state.workspaces.length)
  elements.statusSessions.textContent = String(status.activeSessions ?? 0)
}

function renderWorkspaces() {
  elements.workspaceSelect.replaceChildren()
  for (const workspace of state.workspaces) {
    const option = document.createElement('option')
    option.value = workspace.id
    option.textContent = `${workspace.name}${workspace.allowWrite ? ' · 可修改' : ' · 只读'}`
    elements.workspaceSelect.append(option)
  }
  const empty = state.workspaces.length === 0
  elements.workspaceEmpty.hidden = !empty
  elements.createSessionButton.disabled = empty
  const selected = workspaceForTarget('new')
  elements.newAttachmentButton.disabled = !selected?.allowUploads
  elements.newUploadHint.textContent = selected?.allowUploads
    ? '文件会先在浏览器中加密，再临时上传到中继。'
    : '需要先在电脑端为这个工作区开启“允许手机上传文件”。'
  renderSelectionTray('new')
  updateDeviceStatus()
}

function renderModels() {
  elements.modelSelect.replaceChildren()
  const automatic = document.createElement('option')
  automatic.value = ''
  automatic.textContent = '使用电脑当前默认模型'
  elements.modelSelect.append(automatic)
  for (const model of state.models) {
    const option = document.createElement('option')
    option.value = model.id
    option.textContent = model.isDefault ? `${model.displayName} · 默认` : model.displayName
    elements.modelSelect.append(option)
  }
}

function workspaceForTarget(target) {
  if (target === 'new') {
    return state.workspaces.find((workspace) => workspace.id === elements.workspaceSelect.value) || null
  }
  if (!state.currentSession) return null
  return state.workspaces.find((workspace) => (
    workspace.id === state.currentSession.workspaceId || workspace.path === state.currentSession.cwd
  )) || null
}

async function requestCapabilities(target, force = false) {
  const workspace = workspaceForTarget(target)
  if (!workspace) {
    state.capabilities[target] = { plugins: [], skills: [] }
    renderCapabilityDialog()
    return
  }
  if (!force && state.capabilities[target]?.workspaceId === workspace.id) {
    renderCapabilityDialog()
    return
  }
  state.capabilities[target] = { workspaceId: workspace.id, loading: true, plugins: [], skills: [] }
  renderCapabilityDialog()
  try {
    const requestId = await send(
      'capability.list',
      target === 'new' ? { workspaceId: workspace.id } : {},
      target === 'composer' ? state.currentSession?.id : null,
    )
    state.capabilityRequests.set(requestId, target)
  } catch (error) {
    state.capabilities[target] = { workspaceId: workspace.id, error: error.message, plugins: [], skills: [] }
    renderCapabilityDialog()
  }
}

function handleCapabilityListResult(message) {
  const target = state.capabilityRequests.get(message.requestId)
  if (!target) return
  state.capabilityRequests.delete(message.requestId)
  const workspace = workspaceForTarget(target)
  state.capabilities[target] = {
    workspaceId: workspace?.id || '',
    plugins: Array.isArray(message.payload.plugins) ? message.payload.plugins : [],
    skills: Array.isArray(message.payload.skills) ? message.payload.skills : [],
  }
  const available = new Set(state.capabilities[target].skills.map((skill) => skill.name))
  state.selectedSkills[target] = new Set(
    [...state.selectedSkills[target]].filter((name) => available.has(name)),
  )
  renderSelectionTray(target)
  renderCapabilityDialog()
}

function openCapabilityDialog(target) {
  state.capabilityTarget = target
  state.capabilitySearch = ''
  elements.capabilitySearch.value = ''
  elements.capabilityDialog.hidden = false
  renderCapabilityDialog()
  void requestCapabilities(target)
}

function closeCapabilityDialog() {
  elements.capabilityDialog.hidden = true
}

function toggleSkillNames(target, names, selected) {
  const selection = state.selectedSkills[target]
  if (!selected) {
    for (const name of names) selection.delete(name)
  } else {
    for (const name of names) {
      if (selection.size >= MAX_SELECTED_SKILLS) break
      selection.add(name)
    }
    if (!names.every((name) => selection.has(name))) {
      showToast(`单次最多选择 ${MAX_SELECTED_SKILLS} 个技能`)
    }
  }
  renderSelectionTray(target)
  renderCapabilityDialog()
}

function createCapabilityRow({
  checked,
  title,
  description,
  meta,
  identifier,
  originalTitle,
  originalDescription,
  onChange,
  disabled = false,
}) {
  const label = document.createElement('label')
  label.className = 'capability-row'
  if (identifier) label.dataset.capabilityName = identifier
  const checkbox = document.createElement('input')
  checkbox.type = 'checkbox'
  checkbox.checked = checked
  checkbox.disabled = disabled
  checkbox.addEventListener('change', () => onChange(checkbox.checked))
  const content = document.createElement('span')
  const strong = document.createElement('strong')
  strong.textContent = title
  if (originalTitle && originalTitle !== title) strong.title = originalTitle
  const small = document.createElement('small')
  small.textContent = description || '本机已安装并启用'
  if (originalDescription && originalDescription !== description) small.title = originalDescription
  content.append(strong, small)
  const detail = document.createElement('em')
  detail.textContent = meta || ''
  label.append(checkbox, content, detail)
  return label
}

function renderCapabilityDialog() {
  if (elements.capabilityDialog.hidden) return
  const target = state.capabilityTarget
  const catalog = state.capabilities[target]
  const selected = state.selectedSkills[target]
  elements.capabilityList.replaceChildren()
  elements.capabilitySelectionCount.textContent = `已选择 ${selected.size} / ${MAX_SELECTED_SKILLS}`
  if (!catalog || catalog.loading) {
    const loading = document.createElement('div')
    loading.className = 'capability-empty'
    loading.textContent = '正在读取电脑中的插件和技能'
    elements.capabilityList.append(loading)
    return
  }
  if (catalog.error) {
    const error = document.createElement('div')
    error.className = 'capability-empty'
    error.textContent = catalog.error
    elements.capabilityList.append(error)
    return
  }

  const term = state.capabilitySearch.trim().toLowerCase()
  const plugins = catalog.plugins.filter((plugin) => {
    const localized = localizePlugin(plugin)
    return !term || capabilitySearchText(plugin, localized).includes(term)
  })
  const skills = catalog.skills.filter((skill) => {
    const localized = localizeSkill(skill)
    return !term || capabilitySearchText(skill, localized).includes(term)
  })

  if (plugins.length) {
    const section = document.createElement('section')
    section.className = 'capability-section'
    const heading = document.createElement('h3')
    heading.textContent = '已安装插件'
    section.append(heading)
    for (const plugin of plugins) {
      const names = plugin.skillNames || []
      const checked = names.length > 0 && names.every((name) => selected.has(name))
      const localized = localizePlugin(plugin)
      section.append(createCapabilityRow({
        checked,
        title: localized.title,
        description: localized.description,
        meta: `${names.length} 项技能`,
        identifier: plugin.name,
        originalTitle: localized.originalTitle,
        originalDescription: localized.originalDescription,
        disabled: names.length === 0,
        onChange: (value) => toggleSkillNames(target, names, value),
      }))
    }
    elements.capabilityList.append(section)
  }

  if (skills.length) {
    const section = document.createElement('section')
    section.className = 'capability-section'
    const heading = document.createElement('h3')
    heading.textContent = '可用技能'
    section.append(heading)
    for (const skill of skills) {
      const localized = localizeSkill(skill)
      section.append(createCapabilityRow({
        checked: selected.has(skill.name),
        title: localized.title,
        description: localized.description,
        meta: localizeScope(skill.scope),
        identifier: skill.name,
        originalTitle: localized.originalTitle,
        originalDescription: localized.originalDescription,
        disabled: !selected.has(skill.name) && selected.size >= MAX_SELECTED_SKILLS,
        onChange: (value) => toggleSkillNames(target, [skill.name], value),
      }))
    }
    elements.capabilityList.append(section)
  }

  if (!plugins.length && !skills.length) {
    const empty = document.createElement('div')
    empty.className = 'capability-empty'
    empty.textContent = term ? '没有匹配的插件或技能' : '当前工作区没有可用的插件或技能'
    elements.capabilityList.append(empty)
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function dangerousFileExtension(filename) {
  const extension = filename.split('.').pop()?.toLowerCase() || ''
  return new Set([
    'exe', 'msi', 'msp', 'com', 'scr', 'bat', 'cmd', 'ps1', 'vbs', 'vbe',
    'jse', 'wsf', 'wsh', 'reg', 'lnk', 'url', 'dll', 'sys',
  ]).has(extension)
}

function selectAttachments(target, files) {
  const workspace = workspaceForTarget(target)
  if (!workspace?.allowUploads) {
    showToast('请先在电脑端为这个工作区开启“允许手机上传文件”')
    return
  }
  const attachments = state.attachments[target]
  for (const file of files) {
    if (attachments.length >= MAX_ATTACHMENTS) {
      showToast(`单次最多选择 ${MAX_ATTACHMENTS} 个附件`)
      break
    }
    if (!file.size || file.size > MAX_ATTACHMENT_BYTES) {
      showToast(`${file.name} 为空或超过 10 MiB`)
      continue
    }
    if (dangerousFileExtension(file.name)) {
      showToast(`${file.name} 的文件类型不允许远程上传`)
      continue
    }
    attachments.push({ clientId: crypto.randomUUID(), file })
  }
  renderSelectionTray(target)
}

function renderSelectionTray(target) {
  const tray = target === 'new' ? elements.newSelectionTray : elements.messageSelectionTray
  const attachments = state.attachments[target]
  const selected = state.selectedSkills[target]
  const catalog = state.capabilities[target]
  tray.replaceChildren()

  for (const attachment of attachments) {
    const chip = document.createElement('span')
    chip.className = 'selection-chip'
    chip.append(icon('file'))
    const label = document.createElement('span')
    label.textContent = `${attachment.file.name} · ${formatBytes(attachment.file.size)}`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.title = '移除附件'
    remove.setAttribute('aria-label', `移除 ${attachment.file.name}`)
    remove.append(icon('close'))
    remove.addEventListener('click', () => {
      state.attachments[target] = state.attachments[target].filter((item) => item.clientId !== attachment.clientId)
      renderSelectionTray(target)
    })
    chip.append(label, remove)
    tray.append(chip)
  }

  for (const name of selected) {
    const skill = catalog?.skills?.find((item) => item.name === name)
    const chip = document.createElement('span')
    chip.className = 'selection-chip'
    chip.append(icon('skill'))
    const label = document.createElement('span')
    label.textContent = skill ? localizeSkill(skill).title : name
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.title = '移除技能'
    remove.setAttribute('aria-label', `移除 ${label.textContent}`)
    remove.append(icon('close'))
    remove.addEventListener('click', () => {
      selected.delete(name)
      renderSelectionTray(target)
    })
    chip.append(label, remove)
    tray.append(chip)
  }

  tray.hidden = attachments.length === 0 && selected.size === 0
  const skillButton = target === 'new' ? elements.newSkillButton : elements.messageSkillButton
  const attachmentButton = target === 'new' ? elements.newAttachmentButton : elements.messageAttachmentButton
  skillButton.classList.toggle('active', selected.size > 0)
  attachmentButton.classList.toggle('active', attachments.length > 0)
  if (target === 'composer') {
    const parts = []
    if (attachments.length) parts.push(`${attachments.length} 个附件`)
    if (selected.size) parts.push(`${selected.size} 个技能`)
    elements.messageSelectionSummary.textContent = parts.join(' · ') || '可添加附件和技能'
  }
}

async function uploadAttachment(entry) {
  const plaintext = await entry.file.arrayBuffer()
  const digest = bytesToBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext)))
  const aad = encoder.encode(
    `codex-compass-upload-v1\n${credentials.roomId}\n${state.deviceId}\n${credentials.desktopDeviceId}\n${entry.clientId}\n${entry.file.size}\n${digest}`,
  )
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
    state.cryptoKey,
    plaintext,
  )
  const response = await fetch('/api/uploads', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${credentials.token}`,
      'Content-Type': 'application/octet-stream',
      'X-Room-Id': credentials.roomId,
      'X-Device-Id': state.deviceId,
      'X-Target-Device-Id': credentials.desktopDeviceId,
    },
    body: ciphertext,
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || `附件上传失败（${response.status}）`)
  return {
    uploadId: result.uploadId,
    downloadToken: result.downloadToken,
    clientId: entry.clientId,
    name: entry.file.name,
    mimeType: entry.file.type || 'application/octet-stream',
    size: entry.file.size,
    sha256: digest,
    nonce: bytesToBase64Url(nonce),
    aadVersion: 1,
  }
}

async function uploadSelectedAttachments(target) {
  const descriptors = []
  for (const attachment of state.attachments[target]) {
    descriptors.push(await uploadAttachment(attachment))
  }
  return descriptors
}

function submissionDisplayText(text, target) {
  const details = []
  if (state.attachments[target].length) details.push(`${state.attachments[target].length} 个附件`)
  if (state.selectedSkills[target].size) details.push(`${state.selectedSkills[target].size} 个技能`)
  if (text) return details.length ? `${text}\n\n[${details.join(' · ')}]` : text
  return details.length ? `已发送 ${details.join(' · ')}` : ''
}

function clearSelections(target) {
  state.attachments[target] = []
  state.selectedSkills[target] = new Set()
  renderSelectionTray(target)
}

function renderSessions() {
  elements.sessionList.replaceChildren()
  renderSessionStatusFilter()
  const visibleProjects = state.sessionProjects.filter((project) => sessionCountForProject(project) > 0)
  const loaded = state.sessions.length
  const term = state.sessionFilter.trim()
  elements.sessionSummary.textContent = state.sessionLoading && loaded === 0
    ? '正在同步电脑中的会话'
    : `${state.sessionPage.total} 个${term ? '匹配' : ''}任务 · ${visibleProjects.length} 个项目 · 已加载 ${loaded}`
  elements.loadMoreSessionsButton.hidden = !state.sessionPage.nextCursor || loaded >= state.sessionPage.total
  elements.loadMoreSessionsButton.disabled = state.sessionLoading
  elements.loadMoreSessionsButton.classList.toggle('loading', state.sessionLoading)
  elements.loadMoreSessionsButton.querySelector('span').textContent = state.sessionLoading
    ? '正在加载'
    : `加载更多（剩余 ${Math.max(0, state.sessionPage.total - loaded)}）`

  if (loaded === 0 && !state.sessionLoading && visibleProjects.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'empty'
    empty.append(icon('empty'))
    const text = document.createElement('span')
    text.textContent = term
      ? 'Codex 项目中没有匹配的任务'
      : state.sessionStatus === 'archived'
        ? 'Codex 项目中还没有归档任务'
        : 'Codex 项目中还没有会话'
    empty.append(text)
    elements.sessionList.append(empty)
    return
  }
  if (loaded === 0 && state.sessionLoading) {
    const loading = document.createElement('div')
    loading.className = 'session-loading'
    loading.innerHTML = '<span></span><span></span><span></span>'
    elements.sessionList.append(loading)
    return
  }

  const sessionsByProject = new Map()
  for (const session of state.sessions) {
    const projectId = session.projectId || session.workspaceId || session.cwd || 'workspace'
    if (!sessionsByProject.has(projectId)) sessionsByProject.set(projectId, [])
    sessionsByProject.get(projectId).push(session)
  }
  const projectOrder = state.sessionProjects.length
    ? state.sessionProjects
    : [...sessionsByProject.keys()].map((id) => {
        const session = state.sessions.find((item) => (item.projectId || item.workspaceId || item.cwd) === id)
        return {
          id,
          name: session?.projectName || workspaceLabel(session?.cwd),
          authorized: session?.canContinue !== false,
        }
      })

  for (const project of projectOrder) {
    const projectCount = sessionCountForProject(project)
    if (projectCount === 0) continue
    const projectSessions = sessionsByProject.get(project.id) || []
    const projectPage = state.projectPages.get(project.id)
    const projectLoading = state.loadingProjects.has(project.id)
    const collapsed = state.collapsedProjects.has(project.id)
    const group = document.createElement('section')
    group.className = `project-group${collapsed ? ' collapsed' : ''}`
    group.dataset.projectId = project.id
    const heading = document.createElement('button')
    heading.type = 'button'
    heading.className = 'project-heading'
    heading.setAttribute('aria-expanded', String(!collapsed))
    const folder = document.createElement('span')
    folder.className = 'project-symbol'
    folder.append(icon('folder'))
    const identity = document.createElement('span')
    identity.className = 'project-identity'
    const name = document.createElement('strong')
    name.textContent = project.name || '已授权项目'
    name.title = name.textContent
    const count = document.createElement('small')
    count.textContent = `${projectCount} 个任务 · ${project.authorized === false ? '仅查看' : '可继续'}`
    identity.append(name, count)
    const disclosure = document.createElement('span')
    disclosure.className = 'project-disclosure'
    disclosure.append(icon('chevron'))
    heading.append(folder, identity, disclosure)
    heading.addEventListener('click', () => {
      if (state.collapsedProjects.has(project.id)) state.collapsedProjects.delete(project.id)
      else state.collapsedProjects.add(project.id)
      renderSessions()
    })

    const body = document.createElement('div')
    body.className = 'project-sessions'
    body.hidden = collapsed
    for (const session of projectSessions) body.append(createSessionRow(session))

    const canLoadProject = projectSessions.length < projectCount
      && (!projectPage || Boolean(projectPage.nextCursor))
    if (canLoadProject) {
      const remaining = Math.max(0, projectCount - projectSessions.length)
      const more = document.createElement('button')
      more.type = 'button'
      more.className = `project-load-button${projectLoading ? ' loading' : ''}`
      more.dataset.projectId = project.id
      more.disabled = projectLoading
      more.textContent = projectLoading
        ? '正在加载此项目'
        : projectPage
          ? `继续加载（剩余 ${remaining}）`
          : '加载此项目的任务'
      more.addEventListener('click', () => {
        void loadProjectSessions(project.id).catch((error) => showToast(error.message))
      })
      body.append(more)
    } else if (projectSessions.length === 0) {
      const more = document.createElement('p')
      more.className = 'project-empty'
      more.textContent = '当前筛选下暂无任务'
      body.append(more)
    }
    group.append(heading, body)
    elements.sessionList.append(group)
  }
}

function createSessionRow(session) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `session-row${session.canContinue === false ? ' view-only' : ''}`
    button.dataset.sessionId = session.id
    const symbol = document.createElement('span')
    symbol.className = 'session-symbol'
    symbol.append(icon(session.archived ? 'archive' : 'task'))
    const content = document.createElement('div')
    content.className = 'session-content'
    const title = document.createElement('strong')
    title.textContent = session.title || session.preview || '未命名会话'
    title.title = title.textContent
    const metaLine = document.createElement('div')
    metaLine.className = 'session-meta-line'
    const meta = document.createElement('span')
    meta.className = 'session-meta'
    meta.textContent = `${formatTime(session.updatedAt)}${session.archived ? ' · 已归档' : ''}${session.modelProvider ? ` · ${session.modelProvider}` : ''}`
    meta.title = session.cwd || ''
    const access = document.createElement('span')
    access.className = `session-access ${session.canContinue === false ? 'view-only' : 'continuable'}`
    access.textContent = session.canContinue === false ? '仅查看' : '可继续'
    metaLine.append(meta, access)
    const action = document.createElement('span')
    action.className = 'session-chevron'
    action.append(icon('chevron'))
    content.append(title, metaLine)
    button.append(symbol, content, action)
    button.addEventListener('click', () => openSession(session, true))
    return button
}

function sessionCountForProject(project) {
  if (state.sessionStatus === 'archived') return Number(project.archived || 0)
  if (state.sessionStatus === 'all') return Number(project.total || 0)
  return Number(project.active || 0)
}

function renderSessionStatusFilter() {
  elements.activeSessionCount.textContent = String(state.sessionPage.active || 0)
  elements.archivedSessionCount.textContent = String(state.sessionPage.archived || 0)
  elements.allSessionCount.textContent = String((state.sessionPage.active || 0) + (state.sessionPage.archived || 0))
  for (const button of elements.sessionStatusFilter.querySelectorAll('button')) {
    const active = button.dataset.sessionStatus === state.sessionStatus
    button.classList.toggle('active', active)
    button.setAttribute('aria-pressed', String(active))
  }
}

function mergeSessions(incoming) {
  const byId = new Map(state.sessions.map((session) => [session.id, session]))
  for (const session of incoming) byId.set(session.id, session)
  state.sessions = [...byId.values()]
}

function mergeSessionProject(project) {
  const index = state.sessionProjects.findIndex((item) => item.id === project.id)
  if (index === -1) state.sessionProjects.push(project)
  else state.sessionProjects[index] = { ...state.sessionProjects[index], ...project }
}

function resetProjectSessionState() {
  for (const [requestId, request] of state.sessionRequests) {
    if (!request.projectId) continue
    clearTimeout(request.timer)
    state.sessionRequests.delete(requestId)
  }
  state.projectPages.clear()
  state.loadingProjects.clear()
}

function handleSessionListResult(message) {
  const request = state.sessionRequests.get(message.requestId)
  if (!request) return
  clearTimeout(request.timer)
  state.sessionRequests.delete(message.requestId)
  if (request.generation !== state.sessionGeneration) return

  const payload = message.payload || {}
  const incoming = Array.isArray(payload.sessions) ? payload.sessions : []
  if (request.projectId) {
    state.loadingProjects.delete(request.projectId)
    if (request.status !== state.sessionStatus || request.query !== state.sessionFilter) {
      renderSessions()
      return
    }
    mergeSessions(incoming)
    for (const project of Array.isArray(payload.projects) ? payload.projects : []) {
      mergeSessionProject(project)
    }
    state.projectPages.set(request.projectId, {
      nextCursor: payload.nextCursor || null,
      total: Number(payload.total || 0),
      loaded: Number(payload.loaded || incoming.length),
      status: request.status,
      query: request.query,
    })
    renderSessions()
    return
  }

  if (request.reset) {
    state.sessions = incoming
  } else {
    mergeSessions(incoming)
  }
  state.sessionProjects = Array.isArray(payload.projects) ? payload.projects : []
  state.sessionPage = {
    nextCursor: payload.nextCursor || null,
    total: Number(payload.total || 0),
    active: Number(payload.active || 0),
    archived: Number(payload.archived || 0),
    loaded: Number(payload.loaded || state.sessions.length),
  }
  state.sessionLoading = false
  elements.refreshSessionsButton.classList.remove('loading')
  renderSessions()
}

async function loadSessions(reset = false) {
  if (!state.connected) return
  if (!reset && (state.sessionLoading || !state.sessionPage.nextCursor)) return
  if (reset) {
    state.sessionGeneration += 1
    resetProjectSessionState()
    state.sessions = []
    state.sessionProjects = []
    state.sessionPage = {
      nextCursor: null,
      total: 0,
      active: 0,
      archived: 0,
      loaded: 0,
    }
  }
  const generation = state.sessionGeneration
  const cursor = reset ? null : state.sessionPage.nextCursor
  state.sessionLoading = true
  elements.refreshSessionsButton.classList.add('loading')
  renderSessions()
  try {
    const requestId = await send('session.list.request', {
      cursor,
      limit: 40,
      status: state.sessionStatus,
      query: state.sessionFilter,
    })
    const timer = setTimeout(() => {
      const request = state.sessionRequests.get(requestId)
      if (!request) return
      state.sessionRequests.delete(requestId)
      if (request.generation !== state.sessionGeneration) return
      state.sessionLoading = false
      elements.refreshSessionsButton.classList.remove('loading')
      renderSessions()
      showToast('读取会话超时，请重试')
    }, 30_000)
    state.sessionRequests.set(requestId, { generation, reset, timer })
  } catch (error) {
    if (generation !== state.sessionGeneration) return
    state.sessionLoading = false
    elements.refreshSessionsButton.classList.remove('loading')
    renderSessions()
    throw error
  }
}

async function loadProjectSessions(projectId) {
  if (!state.connected || state.loadingProjects.has(projectId)) return
  const currentPage = state.projectPages.get(projectId)
  if (currentPage && !currentPage.nextCursor) return

  const generation = state.sessionGeneration
  const status = state.sessionStatus
  const query = state.sessionFilter
  const cursor = currentPage?.nextCursor || null
  state.loadingProjects.add(projectId)
  renderSessions()
  try {
    const requestId = await send('session.list.request', {
      cursor,
      limit: 80,
      status,
      workspaceId: projectId,
      query,
    })
    const timer = setTimeout(() => {
      const request = state.sessionRequests.get(requestId)
      if (!request) return
      state.sessionRequests.delete(requestId)
      if (request.generation !== state.sessionGeneration) return
      state.loadingProjects.delete(projectId)
      renderSessions()
      showToast('读取此项目的任务超时，请重试')
    }, 30_000)
    state.sessionRequests.set(requestId, {
      generation,
      reset: false,
      timer,
      projectId,
      status,
      query,
    })
  } catch (error) {
    if (generation !== state.sessionGeneration) return
    state.loadingProjects.delete(projectId)
    renderSessions()
    throw error
  }
}

async function openSession(session, loadHistory) {
  state.currentSession = session
  elements.conversationView.dataset.sessionId = session.id
  state.currentTurnId = null
  state.pendingAssistant = null
  state.capabilities.composer = null
  clearSelections('composer')
  elements.conversationTitle.textContent = session.title || session.preview || 'Codex 会话'
  elements.conversationMeta.textContent = sessionWorkspaceLabel(session)
  elements.messageList.replaceChildren()
  elements.deviceView.hidden = true
  elements.conversationView.hidden = false
  updateComposerAccess()
  setConversationState(
    loadHistory
      ? sessionCanContinue() ? '正在读取历史' : '正在读取历史 · 仅查看'
      : '新会话',
    loadHistory,
  )
  if (loadHistory) {
    if (sessionCanContinue()) await send('session.resume', {}, session.id)
    await send('session.history.request', {}, session.id)
  }
}

function renderHistory(payload) {
  if (payload.session?.id !== state.currentSession?.id) return
  elements.messageList.replaceChildren()
  for (const turn of payload.turns || []) {
    for (const item of turn.items || []) {
      const text = typeof item.text === 'string' ? item.text : Array.isArray(item.text)
        ? item.text.map((part) => part.text || '').join('')
        : item.kind ? `${item.kind} · ${item.status || ''}` : ''
      if (text) appendMessage(item.role === 'user' ? 'user' : item.role === 'assistant' ? 'assistant' : 'tool', text)
    }
  }
  if (payload.session?.cwd && !state.currentSession?.projectName) {
    elements.conversationMeta.textContent = workspaceLabel(payload.session.cwd)
  }
  setConversationState(sessionCanContinue() ? '历史已同步 · 可继续' : '历史已同步 · 仅查看')
  updateComposerAccess()
  scrollMessages()
}

function appendMessage(role, text, pending = false) {
  const message = document.createElement('div')
  message.className = `message ${role}${pending ? ' pending' : ''}`
  message.rawText = String(text || '')
  renderMessageContent(message)
  elements.messageList.append(message)
  scrollMessages()
  return message
}

function renderMessageContent(message) {
  if (message.renderTimer) {
    clearTimeout(message.renderTimer)
    message.renderTimer = null
  }
  if (message.classList.contains('tool')) {
    message.textContent = message.rawText
  } else {
    renderMessageMarkdown(message, message.rawText)
  }
}

function appendMessageText(message, delta) {
  message.rawText = `${message.rawText || ''}${delta}`
  if (message.renderTimer) return
  message.renderTimer = setTimeout(() => {
    message.renderTimer = null
    renderMessageContent(message)
    scrollMessages()
  }, 48)
}

function ensureAssistantMessage() {
  if (!state.pendingAssistant) state.pendingAssistant = appendMessage('assistant', '', true)
  return state.pendingAssistant
}

function setGenerating(generating) {
  const readOnly = !sessionCanContinue()
  elements.stopButton.hidden = !generating || readOnly
  elements.sendButton.disabled = generating || readOnly
  elements.messageInput.disabled = generating || readOnly
  elements.messageAttachmentButton.disabled = generating || readOnly || !workspaceForTarget('composer')?.allowUploads
  elements.messageSkillButton.disabled = generating || readOnly
  elements.composer.classList.toggle('read-only', readOnly)
  if (generating) setConversationState('Codex 正在执行', true)
  else elements.conversationActivity.classList.remove('active')
}

function finishTurn(status) {
  if (state.pendingAssistant) {
    renderMessageContent(state.pendingAssistant)
    if (state.pendingAssistant.rawText.trim()) state.pendingAssistant.classList.remove('pending')
    else state.pendingAssistant.remove()
  }
  state.pendingAssistant = null
  state.currentTurnId = null
  setGenerating(false)
  setConversationState(status)
  void loadSessions(true).catch(() => undefined)
}

function scrollMessages() {
  requestAnimationFrame(() => { elements.messageList.scrollTop = elements.messageList.scrollHeight })
}

function setConversationState(text, active = false) {
  elements.conversationState.textContent = text
  elements.conversationActivity.classList.toggle('active', active)
}

function workspaceLabel(path) {
  if (!path) return '已授权工作区'
  const workspace = state.workspaces.find((item) => item.path === path)
  if (workspace?.name) return workspace.name
  return String(path).split(/[\\/]/).filter(Boolean).at(-1) || '已授权工作区'
}

function sessionWorkspaceLabel(session) {
  const name = session?.projectName || session?.workspaceName || workspaceLabel(session?.cwd)
  return `${name} · ${session?.canContinue === false ? '仅查看' : '可继续'}`
}

function sessionCanContinue() {
  return state.currentSession?.canContinue !== false
}

function updateComposerAccess() {
  const readOnly = !sessionCanContinue()
  elements.composer.classList.toggle('read-only', readOnly)
  elements.composer.setAttribute('aria-disabled', String(readOnly))
  elements.messageInput.placeholder = readOnly
    ? '仅可查看历史，请先在电脑端同步此项目'
    : '给 Codex 发送消息'
  elements.messageSelectionSummary.textContent = readOnly
    ? '仅可查看历史，需在电脑端同步项目后继续'
    : '可添加附件和技能'
  setGenerating(Boolean(state.currentTurnId))
}

function showView(view) {
  for (const button of document.querySelectorAll('.tabs button')) button.classList.toggle('active', button.dataset.view === view)
  elements.sessionsPanel.hidden = view !== 'sessions'
  elements.newPanel.hidden = view !== 'new'
  elements.statusPanel.hidden = view !== 'status'
}

function formatTime(timestamp) {
  if (!timestamp) return '时间未知'
  const milliseconds = Number(timestamp) < 10_000_000_000 ? Number(timestamp) * 1000 : Number(timestamp)
  const date = new Date(milliseconds)
  const difference = Date.now() - date.getTime()
  if (difference >= 0 && difference < 60_000) return '刚刚'
  if (difference >= 0 && difference < 3_600_000) return `${Math.floor(difference / 60_000)} 分钟前`
  if (difference >= 0 && difference < 86_400_000) return `${Math.floor(difference / 3_600_000)} 小时前`
  if (difference >= 0 && difference < 604_800_000) return `${Math.floor(difference / 86_400_000)} 天前`
  return date.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

let toastTimer
function showToast(text) {
  clearTimeout(toastTimer)
  elements.toast.textContent = text
  elements.toast.hidden = false
  toastTimer = setTimeout(() => { elements.toast.hidden = true }, 3500)
}

document.querySelectorAll('.tabs button').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)))
elements.connectButton.addEventListener('click', connect)
elements.mobileDeviceName.value = localStorage.getItem(mobileDeviceNameKey) || defaultMobileDeviceName()
elements.mobileDeviceName.addEventListener('change', () => {
  elements.mobileDeviceName.value = currentMobileDeviceName()
  localStorage.setItem(mobileDeviceNameKey, elements.mobileDeviceName.value)
  restartPresence()
})
elements.refreshDiscoveryButton.addEventListener('click', refreshPresenceDesktops)
elements.relayPairingCode.addEventListener('input', () => {
  elements.relayPairingCode.value = elements.relayPairingCode.value.replace(/\D/g, '').slice(0, 6)
})
elements.relayPairingCode.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitRelayPairingCode()
})
elements.submitPairingButton.addEventListener('click', submitRelayPairingCode)
elements.cancelPairingButton.addEventListener('click', () => closePairingDialog({ notifyDesktop: true }))
elements.closePairingDialog.addEventListener('click', () => closePairingDialog({ notifyDesktop: true }))
elements.pairingDialog.addEventListener('click', (event) => {
  if (event.target === elements.pairingDialog) closePairingDialog({ notifyDesktop: true })
})
elements.refreshSessionsButton.addEventListener('click', () => {
  void loadSessions(true).catch((error) => showToast(error.message))
})
let sessionSearchTimer
elements.sessionSearch.addEventListener('input', () => {
  state.sessionFilter = elements.sessionSearch.value
  clearTimeout(sessionSearchTimer)
  sessionSearchTimer = setTimeout(() => {
    void loadSessions(true).catch((error) => showToast(error.message))
  }, 280)
})
elements.sessionStatusFilter.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => {
  const status = button.dataset.sessionStatus
  if (!status || status === state.sessionStatus) return
  state.sessionStatus = status
  void loadSessions(true).catch((error) => showToast(error.message))
}))
elements.loadMoreSessionsButton.addEventListener('click', () => {
  void loadSessions(false).catch((error) => showToast(error.message))
})
elements.workspaceSelect.addEventListener('change', () => {
  state.capabilities.new = null
  clearSelections('new')
  const workspace = workspaceForTarget('new')
  elements.newAttachmentButton.disabled = !workspace?.allowUploads
  elements.newUploadHint.textContent = workspace?.allowUploads
    ? '文件会先在浏览器中加密，再临时上传到中继。'
    : '需要先在电脑端为这个工作区开启“允许手机上传文件”。'
})
elements.newAttachmentButton.addEventListener('click', () => elements.newAttachmentInput.click())
elements.messageAttachmentButton.addEventListener('click', () => elements.messageAttachmentInput.click())
elements.newAttachmentInput.addEventListener('change', () => {
  selectAttachments('new', [...elements.newAttachmentInput.files])
  elements.newAttachmentInput.value = ''
})
elements.messageAttachmentInput.addEventListener('change', () => {
  selectAttachments('composer', [...elements.messageAttachmentInput.files])
  elements.messageAttachmentInput.value = ''
})
elements.newSkillButton.addEventListener('click', () => openCapabilityDialog('new'))
elements.messageSkillButton.addEventListener('click', () => openCapabilityDialog('composer'))
elements.closeCapabilityDialog.addEventListener('click', closeCapabilityDialog)
elements.confirmCapabilityDialog.addEventListener('click', closeCapabilityDialog)
elements.capabilityDialog.addEventListener('click', (event) => {
  if (event.target === elements.capabilityDialog) closeCapabilityDialog()
})
elements.capabilitySearch.addEventListener('input', () => {
  state.capabilitySearch = elements.capabilitySearch.value
  renderCapabilityDialog()
})
elements.createSessionButton.addEventListener('click', async () => {
  const prompt = elements.newSessionPrompt.value.trim()
  const hasSelections = state.attachments.new.length > 0 || state.selectedSkills.new.size > 0
  if (!prompt && !hasSelections) { showToast('请输入任务内容，或添加附件或技能'); return }
  if (state.uploading) return
  elements.createSessionButton.disabled = true
  state.uploading = true
  try {
    const attachments = await uploadSelectedAttachments('new')
    const skills = [...state.selectedSkills.new]
    const displayText = submissionDisplayText(prompt, 'new')
    state.queuedPrompt = { text: prompt, attachments, skills, displayText }
    await send('session.create', {
      workspaceId: elements.workspaceSelect.value,
      model: elements.modelSelect.value || null,
    })
    elements.newSessionPrompt.value = ''
    elements.newPromptCount.textContent = '0'
    clearSelections('new')
  } catch (error) {
    state.queuedPrompt = null
    showToast(error.message)
  } finally {
    state.uploading = false
    elements.createSessionButton.disabled = state.workspaces.length === 0
  }
})

elements.backButton.addEventListener('click', () => {
  elements.conversationView.hidden = true
  delete elements.conversationView.dataset.sessionId
  elements.deviceView.hidden = false
  state.currentSession = null
  showView('sessions')
  void loadSessions(true).catch(() => undefined)
})
elements.stopButton.addEventListener('click', () => {
  if (state.currentSession?.id && state.currentTurnId) {
    void send('turn.interrupt', {}, state.currentSession.id, state.currentTurnId).catch((error) => showToast(error.message))
  }
})
elements.composer.addEventListener('submit', async (event) => {
  event.preventDefault()
  if (!sessionCanContinue()) {
    showToast('该项目目前仅可查看，请先在电脑端一键同步 Codex 项目')
    return
  }
  const text = elements.messageInput.value.trim()
  const hasSelections = state.attachments.composer.length > 0 || state.selectedSkills.composer.size > 0
  if ((!text && !hasSelections) || !state.currentSession?.id || state.uploading) return
  state.uploading = true
  elements.sendButton.disabled = true
  try {
    const attachments = await uploadSelectedAttachments('composer')
    const skills = [...state.selectedSkills.composer]
    const displayText = submissionDisplayText(text, 'composer')
    await send('conversation.input', { text, attachments, skills }, state.currentSession.id)
    appendMessage('user', displayText)
    elements.messageInput.value = ''
    elements.messageInput.style.height = 'auto'
    clearSelections('composer')
  } catch (error) {
    showToast(error.message)
  } finally {
    state.uploading = false
    elements.sendButton.disabled = Boolean(state.currentTurnId) || !sessionCanContinue()
  }
})
elements.messageInput.addEventListener('input', () => {
  elements.messageInput.style.height = 'auto'
  elements.messageInput.style.height = `${Math.min(160, elements.messageInput.scrollHeight)}px`
})
elements.newSessionPrompt.addEventListener('input', () => {
  elements.newPromptCount.textContent = String(elements.newSessionPrompt.value.length)
})
elements.messageList.addEventListener('scroll', () => {
  const distance = elements.messageList.scrollHeight - elements.messageList.scrollTop - elements.messageList.clientHeight
  elements.scrollBottomButton.hidden = distance < 120
})
elements.scrollBottomButton.addEventListener('click', scrollMessages)
elements.disconnectButton.addEventListener('click', () => {
  state.intentionalClose = true
  state.socket?.close(1000, 'user disconnected')
  elements.deviceView.hidden = true
  elements.setupView.hidden = false
  elements.setupMessage.textContent = '当前手机连接已断开。配对信息仍安全保留在这个浏览器中。'
  elements.connectButton.hidden = false
})

connect()
