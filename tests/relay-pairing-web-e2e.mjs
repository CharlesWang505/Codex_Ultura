import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import WebSocket from 'ws'
import { gcm } from '@noble/ciphers/aes.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

const host = '127.0.0.1'
const port = 4184
const baseUrl = `http://${host}:${port}`
const websocketUrl = `ws://${host}:${port}/ws`
const encoder = new TextEncoder()
const roomId = randomUUID()
const desktopDeviceId = randomUUID()
const token = randomBytes(32).toString('base64url')
const encryptionKey = randomBytes(32).toString('base64url')
const pairings = new Map()
const mobileRequestCode = '604218'
const desktopInviteCode = '381527'

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

function pairingProofMessage({
  pairingId,
  mobileDeviceId,
  clientPublicKey,
  desktopPublicKey,
  requestNonce,
}) {
  return `codex-compass-relay-pairing-proof-v1\n${pairingId}\n${mobileDeviceId}\n${desktopDeviceId}\n${clientPublicKey}\n${desktopPublicKey}\n${requestNonce}`
}

function derivePairingKey(sharedSecret, code, pairingId, mobileDeviceId) {
  const info = encoder.encode(
    `codex-compass-relay-pairing-key-v1\0${pairingId}\0${mobileDeviceId}\0${desktopDeviceId}`,
  )
  return hkdf(sha256, sharedSecret, sha256(encoder.encode(code)), info, 32)
}

function encryptedCredentials(record) {
  const aad = `codex-compass-relay-pairing-payload-v1\n${record.pairingId}\n${record.mobileDeviceId}\n${desktopDeviceId}`
  const nonce = randomBytes(12)
  const plaintext = encoder.encode(JSON.stringify({
    protocolVersion: 1,
    publicWebUrl: baseUrl,
    roomId,
    desktopDeviceId,
    token,
    key: encryptionKey,
  }))
  const ciphertext = gcm(record.pairingKey, nonce, encoder.encode(aad)).encrypt(plaintext)
  return {
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(ciphertext),
    aad,
  }
}

function pairingFrame(kind, pairingId, targetDeviceId, payload = {}) {
  return {
    protocolVersion: 1,
    kind,
    messageId: randomUUID(),
    pairingId,
    senderDeviceId: desktopDeviceId,
    targetDeviceId,
    payload,
  }
}

const relay = spawn(process.execPath, ['server/index.mjs'], {
  cwd: path.resolve('.'),
  env: { ...process.env, RELAY_HOST: host, RELAY_PORT: String(port) },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('relay pairing test startup timed out')), 10_000)
  relay.once('error', reject)
  relay.stdout.on('data', (chunk) => {
    if (!chunk.toString('utf8').includes('relay listening')) return
    clearTimeout(timer)
    resolve()
  })
})

const desktop = new WebSocket(websocketUrl)
await new Promise((resolve, reject) => {
  desktop.once('open', () => {
    desktop.send(JSON.stringify({
      protocolVersion: 1,
      kind: 'auth',
      role: 'desktop',
      roomId,
      deviceId: desktopDeviceId,
      token,
    }))
  })
  desktop.on('message', (data) => {
    const value = JSON.parse(data.toString('utf8'))
    if (value.kind === 'authenticated') resolve()
  })
  desktop.once('error', reject)
})

desktop.send(JSON.stringify({
  protocolVersion: 1,
  kind: 'presence.desktop.status',
  messageId: randomUUID(),
  senderDeviceId: desktopDeviceId,
  payload: {
    deviceName: 'E2E 配对测试电脑',
    remoteEnabled: true,
    paused: false,
    codexInstalled: true,
    codexRunning: true,
    codexAuthenticated: true,
    appServerAvailable: true,
    codexVersion: 'codex-cli 0.142.5',
    activeSessions: 3,
  },
}))

desktop.on('message', (data) => {
  void handleDesktopMessage(JSON.parse(data.toString('utf8')))
})

