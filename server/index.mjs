import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import {
  MAX_MESSAGE_BYTES,
  PROTOCOL_VERSION,
  PresenceRegistry,
  RoomRegistry,
  validateDesktopPresence,
  validateRelayFrame,
} from './relay-core.mjs'
import {
  EncryptedUploadStore,
  MAX_UPLOAD_BYTES,
  UPLOAD_TTL_MS,
} from './upload-store.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web')
const host = process.env.RELAY_HOST || '127.0.0.1'
const port = Number(process.env.RELAY_PORT || 4178)
const registry = new RoomRegistry()
const presence = new PresenceRegistry()
const uploads = new EncryptedUploadStore()

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon'],
])

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  response.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  )
}

function requestHeader(request, name) {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value || ''
}

function bearerToken(request) {
  const authorization = requestHeader(request, 'authorization')
  return authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
}

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

async function readRequestBody(request, limit) {
  const declaredLength = Number(requestHeader(request, 'content-length'))
  if (Number.isFinite(declaredLength) && (declaredLength < 1 || declaredLength > limit)) {
    throw new Error('upload too large')
  }
  const chunks = []
  let length = 0
  for await (const chunk of request) {
    length += chunk.length
    if (length > limit) throw new Error('upload too large')
    chunks.push(chunk)
  }
  if (length < 1) throw new Error('upload is empty')
  return Buffer.concat(chunks, length)
}

async function handleUploadRequest(request, response) {
  const roomId = requestHeader(request, 'x-room-id')
  const deviceId = requestHeader(request, 'x-device-id')
  const targetDeviceId = requestHeader(request, 'x-target-device-id')
  const token = bearerToken(request)
  if (
    !registry.authorizeUpload({ roomId, deviceId, targetDeviceId, token })
    || !targetDeviceId
  ) {
    jsonResponse(response, 401, { error: 'upload authentication failed' })
    return
  }
  if (requestHeader(request, 'content-type').split(';')[0] !== 'application/octet-stream') {
    jsonResponse(response, 415, { error: 'encrypted uploads require application/octet-stream' })
    return
  }
  try {
    const ciphertext = await readRequestBody(request, MAX_UPLOAD_BYTES)
    const created = uploads.put({ roomId, senderDeviceId: deviceId, targetDeviceId, ciphertext })
    jsonResponse(response, 201, created)
  } catch (error) {
    const status = error.message.includes('full') ? 503 : 413
    jsonResponse(response, status, { error: error.message })
  }
}

function handleDownloadRequest(request, response, uploadId) {
  const roomId = requestHeader(request, 'x-room-id')
  const deviceId = requestHeader(request, 'x-device-id')
  const token = bearerToken(request)
  const downloadToken = requestHeader(request, 'x-upload-token')
  if (!registry.authorizeDevice({ roomId, deviceId, token, role: 'desktop' })) {
    jsonResponse(response, 401, { error: 'download authentication failed' })
    return
  }
  const ciphertext = uploads.consume({
    uploadId,
    downloadToken,
    roomId,
    targetDeviceId: deviceId,
  })
  if (!ciphertext) {
    jsonResponse(response, 404, { error: 'encrypted upload expired or unavailable' })
    return
  }
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': ciphertext.length,
    'Cache-Control': 'no-store',
  })
  response.end(ciphertext)
}

const uploadCleanupTimer = setInterval(() => uploads.purge(), Math.min(UPLOAD_TTL_MS, 60_000))
uploadCleanupTimer.unref()

