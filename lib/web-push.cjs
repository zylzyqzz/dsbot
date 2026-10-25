/* dsh-mobile-pwa · lib/web-push.cjs
 *
 * Real Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) with zero dependencies.
 *
 * The browser's PushManager only accepts an encrypted body: the payload is
 * sealed to the subscriber's p256dh key and the request is authorised with a
 * VAPID JWT. Posting plain JSON to the push endpoint (what earlier revisions
 * of this plugin did) is rejected by every real push service.
 *
 * Implemented here:
 *   - VAPID keypair generation / persistence / import
 *   - ES256 (P-256) VAPID JWT
 *   - ECDH + HKDF key derivation (RFC 8291)
 *   - AES-128-GCM record encryption (RFC 8188), single 4096-byte record
 *
 * Node >= 20 exposes WebCrypto on globalThis.crypto.
 */
'use strict'

const crypto = require('node:crypto')

const subtle = globalThis.crypto && globalThis.crypto.subtle
  ? globalThis.crypto.subtle
  : require('node:crypto').webcrypto.subtle

const P256 = { name: 'ECDSA', namedCurve: 'P-256' }
const ECDH = { name: 'ECDH', namedCurve: 'P-256' }
const RECORD_SIZE = 4096

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64url(str) {
  const value = String(str || '').replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(value + '='.repeat((4 - (value.length % 4)) % 4), 'base64')
}

async function hmac(keyBytes, data) {
  const key = await subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return Buffer.from(await subtle.sign('HMAC', key, data))
}

/** HKDF-Extract(salt, ikm) — PRK. */
async function hkdfExtract(salt, ikm) {
  return hmac(salt, ikm)
}

/** HKDF-Expand(prk, info, length). */
async function hkdfExpand(prk, info, length) {
  const blocks = []
  let previous = Buffer.alloc(0)
  let produced = 0
  for (let counter = 1; produced < length; counter++) {
    const block = await hmac(prk, Buffer.concat([previous, Buffer.from(info), Buffer.from([counter])]))
    previous = block
    blocks.push(block)
    produced += block.length
  }
  return Buffer.concat(blocks).subarray(0, length)
}

/** Raw uncompressed EC point (0x04 || X || Y) from a public JWK. */
function publicPointFromJwk(jwk) {
  return Buffer.concat([
    Buffer.from([0x04]),
    unb64url(jwk.x),
    unb64url(jwk.y)
  ])
}

/**
 * Create a VAPID keypair.
 * @returns {{ publicKey: string, privateKey: string }} base64url raw public point and PKCS#8 private key
 */
async function createVapidKeys() {
  const pair = await subtle.generateKey(P256, true, ['sign', 'verify'])
  const pkcs8 = await subtle.exportKey('pkcs8', pair.privateKey)
  const jwk = await subtle.exportKey('jwk', pair.publicKey)
  return {
    publicKey: b64url(publicPointFromJwk(jwk)),
    privateKey: b64url(new Uint8Array(pkcs8))
  }
}

/**
 * Load the VAPID keypair from disk, or create and persist one.
 * @param {string} file - JSON file holding { publicKey, privateKey }
 */
async function loadOrCreateVapidKeys(file) {
  const fs = require('node:fs')
  const path = require('node:path')
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && typeof raw.publicKey === 'string' && typeof raw.privateKey === 'string') {
      return { publicKey: raw.publicKey, privateKey: raw.privateKey }
    }
  } catch (e) { /* not created yet */ }

  const keys = await createVapidKeys()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(keys, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  } catch (e) { /* keep running with the in-memory keypair */ }
  return keys
}

/**
 * Build the `Authorization: vapid t=<jwt>, k=<publicKey>` header value.
 * @param {string} audience - origin of the push endpoint, e.g. https://fcm.googleapis.com
 * @param {string} subject - mailto: or https: contact for the push service
 * @param {string} publicKey - base64url raw public point
 * @param {string} privateKey - base64url PKCS#8 private key
 */
async function buildVapidAuthorization(audience, subject, publicKey, privateKey) {
  const header = { typ: 'JWT', alg: 'ES256' }
  const payload = {
    aud: new URL(audience).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: subject
  }
  const signingInput =
    b64url(Buffer.from(JSON.stringify(header), 'utf8')) + '.' +
    b64url(Buffer.from(JSON.stringify(payload), 'utf8'))

  const key = await subtle.importKey(
    'pkcs8',
    unb64url(privateKey),
    P256,
    false,
    ['sign']
  )
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    Buffer.from(signingInput, 'utf8')
  )
  return 'vapid t=' + signingInput + '.' + b64url(new Uint8Array(signature)) + ', k=' + publicKey
}

/**
 * Encrypt a JSON payload for one push subscription (RFC 8291 aes128gcm).
 *
 * @param {{ endpoint: string, keys?: { p256dh?: string, auth?: string } }} subscription
 * @param {unknown} payload
 * @returns {Promise<{ body: Buffer, headers: Record<string, string> }>}
 */
async function encryptPayload(subscription, payload) {
  const keys = (subscription && subscription.keys) || {}
  if (!keys.p256dh || !keys.auth) throw new Error('subscription is missing p256dh/auth keys')

  const receiverRaw = unb64url(keys.p256dh)
  const salt = crypto.randomBytes(16)

  const receiverKey = await subtle.importKey('raw', receiverRaw, ECDH, false, [])
  const ephemeral = await subtle.generateKey(ECDH, true, ['deriveBits'])
  const sharedSecret = Buffer.from(
    await subtle.deriveBits({ name: 'ECDH', public: receiverKey }, ephemeral.privateKey, 256)
  )
  const ephemeralJwk = await subtle.exportKey('jwk', ephemeral.publicKey)
  const ephemeralRaw = publicPointFromJwk(ephemeralJwk)

  // RFC 8291 §3.4
  const prk = await hkdfExtract(salt, sharedSecret)
  const info = Buffer.concat([
    Buffer.from('WebPush: info\0', 'utf8'),
    receiverRaw,
    ephemeralRaw
  ])
  const prkInfo = await hkdfExpand(prk, info, 32)
  const cek = await hkdfExpand(prkInfo, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
  const nonce = await hkdfExpand(prkInfo, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)

  // RFC 8188 single record: payload || 0x02 delimiter || zero padding.
  const plain = Buffer.from(JSON.stringify(payload), 'utf8')
  if (plain.length + 1 > RECORD_SIZE - 16) throw new Error('payload too large for one push record')
  const paddedLength = Math.ceil((plain.length + 1) / 16) * 16
  const record = Buffer.alloc(paddedLength)
  plain.copy(record, 0)
  record[plain.length] = 0x02

  const aesKey = await subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
  const aad = Buffer.from([0x00, 0x00, (RECORD_SIZE >> 8) & 0xff, RECORD_SIZE & 0xff])
  const sealed = Buffer.from(
    await subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad }, aesKey, record)
  )

  // RFC 8188 body framing: salt || rs || idlen || ciphertext, followed by the
  // keyid (the server's ephemeral public key) the receiver needs to derive
  // the same keys.
  const header = Buffer.concat([
    salt,
    aad,
    Buffer.from([ephemeralRaw.length])
  ])

  return {
    body: Buffer.concat([header, sealed, ephemeralRaw]),
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(header.length + sealed.length + ephemeralRaw.length)
    }
  }
}

module.exports = {
  b64url,
  unb64url,
  createVapidKeys,
  loadOrCreateVapidKeys,
  buildVapidAuthorization,
  encryptPayload
}
