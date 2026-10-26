#!/usr/bin/env node
/* Upstream contract probe.
 *
 * The shell talks to DSH through two contracts: the slot vocabulary (the
 * surface its CSS addresses) and the typed-RPC endpoints (the surface it
 * reads data from). Both are published, and both change between upstream
 * releases. This probe checks them against a running DSH, so a break is
 * found by a script instead of by a silently broken phone layout.
 *
 * Usage:
 *   node scripts/check-upstream-contract.mjs --origin http://127.0.0.1:3080 \
 *        [--host <public authority>] [--token <launch token>] \
 *        [--password <gateway access password>] \
 *        [--slot-catalog <path to upstream slot-catalog.ts>]
 *
 * --origin is where DSH answers. --host is the authority DSH must trust and
 * the one its session cookie binds to. --token is the process launch token
 * from the DSH startup line; without it the probe can still read the HTML.
 * --password is the gateway's access password, when the probe runs against
 * the gateway rather than against DSH directly.
 *
 * --slot-catalog points at the upstream file that enumerates the slot
 * vocabulary (packages/extensions/cordis-client-runner/src/client/slot-catalog.ts
 * in the DSH source tree). The slot names are not published at runtime - the
 * runtime only lists the client *modules* - so this file is where a renamed
 * slot becomes visible.
 */
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const ORIGIN = arg('origin', 'http://127.0.0.1:3080')
const HOST = arg('host', '')
const TOKEN = arg('token', '')
const PASSWORD = arg('password', '')
const SLOT_CATALOG = arg('slot-catalog', '')

let failures = 0
const ok = (label, detail) => console.log(`  PASS  ${label}${detail ? '  ' + detail : ''}`)
const bad = (label, detail) => { failures++; console.log(`  FAIL  ${label}${detail ? '  ' + detail : ''}`) }

/* ---- the cookie jar ------------------------------------------------------ */

const cookieJar = new Map()

function takeCookie(res) {
  const setCookie = res.headers['set-cookie']
  if (!setCookie) return
  for (const raw of [].concat(setCookie)) {
    const pair = String(raw).split(';')[0]
    const at = pair.indexOf('=')
    if (at > 0) cookieJar.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
  }
}

const cookieHeader = () =>
  [...cookieJar].map(([name, value]) => name + '=' + value).join('; ')

/* ---- the http client ----------------------------------------------------- */

/* DSH 0.2 compares the received Host against its accepted authorities and
 * binds its session cookie to that authority, so the probe has to send the
 * authority DSH trusts. The WHATWG fetch forbids setting the Host header,
 * so the raw http client is used instead. */
function request(url, { method = 'GET', headers = {}, body = null, hops = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const out = { ...headers }
    if (cookieJar.size > 0) out.cookie = cookieHeader()
    if (body !== null && out['content-length'] === undefined) {
      out['content-length'] = Buffer.byteLength(body)
    }
    const req = http.request({
      hostname: target.hostname,
      port: target.port || 80,
      path: target.pathname + target.search,
      method,
      headers: out
    }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        takeCookie(res)
        // DSH's session bootstrap and the gateway's token exchange both answer
        // with a redirect, and the document is behind it.
        const location = res.headers.location
        if (location && res.statusCode >= 300 && res.statusCode < 400 && hops < 3) {
          const next = new URL(location, target).toString()
          res.resume()
          resolve(request(next, { method: 'GET', headers, body: null, hops: hops + 1 }))
          return
        }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8')
        })
      })
    })
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

/* ---- the contract we depend on ------------------------------------------- */

/* The slots the mobile stylesheet addresses. The stylesheet is the single
 * source of truth: whatever it selects has to keep existing upstream. */
function slotsFromStylesheet() {
  const css = readFileSync(join(ROOT, 'pwa', 'app.css'), 'utf8')
  const used = new Set()
  const re = /\[data-slot="([^"]+)"\]/g
  let m
  while ((m = re.exec(css)) !== null) used.add(m[1])
  return [...used].sort()
}

/* The client modules the shell needs mounted. A renamed or dropped module
 * takes a whole surface with it. */
const REQUIRED_CLIENT_MODULES = [
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-renderer',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-sidebar',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-client-ui-plugin-manager',
  '@deepseek-ai/dsh-client-ui-permission-presets',
  '@deepseek-ai/dsh-cordis-client-runner',
  '@deepseek-ai/dsh-api-gateway'
]

