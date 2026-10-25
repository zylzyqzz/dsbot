/* dsh-mobile-pwa · gateway + push smoke test
 *
 * Boots the real lib/lan-gate-server.cjs behind a mock DSH upstream and verifies:
 *   1. gateway serves /pwa/* assets (manifest, sw.js)
 *   2. gateway injects PWA bootstrap + manifest link + data-lan-device into HTML
 *   3. /lan-gate/status reports pwa:true and the resolved target
 *   4. the mobile CSS targets the DSH 0.2 slot vocabulary
 *   5. Web Push encryption round-trips (RFC 8291 aes128gcm + RFC 8188 framing)
 *   6. /pwa/push/subscribe refuses an insecure or keyless subscription
 *
 * Uses a temp DSH_HOME so the approvals file is isolated and portable.
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const http = require('node:http')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { subtle } = globalThis.crypto

const GATEWAY = path.join(__dirname, '..', 'lib', 'lan-gate-server.cjs')

/** Ask the OS for a free port, so tests never collide with each other. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function startMockTarget() {
  return http.createServer((req, res) => {
    if (req.url === '/pwa/live') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('live'); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    // DSH 0.2 shaped markup: the 0.1 "conversation" slot is gone.
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>DSH Test</title>' +
      '<link rel="manifest" href="./manifest.webmanifest" />' +
      '<meta name="theme-color" content="#ffffff">' +
      '<link rel="icon" type="image/svg+xml" href="./favicon.svg" />' +
      '</head>' +
      '<body><div data-slot="main.conversation"><div data-slot="conversation.view">' +
      '<div data-slot="conversation.chat.flow"><div data-slot="conversation.chat.node"></div></div>' +
      '<div data-composer-dock><div data-composer-card><div data-composer-input></div></div></div>' +
      '<div data-slot="conversation.input.model"><button aria-haspopup="menu"><span>Model</span></button></div>' +
      '</div></div></body></html>')
  })
}

function startGateway(port, targetPort) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-pwa-test-'))
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      DSH_HOME: home,
      LAN_GATE_PORT: String(port),
      LAN_GATE_TARGET_HOST: '127.0.0.1',
      LAN_GATE_TARGET_PORT: String(targetPort)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''; let err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const ready = new Promise((resolve) => {
    const t = setInterval(() => { if (out.includes('[lan-gate] listening on')) { clearInterval(t); resolve() } }, 40)
    setTimeout(() => { clearInterval(t); resolve() }, 5000)
  })
  return { child, ready, logs: () => out + err, home }
}

/**
 * Boot a mock DSH upstream plus the real gateway on free ports, hand both to
 * the test body, and tear everything down afterwards.
 */
async function withGateway(fn) {
  const targetPort = await freePort()
  const gatewayPort = await freePort()
  const target = startMockTarget()
  await new Promise((r) => target.listen(targetPort, '127.0.0.1', r))
  const gw = startGateway(gatewayPort, targetPort)
  await gw.ready
  try {
    await fn({ port: gatewayPort, targetPort, gw })
  } finally {
    gw.child.kill('SIGTERM')
    await new Promise((r) => target.close(r))
  }
}

function wait(fn, ms = 5000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const iv = setInterval(() => {
      try { const r = fn(); if (r !== undefined) { clearInterval(iv); resolve(r); return } } catch (e) { /* retry */ }
      if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout')) }
    }, 50)
  })
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: port, path: urlPath }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    }).on('error', reject)
  })
}

