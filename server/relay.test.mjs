import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PresenceRegistry,
  RoomRegistry,
  SlidingRateLimit,
  tokenDigest,
  tokenMatches,
  validateAuth,
  validateMobilePresence,
  validateRelayFrame,
} from './relay-core.mjs'
import { EncryptedUploadStore } from './upload-store.mjs'
import { deriveRelayPairingKey } from './web/relay-pairing-crypto.js'

const auth = {
  protocolVersion: 1,
  kind: 'auth',
  role: 'desktop',
  roomId: '019f6151-badc-72d0-b5ac-dc9bed3c2efd',
  deviceId: 'desktop-device-1',
  token: 'a'.repeat(43),
}

test('tokens are compared by digest', () => {
  const digest = tokenDigest(auth.token)
  assert.equal(tokenMatches(auth.token, digest), true)
  assert.equal(tokenMatches('b'.repeat(43), digest), false)
})

test('room registry isolates rooms and rejects a wrong token', () => {
  const registry = new RoomRegistry()
  const desktopSocket = { close() {} }
  const mobileSocket = { close() {} }
  const desktop = registry.authenticate(auth, desktopSocket)
  assert.equal(desktop.error, undefined)
  const rejected = registry.authenticate({ ...auth, role: 'mobile', deviceId: 'mobile-device-1', token: 'b'.repeat(43) }, mobileSocket)
  assert.match(rejected.error, /密钥/)
  const mobile = registry.authenticate({ ...auth, role: 'mobile', deviceId: 'mobile-device-1' }, mobileSocket)
  assert.equal(registry.targets(mobile.connection, auth.deviceId).length, 1)
  assert.equal(registry.authorizeUpload({
    roomId: auth.roomId,
    deviceId: mobile.connection.deviceId,
    targetDeviceId: auth.deviceId,
    token: auth.token,
  }), true)
  assert.equal(registry.authorizeUpload({
    roomId: auth.roomId,
    deviceId: mobile.connection.deviceId,
    targetDeviceId: 'missing-desktop',
    token: auth.token,
  }), false)
  const secondMobile = registry.authenticate({ ...auth, role: 'mobile', deviceId: 'mobile-device-2' }, { close() {} })
  assert.equal(registry.targets(mobile.connection, secondMobile.connection.deviceId).length, 0)
  assert.equal(registry.targets(mobile.connection, null).length, 0)
  assert.equal(registry.targets(desktop.connection, null).length, 2)
})

test('a mobile device cannot create or squat an empty room', () => {
  const registry = new RoomRegistry()
  const mobile = registry.authenticate(
    { ...auth, role: 'mobile', deviceId: 'mobile-device-1' },
    { close() {} },
  )
  assert.match(mobile.error, /电脑设备离线/)
  const desktop = registry.authenticate(auth, { close() {} })
  assert.equal(desktop.error, undefined)
})

test('relay frame sender must match authenticated connection', () => {
  const connection = { roomId: auth.roomId, deviceId: auth.deviceId }
  const frame = {
    protocolVersion: 1,
    kind: 'relay',
    roomId: auth.roomId,
    senderDeviceId: auth.deviceId,
    targetDeviceId: null,
    messageId: 'message-123',
    sequence: 1,
    nonce: 'nonce',
    payload: 'ciphertext',
  }
  assert.equal(validateRelayFrame(frame, connection), true)
  assert.equal(validateRelayFrame({ ...frame, senderDeviceId: 'other' }, connection), false)
  assert.equal(validateAuth({ ...auth, token: 'short' }), '访问密钥无效')
})

test('rate limit rejects excess messages inside the window', () => {
  const limit = new SlidingRateLimit(2, 1_000)
  assert.equal(limit.accept(1_000), true)
  assert.equal(limit.accept(1_100), true)
  assert.equal(limit.accept(1_200), false)
  assert.equal(limit.accept(2_001), true)
})

function mockSocket() {
  return {
    closed: false,
    close() { this.closed = true },
  }
}

test('presence registry discovers mobile and desktop devices without exposing room credentials', () => {
  const presence = new PresenceRegistry()
  const mobile = presence.registerMobile({
    protocolVersion: 1,
    kind: 'presence.mobile.register',
    deviceId: 'mobile-device-1',
    deviceName: 'WEK 手机',
    browser: 'Chrome Mobile',
    platform: 'Android',
  }, mockSocket(), '192.0.2.10')
  assert.equal(mobile.error, undefined)
  assert.equal(presence.mobileList()[0].deviceName, 'WEK 手机')
  assert.equal('remoteAddress' in presence.mobileList()[0], false)

  const desktopConnection = {
    socket: mockSocket(),
    channel: 'room',
    role: 'desktop',
    deviceId: auth.deviceId,
    pairingLimiter: new SlidingRateLimit(12),
  }
  const desktop = presence.registerDesktop(desktopConnection, {
    protocolVersion: 1,
    kind: 'presence.desktop.status',
    senderDeviceId: auth.deviceId,
    payload: {
      deviceName: '工作电脑',
      remoteEnabled: true,
      paused: false,
      codexInstalled: true,
      codexRunning: true,
      codexAuthenticated: true,
      appServerAvailable: true,
      activeSessions: 2,
      token: 'must-not-leak',
    },
  })
  assert.equal(desktop.status.deviceName, '工作电脑')
  assert.equal(desktop.status.appServerAvailable, true)
  assert.equal('token' in desktop.status, false)
  assert.equal(presence.desktopList().length, 1)
})

