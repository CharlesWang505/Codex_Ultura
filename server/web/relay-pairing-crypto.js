import { gcm } from '@noble/ciphers/aes.js'
import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function base64UrlToBytes(value) {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
}

export function bytesToBase64Url(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export function pairingProofMessage({
  pairingId,
  mobileDeviceId,
  desktopDeviceId,
  clientPublicKey,
  desktopPublicKey,
  requestNonce,
}) {
  return `codex-compass-relay-pairing-proof-v1\n${pairingId}\n${mobileDeviceId}\n${desktopDeviceId}\n${clientPublicKey}\n${desktopPublicKey}\n${requestNonce}`
}

export function deriveRelayPairingKey({
  sharedSecret,
  code,
  pairingId,
  mobileDeviceId,
  desktopDeviceId,
}) {
  const info = encoder.encode(
    `codex-compass-relay-pairing-key-v1\0${pairingId}\0${mobileDeviceId}\0${desktopDeviceId}`,
  )
  return hkdf(
    sha256,
    sharedSecret,
    sha256(encoder.encode(code)),
    info,
    32,
  )
}

export function createRelayPairingExchange({
  code,
  pairingId,
  mobileDeviceId,
  desktopDeviceId,
  desktopPublicKey,
}) {
  if (!/^\d{6}$/.test(code)) throw new Error('请输入电脑端显示的六位配对码')
  const clientKeys = x25519.keygen()
  const clientPublicKey = bytesToBase64Url(clientKeys.publicKey)
  const requestNonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16)))
  const sharedSecret = x25519.getSharedSecret(
    clientKeys.secretKey,
    base64UrlToBytes(desktopPublicKey),
  )
  if (sharedSecret.every((byte) => byte === 0)) throw new Error('电脑配对公钥无效')
  const proof = hmac(
    sha256,
    encoder.encode(code),
    encoder.encode(pairingProofMessage({
      pairingId,
      mobileDeviceId,
      desktopDeviceId,
      clientPublicKey,
      desktopPublicKey,
      requestNonce,
    })),
  )
  return {
    clientPublicKey,
    requestNonce,
    proof: bytesToBase64Url(proof),
    pairingKey: deriveRelayPairingKey({
      sharedSecret,
      code,
      pairingId,
      mobileDeviceId,
      desktopDeviceId,
    }),
  }
}

export function decryptRelayPairingCredentials(pairingKey, payload) {
  if (!payload?.nonce || !payload?.ciphertext || !payload?.aad) {
    throw new Error('电脑返回的加密配对凭据不完整')
  }
  const plaintext = gcm(
    pairingKey,
    base64UrlToBytes(payload.nonce),
    encoder.encode(payload.aad),
  ).decrypt(base64UrlToBytes(payload.ciphertext))
  const credentials = JSON.parse(decoder.decode(plaintext))
  if (
    credentials?.protocolVersion !== 1
    || typeof credentials.publicWebUrl !== 'string'
    || typeof credentials.roomId !== 'string'
    || typeof credentials.desktopDeviceId !== 'string'
    || typeof credentials.token !== 'string'
    || typeof credentials.key !== 'string'
  ) {
    throw new Error('电脑返回的配对凭据格式无效')
  }
  return credentials
}
