/* dsh-mobile-pwa · gateway + push smoke test
 *
 * Boots the real lib/lan-gate-server.cjs behind a mock DSH upstream and verifies:
 *   1. gateway serves /pwa/* assets (manifest, sw.js)
 *   2. gateway injects PWA bootstrap + manifest link + data-lan-device into HTML
 *   3. /lan-gate/status reports pwa:true and the resolved target
 *   4. the mobile CSS targets the DSH 0.2 slot vocabulary
 *   5. Web Push encryption round-trips (RFC 8291 aes128gcm + RFC 8188 framing)
 *   6. /pwa/push/subscribe refuses an insecure or keyless subscription
 *   7. the approval binds an address, a token binds a browser — two browsers
 *      behind one NAT address are both let in
 *   8. an approved device may raise the agent-done push itself
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

function startGateway(port, targetPort, extraEnv, seed) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mobile-pwa-test-'))
  // A decision file can be seeded, so the remote path can be tested without
  // driving the admin API (which is local-only by design).
  if (seed) {
    fs.writeFileSync(path.join(home, 'lan-gate-state.json'), JSON.stringify({ decisions: seed }, null, 2), 'utf8')
  }
  const child = spawn(process.execPath, [GATEWAY], {
    env: {
      ...process.env,
      DSH_HOME: home,
      LAN_GATE_PORT: String(port),
      LAN_GATE_TARGET_HOST: '127.0.0.1',
      LAN_GATE_TARGET_PORT: String(targetPort),
      ...(extraEnv || {})
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
async function withGateway(fn, extraEnv, seed) {
  const targetPort = await freePort()
  const gatewayPort = await freePort()
  const target = startMockTarget()
  await new Promise((r) => target.listen(targetPort, '127.0.0.1', r))
  const gw = startGateway(gatewayPort, targetPort, extraEnv, seed)
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

/** Same as get(), but sends a cookie back — that is how a browser is modelled. */
function getWithCookie(port, urlPath, cookie) {
  return new Promise((resolve, reject) => {
    const headers = cookie ? { cookie } : {}
    http.get({ host: '127.0.0.1', port: port, path: urlPath, headers }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    }).on('error', reject)
  })
}

function tokenCookie(res) {
  const raw = res.headers['set-cookie'] || []
  const hit = raw.find((c) => c.startsWith('lg_token='))
  if (!hit) return undefined
  return hit.split(';')[0]
}

/** Same as getWithCookie(), but asks for compressed content like a browser does. */
function getWithAccept(port, urlPath, acceptEncoding) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: port, path: urlPath, headers: { 'accept-encoding': acceptEncoding } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', reject)
  })
}

/** POST an application/x-www-form-urlencoded form, the way a login page does. */function postForm(port, urlPath, fields, cookie) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(fields).toString()
    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(data)
    }
    if (cookie) headers.cookie = cookie
    const req = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: 'POST', headers }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