test('presence registry removes offline devices and enforces temporary mobile capacity', () => {
  const presence = new PresenceRegistry({ maxMobiles: 1 })
  const first = presence.registerMobile({
    protocolVersion: 1,
    kind: 'presence.mobile.register',
    deviceId: 'mobile-device-1',
    deviceName: '手机一',
    browser: 'Chrome',
    platform: 'Android',
  }, mockSocket())
  const rejected = presence.registerMobile({
    protocolVersion: 1,
    kind: 'presence.mobile.register',
    deviceId: 'mobile-device-2',
    deviceName: '手机二',
    browser: 'Safari',
    platform: 'iOS',
  }, mockSocket())
  assert.match(rejected.error, /上限/)
  const events = presence.remove(first.connection)
  assert.equal(events[0].message.kind, 'presence.mobile.offline')
  assert.equal(presence.mobileList().length, 0)
  assert.equal(validateMobilePresence({ kind: 'presence.mobile.register' }), '设备发现消息无效')
})

test('pairing routes are role isolated, expire, and complete only once', () => {
  const presence = new PresenceRegistry({ pairingTtlMs: 100 })
  const mobile = presence.registerMobile({
    protocolVersion: 1,
    kind: 'presence.mobile.register',
    deviceId: 'mobile-device-1',
    deviceName: '手机',
    browser: 'Chrome',
    platform: 'Android',
  }, mockSocket()).connection
  const desktop = {
    socket: mockSocket(),
    channel: 'room',
    role: 'desktop',
    deviceId: auth.deviceId,
    pairingLimiter: new SlidingRateLimit(12),
  }
  presence.registerDesktop(desktop, {
    protocolVersion: 1,
    kind: 'presence.desktop.status',
    senderDeviceId: auth.deviceId,
    payload: { deviceName: '电脑', remoteEnabled: true },
  })
  const request = {
    protocolVersion: 1,
    kind: 'pairing.request',
    messageId: 'pair-message-1',
    pairingId: 'pairing-request-123456',
    senderDeviceId: mobile.deviceId,
    targetDeviceId: desktop.deviceId,
    payload: {},
  }
  assert.equal(presence.pairingRoute(request, mobile, 1_000).target, desktop)
  assert.match(
    presence.pairingRoute({ ...request, kind: 'pairing.completed' }, mobile, 1_001).error,
    /角色/,
  )
  assert.equal(presence.pairingRoute({
    ...request,
    kind: 'pairing.challenge',
    senderDeviceId: desktop.deviceId,
    targetDeviceId: mobile.deviceId,
  }, desktop, 1_002).target, mobile)
  assert.equal(presence.pairingRoute({
    ...request,
    kind: 'pairing.proof',
  }, mobile, 1_003).target, desktop)
  assert.equal(presence.pairingRoute({
    ...request,
    kind: 'pairing.completed',
    senderDeviceId: desktop.deviceId,
    targetDeviceId: mobile.deviceId,
  }, desktop, 1_004).target, mobile)
  assert.match(presence.pairingRoute({
    ...request,
    kind: 'pairing.completed',
    senderDeviceId: desktop.deviceId,
    targetDeviceId: mobile.deviceId,
  }, desktop, 1_005).error, /不存在/)

  const expiring = { ...request, pairingId: 'pairing-request-expired' }
  assert.equal(presence.pairingRoute(expiring, mobile, 2_000).target, desktop)
  assert.match(presence.pairingRoute({
    ...expiring,
    kind: 'pairing.challenge',
    senderDeviceId: desktop.deviceId,
    targetDeviceId: mobile.deviceId,
  }, desktop, 2_101).error, /不存在|过期/)
})

test('browser and desktop derive the same HKDF relay pairing key', () => {
  const key = deriveRelayPairingKey({
    sharedSecret: new Uint8Array(32).fill(8),
    code: '123456',
    pairingId: 'pair',
    mobileDeviceId: 'mobile',
    desktopDeviceId: 'desktop',
  })
  assert.equal(
    Buffer.from(key).toString('hex'),
    '2c074647ed6dbfc30d19a7191169b190b396aa389bd4213e9d922967c9330dcb',
  )
})

test('encrypted uploads are isolated, expire, and can only be consumed once', () => {
  const store = new EncryptedUploadStore({ maxUploadBytes: 64, maxStoreBytes: 128, ttlMs: 100 })
  const created = store.put({
    roomId: auth.roomId,
    senderDeviceId: 'mobile-device-1',
    targetDeviceId: auth.deviceId,
    ciphertext: Buffer.alloc(32, 7),
    now: 1_000,
  })

  assert.equal(store.consume({
    uploadId: created.uploadId,
    downloadToken: 'wrong',
    roomId: auth.roomId,
    targetDeviceId: auth.deviceId,
    now: 1_001,
  }), null)
  assert.equal(store.consume({
    uploadId: created.uploadId,
    downloadToken: created.downloadToken,
    roomId: auth.roomId,
    targetDeviceId: 'other-desktop',
    now: 1_001,
  }), null)

  const ciphertext = store.consume({
    uploadId: created.uploadId,
    downloadToken: created.downloadToken,
    roomId: auth.roomId,
    targetDeviceId: auth.deviceId,
    now: 1_001,
  })
  assert.equal(ciphertext.length, 32)
  assert.equal(store.consume({
    uploadId: created.uploadId,
    downloadToken: created.downloadToken,
    roomId: auth.roomId,
    targetDeviceId: auth.deviceId,
    now: 1_002,
  }), null)

  const expiring = store.put({
    roomId: auth.roomId,
    senderDeviceId: 'mobile-device-1',
    targetDeviceId: auth.deviceId,
    ciphertext: Buffer.alloc(17, 1),
    now: 2_000,
  })
  assert.equal(store.consume({
    uploadId: expiring.uploadId,
    downloadToken: expiring.downloadToken,
    roomId: auth.roomId,
    targetDeviceId: auth.deviceId,
    now: 2_101,
  }), null)
})