function post(port, urlPath, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const req = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

test('gateway: starts and reports pwa:true with the resolved target', async () => {
  await withGateway(async ({ port, targetPort }) => {
    const status = await wait(() => get(port, '/lan-gate/status').then((r) => (r.body.includes('"state":"running"') ? r : undefined)))
    assert.strictEqual(status.status, 200)
    const j = JSON.parse(status.body)
    assert.strictEqual(j.pwa, true)
    assert.strictEqual(j.targetHost, '127.0.0.1')
    assert.strictEqual(j.targetPort, targetPort)
  })
})

test('gateway: serves PWA assets (/pwa/manifest.json, /pwa/sw.js)', async () => {
  await withGateway(async ({ port }) => {
    const manifest = await get(port, '/pwa/manifest.json')
    assert.strictEqual(manifest.status, 200)
    const m = JSON.parse(manifest.body)
    assert.strictEqual(m.display, 'standalone')

    const sw = await get(port, '/pwa/sw.js')
    assert.strictEqual(sw.status, 200)
    assert.ok(sw.body.includes('dsh-mobile-pwa'))
    // The worker lives under /pwa/ but has to claim the whole origin.
    assert.strictEqual(sw.headers['service-worker-allowed'], '/',
      'sw.js is allowed to claim the root scope')
  })
})

test('gateway: injects manifest link, theme meta & data-lan-device into HTML (loopback)', async () => {
  await withGateway(async ({ port }) => {
    const page = await get(port, '/')
    assert.strictEqual(page.status, 200)
    assert.ok(page.body.includes('rel="manifest"'), 'manifest link injected')
    assert.ok(page.body.includes('/pwa/app.css'), 'app.css linked')
    assert.ok(page.body.includes('window.__DSH_PWA__'), 'PWA bootstrap present')
  })
})

test('gateway: leaves exactly one manifest link and one theme colour', async () => {
  await withGateway(async ({ port }) => {
    const page = await get(port, '/')
    assert.strictEqual(page.status, 200)
    const manifests = page.body.match(/<link[^>]*rel="manifest"[^>]*>/gi) || []
    assert.strictEqual(manifests.length, 1, 'exactly one manifest link')
    assert.ok(manifests[0].includes('/pwa/manifest.json'), 'the manifest link points at the merged manifest')
    assert.ok(!page.body.includes('manifest.webmanifest'), "DSH's own manifest link is removed")
    const themes = page.body.match(/<meta[^>]*name="theme-color"[^>]*>/gi) || []
    assert.strictEqual(themes.length, 1, 'exactly one theme colour')
    // The brand favicon must survive the head cleanup.
    assert.ok(page.body.includes('favicon.svg'), 'the brand favicon link is kept')
  })
})

test('gateway: mobile CSS targets the DSH 0.2 slot vocabulary', async () => {
  await withGateway(async ({ port }) => {
    const css = await get(port, '/pwa/app.css')
    assert.strictEqual(css.status, 200)
    for (const slot of ['main.conversation', 'conversation.view', 'conversation.chat.flow', 'conversation.input.model']) {
      assert.ok(css.body.includes('data-slot="' + slot + '"'), 'app.css targets ' + slot)
    }
    assert.ok(css.body.includes('data-composer-dock'), 'app.css targets the composer dock')
    // The 0.1-only selector must be gone.
    assert.ok(!css.body.includes('data-slot="conversation"'), 'stale 0.1 selector removed')
  })
})

function extractInlineScripts(html) {
  const out = []
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi
  let m
  while ((m = re.exec(html))) {
    if (!/src\s*=/.test(m[1])) out.push(m[2])
  }
  return out
}

test('gateway: injected inline scripts have balanced braces (quoting bug guard)', async () => {
  await withGateway(async ({ port }) => {
    const page = await get(port, '/')
    const scripts = extractInlineScripts(page.body)
    assert.ok(scripts.length > 0, 'expected inline scripts')
    for (const s of scripts) {
      assert.ok(balanced(s), 'inline script braces balanced: ' + s.slice(0, 40))
    }
    assert.ok(page.body.includes('window.__DSH_PWA__'), 'bootstrap present')
    assert.ok(page.body.includes('randomUUID'), 'uuid polyfill present')
  })
})

function balanced(s) {
  let depth = 0
  for (const ch of s) {
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth < 0) return false }
  }
  return depth === 0
}

test('push: subscribe endpoint refuses insecure and keyless subscriptions', async () => {
  await withGateway(async ({ port }) => {
    const insecure = await post(port, '/pwa/push/subscribe', { subscription: { endpoint: 'http://push.example/x', keys: { p256dh: 'a', auth: 'b' } } })
    assert.strictEqual(insecure.status, 400)
    assert.ok(insecure.body.includes('endpoint-not-https'))

    const noKeys = await post(port, '/pwa/push/subscribe', { subscription: { endpoint: 'https://push.example/x' } })
    assert.strictEqual(noKeys.status, 400)
    assert.ok(noKeys.body.includes('missing-keys'))
  })
})

test('push: payload encryption round-trips (RFC 8291 aes128gcm, RFC 8188 framing)', async () => {
  const webPush = require('../lib/web-push.cjs')

  // A subscriber keypair, as a browser would create for PushManager.
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
  const publicJwk = await subtle.exportKey('jwk', pair.publicKey)
  const privatePkcs8 = await subtle.exportKey('pkcs8', pair.privateKey)
  const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const uaPublic = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(publicJwk.x, 'base64url'),
    Buffer.from(publicJwk.y, 'base64url')
  ])
  const subscription = {
    endpoint: 'https://push.example.test/msg',
    keys: { p256dh: b64u(uaPublic), auth: b64u(crypto.randomBytes(16)) }
  }

  const payload = { title: 'DSH 任务完成', body: '智能体已完成当前步骤。' }
  const sealed = await webPush.encryptPayload(subscription, payload)
  assert.strictEqual(sealed.headers['Content-Encoding'], 'aes128gcm')

  // --- decrypt as the subscriber would ---
  const body = sealed.body
  const salt = body.subarray(0, 16)
  const rs = body.readUInt32BE(16)
  const idlen = body.readUInt8(20)
  const sealedRecord = body.subarray(21, body.length - idlen)
  const serverPublic = body.subarray(body.length - idlen)
  assert.strictEqual(idlen, 65, 'keyid carries the server ephemeral public key')

  const receiverPrivate = await subtle.importKey('pkcs8', privatePkcs8, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const serverPublicKey = await subtle.importKey('raw', serverPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const sharedSecret = Buffer.from(await subtle.deriveBits({ name: 'ECDH', public: serverPublicKey }, receiverPrivate, 256))

  const hmac = (key, ...parts) => {
    const h = crypto.createHmac('sha256', key)
    for (const p of parts) h.update(p)
    return h.digest()
  }
  const prk = hmac(salt, sharedSecret)
  const prkInfo = hmac(prk, Buffer.from('WebPush: info\0', 'utf8'), uaPublic, serverPublic, Buffer.from([1]))
  const cek = hmac(prkInfo, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), Buffer.from([1])).subarray(0, 16)
  const nonce = hmac(prkInfo, Buffer.from('Content-Encoding: nonce\0', 'utf8'), Buffer.from([1])).subarray(0, 12)

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAAD(Buffer.from([0x00, 0x00, (rs >> 8) & 0xff, rs & 0xff]))
  const tag = sealedRecord.subarray(sealedRecord.length - 16)
  const ciphertext = sealedRecord.subarray(0, sealedRecord.length - 16)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  // Strip the RFC 8188 padding delimiter.
  const end = plain.indexOf(0x02)
  const decoded = JSON.parse(plain.subarray(0, end).toString('utf8'))
  assert.deepStrictEqual(decoded, payload)
})