function post(port, urlPath, payload, cookie) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    if (cookie) headers.cookie = cookie
    const req = http.request({ host: '127.0.0.1', port: port, path: urlPath, method: 'POST', headers }, (res) => {
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

test('gateway: injected inline scripts are valid JavaScript (quoting bug guard)', async () => {
  await withGateway(async ({ port }) => {
    const page = await get(port, '/')
    const scripts = extractInlineScripts(page.body)
    assert.ok(scripts.length > 0, 'expected inline scripts')
    for (const s of scripts) {
      assert.ok(balanced(s), 'inline script braces balanced: ' + s.slice(0, 40))
      // Braces alone are not enough — a stray quote still parses as balanced
      // but throws a SyntaxError in the browser, and then the whole bootstrap
      // never runs (no service worker, no push, no agent-done notification).
      // Compile without executing: that is what the browser does.
      assert.doesNotThrow(
        () => new Function(s),
        'inline script compiles: ' + JSON.stringify(s.slice(0, 120))
      )
    }
    assert.ok(page.body.includes('window.__DSH_PWA__'), 'bootstrap present')
    assert.ok(page.body.includes('randomUUID'), 'uuid polyfill present')
    // The bootstrap payload has to be a well-formed object literal.
    const m = page.body.match(/window\.__DSH_PWA__=(\{[^;]*\});/)
    assert.ok(m, 'bootstrap payload found')
    const payload = JSON.parse(m[1].replace(/([{,])([A-Za-z_$][\w$]*):/g, '$1"$2":'))
    assert.strictEqual(typeof payload.vapid, 'string', 'vapid is a string')
    assert.strictEqual(typeof payload.pushReady, 'boolean', 'pushReady is a boolean')
    assert.strictEqual(typeof payload.target, 'string', 'target is a string')
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

test('gateway: a closing tag inside the bootstrap cannot break the page', async () => {
  // The bootstrap is inlined into the document, so a "</script" inside it would
  // end the block early and turn the rest of the file into markup. The gateway
  // neutralises it; this pins that behaviour down.
  const pwaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pwa-fixture-'))
  fs.writeFileSync(
    path.join(pwaDir, 'inject.js'),
    'window.__FIXTURE__ = { close: "</script>", open: "<!--" };\n',
    'utf8'
  )
  await withGateway(async ({ port }) => {
    const page = await get(port, '/')
    const scripts = extractInlineScripts(page.body)
    assert.ok(scripts.length > 0, 'expected inline scripts')
    for (const s of scripts) {
      assert.ok(!/<\/script/i.test(s), 'no raw closing tag inside the script body')
      assert.ok(!/<!--/.test(s), 'no raw comment opener inside the script body')
      assert.doesNotThrow(
        () => new Function(s),
        'inline script still compiles: ' + JSON.stringify(s.slice(0, 120))
      )
    }
    // The escape has to be invisible to the JavaScript: the string values the
    // bootstrap sees must be exactly what the source file said.
    const fake = {}
    const boot = scripts.find((s) => s.includes('__DSH_PWA__'))
    new Function('window', boot)(fake)
    assert.strictEqual(fake.__FIXTURE__.close, '</script>', 'closing tag survives verbatim')
    assert.strictEqual(fake.__FIXTURE__.open, '<!--', 'comment opener survives verbatim')
  }, { LAN_GATE_PWA_DIR: pwaDir })
})

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

// ---- approval binds an address, a token binds a browser ---------------------

test('auth: an approval binds an address, a token binds a browser', () => {
  const auth = require('../lib/lan-gate-auth.cjs')
  const decisions = {}

  // Never approved.
  assert.strictEqual(auth.resolveRemote(decisions, '1.2.3.4', undefined, undefined).action, 'pending')

  // Denied.
  auth.denyDevice(decisions, '1.2.3.4')
  assert.strictEqual(auth.resolveRemote(decisions, '1.2.3.4', undefined, undefined).action, 'denied')

  // Approved.
  auth.approveDevice(decisions, '1.2.3.4', 'phone')
  const first = auth.resolveRemote(decisions, '1.2.3.4', undefined, undefined)
  assert.strictEqual(first.action, 'issue')
  assert.ok(first.token.length >= 16, 'a token is minted for the browser')

  // The gateway stores the minted token on the device.
  const grant = (token) => { decisions['1.2.3.4'].tokens = auth.tokenList(decisions['1.2.3.4']).concat([token]) }
  grant(first.token)

  // The browser that holds that token is let through.
  assert.strictEqual(auth.resolveRemote(decisions, '1.2.3.4', first.token, undefined).action, 'forward')

  // A second browser of the same address gets its own token instead of a wall.
  const second = auth.resolveRemote(decisions, '1.2.3.4', undefined, undefined)
  assert.strictEqual(second.action, 'issue')
  assert.notStrictEqual(second.token, first.token, 'each browser holds its own token')
  grant(second.token)
  assert.strictEqual(auth.resolveRemote(decisions, '1.2.3.4', second.token, undefined).action, 'forward')

  // A ticket that belongs to the device is accepted back.
  assert.strictEqual(auth.resolveRemote(decisions, '1.2.3.4', undefined, first.token).action, 'ticket')

  // A token from another device is not.
  assert.strictEqual(auth.resolveRemote(decisions, '1.2.3.4', 'f'.repeat(32), undefined).action, 'issue')
})

test('auth: a revoked device falls back to the approval wall', () => {
  const auth = require('../lib/lan-gate-auth.cjs')
  const decisions = {}
  auth.approveDevice(decisions, '1.2.3.4', 'phone')
  const token = auth.resolveRemote(decisions, '1.2.3.4', undefined, undefined).token
  auth.revokeDevice(decisions, '1.2.3.4')
  assert.strictEqual(auth.resolveRemote(decisions, '1.2.3.4', token, undefined).action, 'pending')
  assert.strictEqual(auth.tokenList(decisions['1.2.3.4']).length, 0, 'revoking drops the tokens')
})

test('auth: an approved device holds as many browsers as it needs', () => {
  const auth = require('../lib/lan-gate-auth.cjs')
  const decisions = {}
  auth.approveDevice(decisions, '1.2.3.4', 'phone')

  // The address is what was approved; the token only says which browser this
  // is. There is deliberately no cap, so nobody is ever locked out.
  const tokens = []
  for (let i = 0; i < 40; i++) {
    const verdict = auth.resolveRemote(decisions, '1.2.3.4', undefined, undefined)
    assert.strictEqual(verdict.action, 'issue', 'every new browser is let in')
    decisions['1.2.3.4'].tokens = verdict.tokens
    tokens.push(verdict.token)
  }
  assert.strictEqual(auth.tokenList(decisions['1.2.3.4']).length, 40, 'no browser was dropped')
  for (const token of tokens) {
    assert.strictEqual(auth.resolveRemote(decisions, '1.2.3.4', token, undefined).action, 'forward',
      'every browser stays signed in')
  }
})

test('auth: a state file written by the single-token gateway keeps the signed-in browser', () => {
  const auth = require('../lib/lan-gate-auth.cjs')
  const legacyToken = 'a'.repeat(32)
  const d = auth.normalizeDecision({ ip: '1.2.3.4', allow: true, token: legacyToken, issued: true })
  assert.deepStrictEqual(d.tokens, [legacyToken])
  assert.strictEqual(d.token, undefined, 'the single-token field is gone')
  assert.strictEqual(d.issued, undefined, 'the issued flag is gone')
  assert.strictEqual(auth.hasToken(d, legacyToken), true, 'the existing browser stays signed in')
})

test('auth: changing the device kind keeps the browsers signed in', () => {
  const auth = require('../lib/lan-gate-auth.cjs')
  const decisions = {}
  auth.approveDevice(decisions, '1.2.3.4', 'auto')
  const token = auth.resolveRemote(decisions, '1.2.3.4', undefined, undefined).token
  decisions['1.2.3.4'].tokens = [token]
  auth.approveDevice(decisions, '1.2.3.4', 'phone', true)
  assert.strictEqual(auth.hasToken(decisions['1.2.3.4'], token), true, 'the browser keeps its token')
  assert.strictEqual(decisions['1.2.3.4'].kind, 'phone', 'the kind is updated')
})

test('gateway: two browsers behind one address are both let in', async () => {
  // A phone and a laptop behind the same NAT share one public address. The
  // single-token gateway locked the second one out with "需要重新授权".
  const remote = '203.0.113.7'
  await withGateway(async ({ port }) => {
    const approved = await post(port, '/lan-gate/action', { action: 'approve', ip: remote, kind: 'phone' })
    assert.strictEqual(approved.status, 200)

    // Browser A shows up without a cookie.
    const a = await getWithCookie(port, '/', null)
    assert.strictEqual(a.status, 302, 'the browser is redirected to pick up its token')
    const cookieA = tokenCookie(a)
    assert.ok(cookieA, 'a token cookie is issued')
    assert.strictEqual(a.headers.location, '/', 'the redirect does not leak the token in the URL')

    // Browser A now has its token and reaches the app.
    const aPage = await getWithCookie(port, '/', cookieA)
    assert.strictEqual(aPage.status, 200, 'the signed-in browser reaches DSH')
    assert.ok(aPage.body.includes('data-lan-device'), 'the phone styling is injected')

    // Browser B, same address, no cookie: it must get its own token.
    const b = await getWithCookie(port, '/', null)
    assert.strictEqual(b.status, 302, 'the second browser is not locked out')
    const cookieB = tokenCookie(b)
    assert.ok(cookieB, 'the second browser gets a token too')
    assert.notStrictEqual(cookieB, cookieA, 'the two browsers hold different tokens')

    const bPage = await getWithCookie(port, '/', cookieB)
    assert.strictEqual(bPage.status, 200, 'the second browser reaches DSH as well')
    assert.ok(!bPage.body.includes('需要重新授权'), 'the lock-out wall is gone')
  }, { LAN_GATE_TEST_CLIENT_IP: remote })
})

test('gateway: an approved device can raise the agent-done push itself', async () => {
  const remote = '203.0.113.9'
  const seed = { [remote]: { ip: remote, allow: true, at: Date.now(), revoked: false, kind: 'phone', tokens: [] } }
  await withGateway(async ({ port }) => {
    const first = await getWithCookie(port, '/', null)
    assert.strictEqual(first.status, 302)
    const cookie = tokenCookie(first)
    assert.ok(cookie, 'the browser holds a token')

    const allowed = await post(port, '/pwa/push/send', { title: 'DSH 任务完成', body: '智能体已完成当前步骤。' }, cookie)
    assert.strictEqual(allowed.status, 200, 'the approved device may raise the notification')

    const refused = await post(port, '/pwa/push/send', { title: 'x', body: 'y' })
    assert.strictEqual(refused.status, 403, 'a caller without a token may not')
  }, { LAN_GATE_TEST_CLIENT_IP: remote, LAN_GATE_TEST_REMOTE: '1' }, seed)
})

// ---- optional password gate --------------------------------------------------

test('gateway: the password gate hides the app until the password is entered', async () => {
  await withGateway(async ({ port }) => {
    // No password entered: the page is the login form, not the DSH app.
    const locked = await get(port, '/')
    assert.strictEqual(locked.status, 200)
    assert.ok(locked.body.includes('需要密码'), 'the login page is shown')
    assert.ok(locked.body.includes('name="pw"'), 'the login form has a password field')
    assert.ok(!locked.body.includes('data-lan-device'), 'the DSH app is not served')
    assert.ok(!locked.body.includes('__DSH_PWA__'), 'the PWA bootstrap is not injected')

    // A wrong password is refused and grants nothing.
    const wrong = await postForm(port, '/lan-gate/login', { pw: 'not-it', next: '/' })
    assert.strictEqual(wrong.status, 200)
    assert.ok(wrong.body.includes('密码不正确'), 'the failure is reported')
    assert.ok(!(wrong.headers['set-cookie'] || []).some((c) => c.startsWith('lg_pass=')), 'no session cookie is issued')

    // The right password opens the gate.
    const ok = await postForm(port, '/lan-gate/login', { pw: 'test-pass', next: '/' })
    assert.strictEqual(ok.status, 302)
    assert.strictEqual(ok.headers.location, '/')
    const passCookie = (ok.headers['set-cookie'] || []).find((c) => c.startsWith('lg_pass='))
    assert.ok(passCookie, 'a session cookie is issued')
    assert.ok(passCookie.includes('HttpOnly'), 'the session cookie is not readable by scripts')
    assert.ok(!passCookie.includes('test-pass'), 'the password itself is never sent to the browser')

    // With the cookie, the app is reachable again.
    const page = await getWithCookie(port, '/', passCookie.split(';')[0])
    assert.strictEqual(page.status, 200)
    assert.ok(page.body.includes('__DSH_PWA__'), 'the PWA bootstrap is injected')
  }, { LAN_GATE_PASSWORD: 'test-pass' })
})

test('gateway: without a configured password there is no login page', async () => {
  await withGateway(async ({ port }) => {
    const page = await get(port, '/')
    assert.strictEqual(page.status, 200)
    assert.ok(!page.body.includes('需要密码'), 'the gateway is open when no password is set')
  })
})

test('gateway: the password gate covers the WebSocket relay too', async () => {
  await withGateway(async ({ port }) => {
    // The upgrade path must refuse a socket that carries no password cookie.
    const { status } = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: port, path: '/', headers: { connection: 'Upgrade', upgrade: 'websocket' } })
      req.on('upgrade', () => resolve({ status: 101 }))
      req.on('response', (res) => resolve({ status: res.statusCode }))
      req.on('error', reject)
      req.end()
    })
    // The gateway answers a non-local upgrade without the password with 403.
    assert.notStrictEqual(status, 101, 'the relay does not open without the password')
  }, { LAN_GATE_PASSWORD: 'test-pass' })
})

test('gateway: a compressed document is decoded before the markup is injected', async () => {
  // A browser always asks for compressed content. The upstream then answers
  // with gzip, and injecting text into those bytes produced a document the
  // browser could not parse — the blank page that never finished loading.
  const zlib = require('node:zlib')
  const target = http.createServer((req, res) => {
    const html = '<!doctype html><html lang="en"><head><title>DSH gzip</title></head>' +
      '<body><div id="root"></div></body></html>'
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
      const body = zlib.gzipSync(Buffer.from(html, 'utf8'))
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Encoding': 'gzip',
        'Content-Length': String(body.length)
      })
      res.end(body)
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(html)
  })
  const targetPort = await freePort()
  const gatewayPort = await freePort()
  await new Promise((r) => target.listen(targetPort, '127.0.0.1', r))
  const gw = startGateway(gatewayPort, targetPort)
  await gw.ready
  try {
    const page = await getWithAccept(gatewayPort, '/', 'gzip, deflate, br')
    assert.strictEqual(page.status, 200)
    assert.ok(page.body.startsWith('<!doctype html>'), 'the document arrives as readable text')
    assert.ok(page.body.includes('<div id="root">'), 'the upstream markup survived')
    assert.ok(page.body.includes('__DSH_PWA__'), 'the PWA bootstrap was injected')
    assert.strictEqual(page.headers['content-encoding'], undefined,
      'the response is no longer labelled as compressed')
    assert.strictEqual(Number(page.headers['content-length']), Buffer.byteLength(page.body),
      'the content length matches the body that was sent')
  } finally {
    gw.child.kill('SIGTERM')
    await new Promise((r) => target.close(r))
  }
})