/* The typed-RPC calls the shell makes. */
const REQUIRED_RPC = [
  ['pluginManager', 'listPlugins', {}],
  ['permissionPresets', 'catalog', {}],
  ['session', 'list', { _request: {} }],
  ['session', 'projections', { request: { sessionId: 'probe' } }]
]

console.log(`upstream contract probe against ${ORIGIN}`)

const headers = {}
if (HOST) headers.host = HOST

/* ---- 1. the document and the client modules it mounts -------------------- */
let html = ''
try {
  // The gateway puts a password page in front of everything, so that gate
  // comes first: without it the token exchange is answered with the login
  // page instead of a session cookie.
  if (PASSWORD) {
    const gate = await request(ORIGIN + '/', { headers })
    if (/name="pw"/.test(gate.body)) {
      await request(ORIGIN + '/lan-gate/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'pw=' + encodeURIComponent(PASSWORD) + '&next=/'
      })
      ok('password gate', 'accepted')
    }
  }

  const res = await request(ORIGIN + (TOKEN ? '/?token=' + encodeURIComponent(TOKEN) : '/'), { headers })
  html = res.body
  if (!html || html.length < 512) {
    const again = await request(ORIGIN + '/', { headers })
    html = again.body
  }
  ok('document', `${html.length} bytes` + (cookieJar.size ? ' (session cookie kept)' : ' (no session cookie)'))
} catch (error) {
  bad('document', String(error && error.message))
}

const mounted = new Set()
{
  const re = /"id"\s*:\s*"([^"]+)"/g
  let m
  while ((m = re.exec(html)) !== null) mounted.add(m[1])
}

console.log('')
console.log('client modules:')
if (mounted.size === 0) {
  console.log('  (the boot registry was not readable; skipping the module check)')
} else {
  for (const id of REQUIRED_CLIENT_MODULES) {
    if (mounted.has(id)) ok(id)
    else bad(id, 'not mounted by this DSH build')
  }
}

/* ---- 2. the slot vocabulary --------------------------------------------- */
const requiredSlots = slotsFromStylesheet()
console.log('')
console.log(`slot vocabulary (${requiredSlots.length} used by pwa/app.css):`)
if (!SLOT_CATALOG) {
  console.log('  (no --slot-catalog given; the slot names are not published at runtime)')
  console.log('  point it at upstream packages/extensions/cordis-client-runner/src/client/slot-catalog.ts')
} else if (!existsSync(SLOT_CATALOG)) {
  bad('slot catalog', 'file not found: ' + SLOT_CATALOG)
} else {
  const catalog = readFileSync(SLOT_CATALOG, 'utf8')
  const published = new Set()
  const re = /key:\s*'([^']+)'/g
  let m
  while ((m = re.exec(catalog)) !== null) published.add(m[1])
  ok('slot catalog', `${published.size} slots published by this upstream build`)
  for (const slot of requiredSlots) {
    if (published.has(slot)) ok(slot)
    else bad(slot, 'this upstream build no longer publishes it')
  }
}

/* ---- 3. the typed-RPC surface -------------------------------------------- */
console.log('')
console.log('typed-RPC endpoints:')
for (const [ns, method, args] of REQUIRED_RPC) {
  try {
    const payload = JSON.stringify({
      type: 'client-request',
      rpcId: 'contract-' + method,
      method: ns + '/' + method,
      payload: { args }
    })
    const res = await request(`${ORIGIN}/api/${ns}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload
    })
    let body = null
    try { body = JSON.parse(res.body) } catch { /* not json */ }
    const answered = body && body.result && body.result.ok === true
    if (res.status === 200 && answered) ok(`${ns}/${method}`, '200 ok')
    else bad(`${ns}/${method}`, `status=${res.status} body=${String(res.body).slice(0, 200)}`)
  } catch (error) {
    bad(`${ns}/${method}`, String(error && error.message))
  }
}

/* ---- 4. the repo-side coupling guard ------------------------------------ */
console.log('')
console.log('repository agreement:')
try {
  const files = ['pwa/app.css', 'pwa/inject.js', 'pwa/muse-shell.js', 'pwa/touch-gestures.js']
  const offenders = []
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8')
    const found = (text.match(/\.[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_-]{4,}/g) || [])
    for (const hit of found) if (!hit.startsWith('.dsh-')) offenders.push(file + ' ' + hit)
  }
  if (offenders.length === 0) ok('no upstream-private class names in the shell')
  else bad('upstream-private class names', offenders.join(', '))
} catch (error) {
  bad('repository', String(error && error.message))
}

console.log('')
console.log(failures === 0 ? 'contract intact' : `${failures} contract break(s)`)
process.exit(failures === 0 ? 0 : 1)