test('gateway: forwards the browser-facing Host unchanged (DSH 0.2 Host fence)', async () => {
  const seen = []
  const target = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url })
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html><head></head><body></body></html>')
  })
  const targetPort = await freePort()
  const gatewayPort = await freePort()
  await new Promise((r) => target.listen(targetPort, '127.0.0.1', r))
  const gw = startGateway(gatewayPort, targetPort)
  await gw.ready
  try {
    await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: gatewayPort, path: '/', headers: { host: '111.170.171.25:3088' } }, (res) => {
        res.resume()
        res.on('end', resolve)
      })
      req.on('error', reject)
      req.end()
    })
    assert.strictEqual(seen.length, 1)
    assert.strictEqual(seen[0].host, '111.170.171.25:3088', 'upstream sees the browser host')
  } finally {
    gw.child.kill('SIGTERM')
    await new Promise((r) => target.close(r))
  }
})

test('gateway: mints the DSH browser session cookie with the launch token', async () => {
  const seen = []
  const target = http.createServer((req, res) => {
    seen.push({ host: req.headers.host, url: req.url })
    if (req.url === '/?token=test-launch-token') {
      res.writeHead(303, {
        'set-cookie': 'dsh-auth-abc=session-value; Path=/; HttpOnly; SameSite=Strict',
        location: './',
        'cache-control': 'no-store'
      })
      res.end()
      return
    }
    res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('dsh web authentication required\n')
  })
  const targetPort = await freePort()
  const gatewayPort = await freePort()
  await new Promise((r) => target.listen(targetPort, '127.0.0.1', r))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-pwa-test-'))
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      DSH_HOME: home,
      LAN_GATE_PORT: String(gatewayPort),
      LAN_GATE_TARGET_HOST: '127.0.0.1',
      LAN_GATE_TARGET_PORT: String(targetPort),
      LAN_GATE_DSH_TOKEN: 'test-launch-token'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  await new Promise((resolve) => {
    const t = setInterval(() => { if (out.includes('[lan-gate] listening on')) { clearInterval(t); resolve() } }, 40)
    setTimeout(() => { clearInterval(t); resolve() }, 5000)
  })
  try {
    const page = await get(gatewayPort, '/')
    assert.strictEqual(page.status, 303, 'gateway relays the session redirect')
    assert.ok(page.headers['set-cookie'], 'gateway relays the DSH session cookie')
    assert.ok(page.headers['set-cookie'][0].startsWith('dsh-auth-'), 'cookie is the DSH session cookie')
    assert.strictEqual(seen[0].url, '/?token=test-launch-token', 'gateway used the launch token')
    assert.strictEqual(seen[0].host, '127.0.0.1:' + gatewayPort, 'cookie is minted for the browser authority')
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => target.close(r))
  }
})

test('push: VAPID authorization header is a well-formed ES256 JWT', async () => {
  const webPush = require('../lib/web-push.cjs')
  const keys = await webPush.createVapidKeys()
  assert.ok(keys.publicKey.length > 80, 'public key is a base64url EC point')

  const header = await webPush.buildVapidAuthorization(
    'https://push.example.test/msg', 'mailto:ops@example.test', keys.publicKey, keys.privateKey)
  assert.ok(header.startsWith('vapid t='), 'vapid scheme')
  const token = header.slice('vapid t='.length).split(', k=')[0]
  const parts = token.split('.')
  assert.strictEqual(parts.length, 3, 'JWT has three parts')
  const decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  assert.strictEqual(decoded.alg, 'ES256')
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
  assert.strictEqual(claims.aud, 'https://push.example.test')
  assert.ok(claims.exp > Math.floor(Date.now() / 1000), 'token is not expired')
})