async function handleDesktopMessage(value) {
  if (value.kind === 'pairing.request') {
    const keys = x25519.keygen()
    const record = {
      pairingId: value.pairingId,
      mobileDeviceId: value.senderDeviceId,
      code: mobileRequestCode,
      keys,
      desktopPublicKey: bytesToBase64Url(keys.publicKey),
    }
    pairings.set(value.pairingId, record)
    desktop.send(JSON.stringify(pairingFrame(
      'pairing.challenge',
      value.pairingId,
      value.senderDeviceId,
      {
        desktopName: 'E2E 配对测试电脑',
        desktopPublicKey: record.desktopPublicKey,
      },
    )))
    return
  }
  if (value.kind !== 'pairing.proof') return
  const record = pairings.get(value.pairingId)
  assert.ok(record)
  const canonical = pairingProofMessage({
    pairingId: value.pairingId,
    mobileDeviceId: value.senderDeviceId,
    clientPublicKey: value.payload.clientPublicKey,
    desktopPublicKey: record.desktopPublicKey,
    requestNonce: value.payload.requestNonce,
  })
  const expectedProof = hmac(sha256, encoder.encode(record.code), encoder.encode(canonical))
  assert.equal(
    Buffer.from(value.payload.proof, 'base64url').equals(Buffer.from(expectedProof)),
    true,
  )
  const sharedSecret = x25519.getSharedSecret(
    record.keys.secretKey,
    Buffer.from(value.payload.clientPublicKey, 'base64url'),
  )
  record.pairingKey = derivePairingKey(
    sharedSecret,
    record.code,
    record.pairingId,
    record.mobileDeviceId,
  )
  const completed = pairingFrame(
    'pairing.completed',
    record.pairingId,
    record.mobileDeviceId,
    encryptedCredentials(record),
  )
  const serialized = JSON.stringify(completed)
  assert.equal(serialized.includes(token), false)
  assert.equal(serialized.includes(encryptionKey), false)
  desktop.send(serialized)
}

const browser = await chromium.launch({ headless: true })

async function openUnpairedPage() {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: 'dark',
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.goto(baseUrl)
  await page.locator('#desktopDiscoveryList .desktop-discovery-row').waitFor()
  await page.getByText('Codex 在线 · 3 个活动任务').waitFor()
  return { context, page, consoleErrors }
}

try {
  const desktopInvite = await openUnpairedPage()
  const invitedMobileDeviceId = await desktopInvite.page.evaluate(
    () => localStorage.getItem('codexCompassRemoteDeviceId'),
  )
  assert.ok(invitedMobileDeviceId)
  const inviteKeys = x25519.keygen()
  const invitePairingId = randomUUID()
  pairings.set(invitePairingId, {
    pairingId: invitePairingId,
    mobileDeviceId: invitedMobileDeviceId,
    code: desktopInviteCode,
    keys: inviteKeys,
    desktopPublicKey: bytesToBase64Url(inviteKeys.publicKey),
  })
  desktop.send(JSON.stringify(pairingFrame(
    'pairing.invite',
    invitePairingId,
    invitedMobileDeviceId,
    {
      desktopName: 'E2E 配对测试电脑',
      desktopPublicKey: bytesToBase64Url(inviteKeys.publicKey),
    },
  )))
  await desktopInvite.page.locator('#pairingDialog:not([hidden])').waitFor()
  await desktopInvite.page.getByText('电脑发起邀请').waitFor()
  await desktopInvite.page.screenshot({
    path: path.join(tmpdir(), 'codex-compass-relay-pairing-desktop-invite.png'),
    fullPage: true,
  })
  await desktopInvite.page.locator('#relayPairingCode').fill(desktopInviteCode)
  await desktopInvite.page.locator('#submitPairingButton').click()
  await desktopInvite.page.locator('#deviceView:not([hidden])').waitFor({ timeout: 10_000 })
  assert.equal(await desktopInvite.page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('codexCompassRemoteCredentials:v1'))
    return Boolean(stored?.roomId && stored?.token && stored?.key)
  }), true)
  assert.deepEqual(desktopInvite.consoleErrors, [])
  await desktopInvite.context.close()

  const mobileRequest = await openUnpairedPage()
  await mobileRequest.page.locator('#desktopDiscoveryList .desktop-discovery-row > button').click()
  await mobileRequest.page.locator('#pairingDialog:not([hidden])').waitFor()
  await mobileRequest.page.getByText('手机发起请求').waitFor()
  await mobileRequest.page.locator('#relayPairingCode:not([disabled])').waitFor()
  await mobileRequest.page.screenshot({
    path: path.join(tmpdir(), 'codex-compass-relay-pairing-mobile-request.png'),
    fullPage: true,
  })
  await mobileRequest.page.locator('#relayPairingCode').fill(mobileRequestCode)
  await mobileRequest.page.locator('#submitPairingButton').click()
  await mobileRequest.page.locator('#deviceView:not([hidden])').waitFor({ timeout: 10_000 })
  assert.deepEqual(mobileRequest.consoleErrors, [])
  await mobileRequest.context.close()
} finally {
  await browser.close()
  desktop.close()
  relay.kill('SIGTERM')
}

console.log('Relay pairing web E2E passed: presence, desktop invite, mobile request, encrypted credential delivery.')