const server = createServer(async (request, response) => {
  securityHeaders(response)
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  if (url.pathname === '/api/uploads' && request.method === 'POST') {
    await handleUploadRequest(request, response)
    return
  }
  const uploadMatch = url.pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})$/i)
  if (uploadMatch && request.method === 'GET') {
    handleDownloadRequest(request, response, uploadMatch[1])
    return
  }
  if (url.pathname === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ ok: true, protocolVersion: PROTOCOL_VERSION }))
    return
  }
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
  const resolved = path.resolve(root, relative)
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`) || !existsSync(resolved) || !statSync(resolved).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Not found')
    return
  }
  response.writeHead(200, {
    'Content-Type': contentTypes.get(path.extname(resolved)) || 'application/octet-stream',
    'Cache-Control': relative === 'index.html' ? 'no-store' : 'public, max-age=3600',
  })
  createReadStream(resolved).pipe(response)
})

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false })

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  if (url.pathname !== '/ws') {
    socket.destroy()
    return
  }
  websocketServer.handleUpgrade(request, socket, head, (websocket) => websocketServer.emit('connection', websocket))
})

websocketServer.on('connection', (socket) => {
  let connection = null
  const authenticationTimer = setTimeout(() => socket.close(4001, 'authentication timeout'), 10_000)
  const remoteAddress = socket._socket?.remoteAddress || ''

  const sendJson = (target, value) => {
    if (target?.socket?.readyState === WebSocket.OPEN) {
      target.socket.send(JSON.stringify(value))
    }
  }

  const broadcast = (targets, value) => {
    for (const target of targets) sendJson(target, value)
  }

  socket.on('message', (bytes, binary) => {
    if (binary || bytes.length > MAX_MESSAGE_BYTES) {
      socket.close(1009, 'message too large')
      return
    }
    let value
    try {
      value = JSON.parse(bytes.toString('utf8'))
    } catch {
      socket.close(1007, 'invalid json')
      return
    }
    if (!connection) {
      const result = value.kind === 'presence.mobile.register'
        ? presence.registerMobile(value, socket, remoteAddress)
        : registry.authenticate(value, socket)
      if (result.error) {
        socket.send(JSON.stringify({ kind: 'error', message: result.error }))
        socket.close(4003, 'authentication failed')
        return
      }
      clearTimeout(authenticationTimer)
      connection = result.connection
      if (connection.channel === 'presence') {
        socket.send(JSON.stringify({
          kind: 'presence.registered',
          protocolVersion: PROTOCOL_VERSION,
          deviceId: connection.deviceId,
        }))
        socket.send(JSON.stringify({
          kind: 'presence.desktop.list',
          protocolVersion: PROTOCOL_VERSION,
          desktops: presence.desktopList(),
        }))
        broadcast(presence.desktopConnections(), {
          protocolVersion: PROTOCOL_VERSION,
          kind: 'presence.mobile.online',
          device: presence.mobileStatus(connection),
        })
      } else {
        socket.send(JSON.stringify({ kind: 'authenticated', protocolVersion: PROTOCOL_VERSION }))
        if (connection.role === 'desktop') {
          socket.send(JSON.stringify({
            kind: 'presence.mobile.list',
            protocolVersion: PROTOCOL_VERSION,
            devices: presence.mobileList(),
          }))
        }
      }
      return
    }
    if (!connection.limiter.accept()) {
      socket.close(4008, 'rate limit')
      return
    }
    if (connection.channel === 'presence') {
      if (value.kind === 'presence.mobile.heartbeat') {
        presence.touchMobile(connection)
        socket.send(JSON.stringify({ kind: 'ack', messageId: value.messageId || null, delivered: 1 }))
        return
      }
      if (value.kind === 'presence.desktop.list.request') {
        socket.send(JSON.stringify({
          kind: 'presence.desktop.list',
          protocolVersion: PROTOCOL_VERSION,
          desktops: presence.desktopList(),
        }))
        return
      }
      if (value.kind.startsWith('pairing.')) {
        const routed = presence.pairingRoute(value, connection)
        if (routed.error) {
          socket.send(JSON.stringify({ kind: 'error', message: routed.error, pairingId: value.pairingId || null }))
          return
        }
        sendJson(routed.target, routed.message)
        socket.send(JSON.stringify({ kind: 'ack', messageId: value.messageId || null, delivered: 1 }))
        return
      }
      socket.close(1008, 'invalid presence frame')
      return
    }
    if (validateDesktopPresence(value, connection)) {
      const registered = presence.registerDesktop(connection, value)
      if (registered.error) {
        socket.send(JSON.stringify({ kind: 'error', message: registered.error }))
        return
      }
      broadcast(presence.mobileConnections(), {
        kind: 'presence.desktop.online',
        protocolVersion: PROTOCOL_VERSION,
        desktop: registered.status,
      })
      socket.send(JSON.stringify({ kind: 'ack', messageId: value.messageId || null, delivered: presence.mobileConnections().length }))
      return
    }
    if (value.kind === 'presence.mobile.list.request' && connection.role === 'desktop') {
      socket.send(JSON.stringify({
        kind: 'presence.mobile.list',
        protocolVersion: PROTOCOL_VERSION,
        devices: presence.mobileList(),
      }))
      return
    }
    if (value.kind?.startsWith('pairing.') && connection.role === 'desktop') {
      const routed = presence.pairingRoute(value, connection)
      if (routed.error) {
        socket.send(JSON.stringify({ kind: 'error', message: routed.error, pairingId: value.pairingId || null }))
        return
      }
      sendJson(routed.target, routed.message)
      socket.send(JSON.stringify({ kind: 'ack', messageId: value.messageId || null, delivered: 1 }))
      return
    }
    if (!validateRelayFrame(value, connection)) {
      socket.close(1008, 'invalid relay frame')
      return
    }
    const serialized = JSON.stringify(value)
    let delivered = 0
    for (const target of registry.targets(connection, value.targetDeviceId)) {
      if (target.socket.readyState === WebSocket.OPEN) {
        target.socket.send(serialized)
        delivered += 1
      }
    }
    socket.send(JSON.stringify({ kind: 'ack', messageId: value.messageId, delivered }))
  })

  socket.on('close', () => {
    clearTimeout(authenticationTimer)
    if (connection) {
      if (connection.channel === 'room') registry.remove(connection)
      for (const event of presence.remove(connection)) broadcast(event.recipients, event.message)
    }
  })
  socket.on('error', () => undefined)
})

server.listen(port, host, () => {
  process.stdout.write(`Codex Compass relay listening on http://${host}:${port}\n`)
})

function shutdown() {
  clearInterval(uploadCleanupTimer)
  for (const client of websocketServer.clients) client.close(1001, 'server shutdown')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
