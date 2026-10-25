/* dsh-mobile-pwa · lib/lan-gate-server.cjs
 *
 * Enhanced LAN/remote gateway for DeepSeek Harness. Derived from
 * `dsh-mobile-gate` (MIT, Bernardxu123) with PWA support added:
 *   - serves /pwa/* assets (manifest, service worker, css, fonts, offline)
 *   - injects PWA bootstrap (manifest link + SW registration + gesture loader)
 *     into served DSH HTML on phone devices
 *   - agent-done push notifications (subscribe endpoint + send endpoint)
 *
 * Kept single-file, zero-dependency CommonJS, isolated as a child process.
 * The DSH main webserver stays untouched on 127.0.0.1.
 *
 * Original gateway features preserved: first-visit approval, one-token-per-
 * browser, per-IP rate limiting, LAN/loopback bypass, WebSocket relay, admin
 * page, port fallback on EADDRINUSE, SIGTERM/SIGINT cleanup.
 */

const os = require('node:os')
const crypto = require('node:crypto')
const http = require('node:http')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')

var PROXY_PORT = Number(process.env.LAN_GATE_PORT || 3088)
const LISTEN_HOST = process.env.LAN_GATE_HOST || '0.0.0.0'
const RATE_LIMIT_PER_MIN = Number(process.env.LAN_GATE_RATE_LIMIT || 120)
// DSH 0.2 refuses a wildcard bind address, so the Web UI always listens on one
// concrete local address. The plugin resolves it from the `webStartup` service
// and hands it over here; the defaults keep standalone runs working.
const TARGET_HOST = process.env.LAN_GATE_TARGET_HOST || '127.0.0.1'
const TARGET_PORT = Number(process.env.LAN_GATE_TARGET_PORT || 3080)

// ---- PWA: where our static assets live (same dir layout as this package) ---
// This file is <pkg>/lib/lan-gate-server.cjs, so the package root is two levels up
// and the pwa dir is <pkg>/pwa.
const PKG_ROOT = path.dirname(__dirname)
const PWA_DIR = path.join(PKG_ROOT, 'pwa')

// ---- state persistence (unchanged from base) -------------------------------
function dshHome() { return process.env.DSH_HOME || path.join(os.homedir(), '.dsh') }
function stateFile() { return path.join(dshHome(), 'lan-gate-state.json') }
function loadDecisions() { try { var raw = JSON.parse(fs.readFileSync(stateFile(), 'utf8')); if (raw && typeof raw === 'object' && raw.decisions && typeof raw.decisions === 'object') return raw.decisions } catch (e) {} return {} }
function saveDecisions(decisions) { try { fs.mkdirSync(dshHome(), { recursive: true }); var tmp = stateFile() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ decisions: decisions }, null, 2), 'utf8'); fs.renameSync(tmp, stateFile()) } catch (e) {} }

// ---- device / network helpers (unchanged) ---------------------------------
function lanIps() { var r = [], f = os.networkInterfaces(); for (var k in f) { for (var i = 0; i < (f[k] || []).length; i++) { var it = f[k][i]; if (it && it.family === 'IPv4' && !it.internal) r.push(it.address) } } return r }
function normalizeIp(raw) { return String(raw || '').replace(/^::ffff:/, '') }
function isLoopbackIp(ip) { return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' }
function deviceKind(decisions, ip) { var d = decisions[ip]; if (!d || d.allow !== true || d.revoked === true) return undefined; return d.kind === 'phone' || d.kind === 'desktop' ? d.kind : undefined }
function randomToken() { return crypto.randomBytes(16).toString('hex') }
function parseCookies(req) { var out = {}, h = req.headers.cookie; if (typeof h !== 'string' || h === '') return out; var parts = h.split(';'); for (var i = 0; i < parts.length; i++) { var idx = parts[i].indexOf('='); if (idx < 0) continue; var key = parts[i].slice(0, idx).trim(), value = parts[i].slice(idx + 1).trim(); if (key !== '') out[key] = value } return out }
function queryTicket(url) { var q = String(url || '').indexOf('?'); if (q < 0) return undefined; var m = url.slice(q + 1).match(/(?:^|&)t=([^&]*)/); return m ? decodeURIComponent(m[1]) : undefined }
function setTokenCookie(res, token, secure) { var flags = 'Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : ''); res.setHeader('Set-Cookie', 'lg_token=' + token + '; ' + flags) }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;') }

// ---- state ------------------------------------------------------------------
var decisions = loadDecisions()
var seen = {}
var rateMap = new Map()
var pushSubscriptions = new Map() // id -> {endpoint, keys:{p256dh,auth}}

// ---- Web Push credentials ----------------------------------------------------
// The push service needs a VAPID keypair. It is taken from the environment when
// the operator supplies one, otherwise a pair is generated once and persisted
// under DSH_HOME so subscriptions survive a restart.
var VAPID = { publicKey: process.env.LAN_GATE_VAPID_PUBLICKEY || '', privateKey: process.env.LAN_GATE_VAPID_PRIVATEKEY || '' }
var VAPID_SUBJECT = process.env.LAN_GATE_VAPID_SUBJECT || 'mailto:dsh-mobile-pwa@localhost'

function vapidReady() { return !!(VAPID.publicKey && VAPID.privateKey) }

function initVapid() {
  if (vapidReady()) return
  try {
    var webPush = require('./web-push.cjs')
    webPush.loadOrCreateVapidKeys(path.join(dshHome(), 'lan-gate-vapid.json')).then(function (keys) {
      VAPID = keys
      console.log('[lan-gate] vapid keypair ready (' + (keys.publicKey.slice(0, 12) + '...)'))
    }).catch(function (err) {
      console.error('[lan-gate] vapid init failed: ' + String(err && err.message || err))
    })
  } catch (err) {
    console.error('[lan-gate] vapid module unavailable: ' + String(err && err.message || err))
  }
}

// ---- PWA asset serving -------------------------------------------------------
const PWA_FILE_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf'
}
function servePwaAsset(req, res) {
  const p = String(req.url || '').split('?')[0]
  // Only serve whitelisted files under /pwa/
  if (p.indexOf('/pwa/') !== 0) return false
  const rel = p.slice('/pwa/'.length)
  // Prevent path traversal
  if (rel.indexOf('..') !== -1 || rel.indexOf('\0') !== -1) return false
  const abs = path.normalize(path.join(PWA_DIR, rel))
  if (abs.indexOf(path.normalize(PWA_DIR)) !== 0) return false
  let body
  try { body = fs.readFileSync(abs) } catch (e) { return false }
  const ext = path.extname(abs).toLowerCase()
  res.writeHead(200, { 'Content-Type': PWA_FILE_TYPES[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' })
  res.end(body)
  return true
}

// ---- HTML injection (extended for PWA) ----------------------------------------
const UUID_POLYFILL = 'if(!window.crypto||!window.crypto.randomUUID){window.crypto.randomUUID=function(){' +
  'var b=new Uint8Array(16);window.crypto.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;' +
  'var h="";for(var i=0;i<16;i++){if(i===4||i===6||i===8||i===10)h+="-";var v=b[i].toString(16);h+=(v.length===1?"0":"")+v}' +
  'return h}}'

function injectDeviceAttr(html, kind) { if (!kind) return html; var m = html.match(/<html[^>]*/i); if (!m) return html; return html.slice(0, m.index) + m[0] + ' data-lan-device="' + kind + '"' + html.slice(m.index + m[0].length) }

// Load the mobile CSS and PWA bootstrap script from disk (files kept in /pwa).
function readPwaText(name) { try { return fs.readFileSync(path.join(PWA_DIR, name), 'utf8') } catch (e) { return '' } }
const APP_CSS = readPwaText('app.css')
const INJECT_JS = readPwaText('inject.js')

const DEVICE_CSS = '<style>html[data-lan-device="phone"]{--dsw-pwa-font-scale:1}html[data-lan-device="phone"] [data-slot="main.conversation"],html[data-lan-device="phone"] [data-slot="conversation.view"],html[data-lan-device="phone"] [data-slot="conversation.chat.flow"],html[data-lan-device="phone"] [data-phase]{--dsw-font-s-14-font-size:12.5px;--dsw-font-xs-13-font-size:11.5px;--dsw-font-xxs-12-font-size:11px;--dsw-font-xxxs-11-font-size:10px;--dsw-font-markdown-base-font-size:14px;--dsw-font-markdown-base-strong-font-size:14px;--dsw-font-markdown-base-italic-font-size:14px;--dsw-font-markdown-small-font-size:13px;--dsw-font-markdown-code-font-size:12.5px;--dsw-font-markdown-code-block-font-size:12px;--dsw-font-markdown-h1-font-size:18px;--dsw-font-markdown-h2-font-size:16px;--dsw-font-markdown-h3-font-size:15px;--dsw-font-markdown-h4-font-size:14px}html[data-lan-device="phone"] input,html[data-lan-device="phone"] textarea,html[data-lan-device="phone"] [contenteditable="true"]{font-size:16px!important}html[data-lan-device="phone"] [data-slot="conversation.view"] button,html[data-lan-device="phone"] [data-slot="conversation.input.dock"] button,html[data-lan-device="phone"] [data-slot="sidebar"] button,html[data-lan-device="phone"] [data-slot="rightbar"] button{min-height:44px;touch-action:manipulation}html[data-lan-device="phone"] [role="dialog"][aria-modal="true"]{display:flex;flex-direction:column;width:100vw;height:100dvh;max-width:100vw;max-height:100dvh;border-radius:0}</style>'
// The VAPID keypair is generated asynchronously at startup, so the bootstrap
// payload is built per request instead of once at module load.
function pwaBoot() {
  return '<script>window.__DSH_PWA__={vapid:"' + esc(VAPID.publicKey || '') +
    '",pushReady:' + (vapidReady() ? 'true' : 'false') +
    '",target:"' + esc(TARGET_HOST + ':' + TARGET_PORT) + '"};' + INJECT_JS + '</script>'
}
const MANIFEST_LINK = '<link rel="manifest" href="/pwa/manifest.json">'
const THEME_META = '<meta name="theme-color" content="#0f1115">'
const APPLE_META = '<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black-translucent"><meta name="apple-mobile-web-app-title" content="DSH">'
const APPLE_TOUCH = '<link rel="apple-touch-icon" href="/pwa/icons/icon-192.png">'

function injectHtml(html, kind) {
  html = injectDeviceAttr(html, kind)
  const headOpen = html.search(/<head[^>]*>/i)
  if (headOpen < 0) return html
  const headClose = html.search(/<\/head>/i)
  const headInsert = html.indexOf('>', headOpen) + 1
  const headTail = headClose > headInsert ? headClose : html.length
  const inject = '<script>' + UUID_POLYFILL + '</script>' +
    MANIFEST_LINK + THEME_META + APPLE_META + APPLE_TOUCH +
    DEVICE_CSS + '<link rel="stylesheet" href="/pwa/app.css">' +
    pwaBoot()
  // insert head bit before </head>
  return html.slice(0, headTail) + inject + html.slice(headTail)
}

// ---- agent-done push --------------------------------------------------------
// The gateway stores WebPush subscriptions and pushes a real encrypted
// notification (RFC 8291 aes128gcm body + RFC 8292 VAPID authorisation).
// A push service rejects an unencrypted body, so the payload is sealed to the
// subscriber's p256dh key before it leaves the box.
async function pushOne(sub, notification) {
  var webPush = require('./web-push.cjs')
  var sealed = await webPush.encryptPayload(sub, notification)
  var authorization = await webPush.buildVapidAuthorization(
    sub.endpoint, VAPID_SUBJECT, VAPID.publicKey, VAPID.privateKey)
  var headers = {}
  for (var k in sealed.headers) headers[k] = sealed.headers[k]
  headers['Authorization'] = authorization
  headers['TTL'] = '3600'
  headers['Urgency'] = 'normal'
  return await new Promise(function (resolve) {
    var req = http.request(sub.endpoint, { method: 'POST', headers: headers }, function (res) {
      res.resume()
      var ok = res.statusCode >= 200 && res.statusCode < 300
      res.on('end', function () { resolve(ok) })
      res.on('error', function () { resolve(false) })
    })
    req.on('error', function () { resolve(false) })
    req.write(sealed.body)
    req.end()
  })
}

function sendPush(notification, cb) {
  if (!pushSubscriptions.size) { if (cb) cb(new Error('no subscriptions')); return }
  if (!vapidReady()) { if (cb) cb(new Error('vapid not ready')); return }
  var sent = 0, failed = 0
  var pending = pushSubscriptions.size
  var settle = function () {
    pending--
    if (pending <= 0 && cb) cb(null, { sent: sent, failed: failed })
  }
  pushSubscriptions.forEach(function (sub) {
    if (!sub.endpoint) { failed++; settle(); return }
    pushOne(sub, notification).then(function (ok) {
      if (ok) sent++; else failed++
      settle()
    }).catch(function () { failed++; settle() })
  })
}

// ---- request handlers (base preserved) ----------------------------------------
// DSH 0.2 compares the received Host against its accepted authorities (the
// Host/Origin fence) and binds the browser session cookie to that authority.
// A proxy must therefore forward the browser-facing Host unchanged. Rewriting
// it to the listener address is only kept as an opt-in for older deployments.
var REWRITE_HOST = process.env.LAN_GATE_REWRITE_HOST === '1'
// The launch token of the running DSH process, when the plugin could read it.
var DSH_TOKEN = process.env.LAN_GATE_DSH_TOKEN || ''

function cleanHeaders(headers, clientIp) {
  var drop = { connection: 1, 'proxy-connection': 1, 'keep-alive': 1, te: 1, trailer: 1, 'transfer-encoding': 1, upgrade: 1, 'proxy-authorization': 1, 'proxy-authenticate': 1 }
  var out = {}
  for (var k in headers) {
    var lower = String(k).toLowerCase()
    // The browser-facing Host decides DSH's trust fence and the authority the
    // session cookie is bound to, so it is forwarded unchanged by default.
    if (lower === 'host') { if (!REWRITE_HOST) out[k] = headers[k]; continue }
    if (drop[lower]) continue
    out[k] = headers[k]
  }
  if (REWRITE_HOST) out['host'] = TARGET_HOST + ':' + TARGET_PORT
  out['x-forwarded-for'] = clientIp
  return out
}

// DSH names its browser-session cookie "dsh-auth-<hash>"; the gateway only
// needs to know whether one is present.
function hasDshSessionCookie(req) {
  var cookies = parseCookies(req)
  for (var name in cookies) { if (name.indexOf('dsh-auth-') === 0) return true }
  return false
}

/**
 * Exchange DSH's launch token for the browser session cookie on the browser's
 * behalf, so the user never has to open a tokenized URL.
 *
 * DSH answers `GET /?token=<launch token>` with 303 and a signed session cookie
 * bound to the request's Host authority. Preserving the browser-facing Host
 * here means the cookie is minted for the public authority the browser uses.
 */
function bootstrapDshSession(req, res, clientIp) {
  if (!DSH_TOKEN) return false
  var headers = { host: req.headers.host || (LISTEN_HOST + ':' + PROXY_PORT) }
  var upstream = http.request({ host: TARGET_HOST, port: TARGET_PORT, method: 'GET', path: '/?token=' + encodeURIComponent(DSH_TOKEN), headers: headers }, function (upRes) {
    upRes.resume()
    var outHeaders = { 'Cache-Control': 'no-store' }
    var setCookie = upRes.headers['set-cookie']
    if (setCookie) outHeaders['Set-Cookie'] = setCookie
    outHeaders['Location'] = upRes.headers['location'] || './'
    try { res.writeHead(upRes.statusCode || 303, outHeaders); res.end('') } catch (e) { /* ignore */ }
  })
  upstream.on('error', function () {
    try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad Gateway') } catch (e) {}
  })
  upstream.end()
  return true
}
function gatePage(title, body) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0f1115"><title>' + title + '</title><style>*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}html,body{margin:0;padding:0}body{min-height:100dvh;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:radial-gradient(1100px 700px at 50% -10%,#1b2233 0%,#0f1115 55%);color:#e6e8ec;padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));-webkit-text-size-adjust:100%;text-size-adjust:100%}.card{width:100%;max-width:460px;margin:0 auto;padding:38px 26px 30px;border:1px solid #2a2f3a;border-radius:20px;background:#161a22;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,.45)}.logo{width:56px;height:56px;margin:0 auto 18px;border-radius:16px;background:linear-gradient(135deg,#4c8dff,#7a5cff);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700;color:#fff}h1{font-size:21px;margin:0 0 6px}.sub{font-size:14px;color:#9aa3b2;margin:0 0 16px}.ip{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:15px;color:#8fa3c8;background:#0b0e14;border:1px solid #232a37;border-radius:10px;padding:10px 16px;display:inline-block;margin:10px 0 4px;word-break:break-all}.spinner{width:38px;height:38px;margin:20px auto;border-radius:50%;border:3px solid #2a2f3a;border-top-color:#4c8dff;animation:spin .9s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}p{font-size:14px;line-height:1.8;color:#9aa3b2;margin:8px 0}.btn{display:inline-block;margin-top:18px;padding:11px 30px;font-size:15px;font-weight:600;border:1px solid #4c8dff;color:#9cc0ff;background:rgba(76,141,255,.08);border-radius:12px;cursor:pointer;text-decoration:none;touch-action:manipulation;user-select:none}.btn:active{background:rgba(76,141,255,.22)}.bad{color:#f0716f}</style></head><body><div class="card">' + body + '</div></body></html>'
}
function pendingPage(ip, ua) { return gatePage('等待本机批准 · DSH 移动访问', '<div class="logo">DSH</div><h1>正在等待本机批准</h1><p class="sub">首次访问需要电脑端确认</p><div class="spinner"></div><p>设备</p><span class="ip">' + ip + '</span><p>请在电脑浏览器打开<br><span class="ip">http://127.0.0.1:' + PROXY_PORT + '/lan-gate/admin</span><br>批准此设备并选择「手机」</p><a class="btn" href="javascript:location.reload()">立即检查</a><script>setTimeout(function(){location.reload()},2500)</script>') }
function deniedPage(ip) { return gatePage('访问被拒绝 · DSH 移动访问', '<div class="logo">DSH</div><h1>访问被拒绝</h1><p class="sub">本机未批准此设备</p><p class="bad">设备 ' + ip + ' 未被允许访问本机的 DSH。</p><a class="btn" href="javascript:location.reload()">重新检查</a>') }
function boundPage(ip) { return gatePage('需要重新授权 · DSH 移动访问', '<div class="logo">DSH</div><h1>此设备的访问令牌已绑定到其他浏览器</h1><p class="sub">一次批准只绑定一个浏览器</p><p class="bad">设备 ' + ip + ' 的令牌已发放给其他浏览器。</p><p>如需在本浏览器使用，请在本机管理页中撤销该设备后重新批准。</p>') }
function rateLimitPage(ip) { return gatePage('请求过于频繁 · DSH 移动访问', '<div class="logo">DSH</div><h1>请求过于频繁</h1><p class="bad">设备 ' + ip + ' 的请求频率超过了每分钟 ' + RATE_LIMIT_PER_MIN + ' 次的限制。</p><p>请稍等一分钟后再试。</p><a class="btn" href="javascript:location.reload()">重新加载</a>') }
function json(res, code, value) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)) }
function isLocalSocket(req) { var ip = normalizeIp(req.socket.remoteAddress); return isLoopbackIp(ip) || lanIps().indexOf(ip) >= 0 }

function adminPage() {
  var urls = lanIps().map(function (ip) { return 'http://' + ip + ':' + PROXY_PORT })
  var list = urls.map(function (u) { return '<div class="url" data-copy="' + u + '">' + esc(u) + '</div>' }).join('')
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0f1115"><title>内网访问网关 · 管理</title><style>*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}html,body{margin:0;padding:0}body{min-height:100dvh;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:radial-gradient(1100px 700px at 50% -10%,#1b2233 0%,#0f1115 55%);color:#e6e8ec;padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(30px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));-webkit-text-size-adjust:100%;text-size-adjust:100%}.card{width:100%;max-width:560px;margin:0 auto;padding:28px 24px 24px;border:1px solid #2a2f3a;border-radius:20px;background:#161a22;box-shadow:0 20px 60px rgba(0,0,0,.45)}.head{display:flex;align-items:center;gap:12px;margin-bottom:18px}.logo{width:44px;height:44px;flex:none;border-radius:13px;background:linear-gradient(135deg,#4c8dff,#7a5cff);display:flex;align-items:center;justify-content:center;font-size:19px;font-weight:700;color:#fff}h1{font-size:19px;margin:0}.sub{font-size:13px;color:#9aa3b2;margin:2px 0 0}.badge{display:inline-flex;align-items:center;gap:6px;font-size:12px;border-radius:999px;padding:3px 10px;border:1px solid #2a2f3a;color:#9aa3b2;margin:0 0 14px}.badge b{width:8px;height:8px;border-radius:50%;background:#34d399;box-shadow:0 0 8px #34d399}.url{font-family:ui-monospace,Consolas,monospace;font-size:14px;color:#9cc0ff;background:#0b0e14;border:1px solid #232a37;border-radius:10px;padding:10px 14px;margin:6px 0;word-break:break-all;cursor:pointer}.label{font-size:13px;font-weight:600;margin:18px 0 8px;color:#e6e8ec}.item{padding:10px 0;border-bottom:1px solid #232a37}.item:last-child{border-bottom:none}.ip{font-family:ui-monospace,Consolas,monospace;font-size:14px;color:#8fa3c8}.muted{font-size:12px;color:#9aa3b2;margin:3px 0;word-break:break-all}.row{display:flex;align-items:center;gap:8px;margin-top:8px;flex-wrap:wrap}.btn{font-size:13px;border:1px solid #2f3748;background:transparent;color:#e6e8ec;border-radius:9px;padding:7px 14px;cursor:pointer;touch-action:manipulation}.btn:active{background:#222838}.btn-primary{border-color:#4c8dff;color:#9cc0ff;background:rgba(76,141,255,.08)}.btn-danger{border-color:#f0716f;color:#f0716f}.kind{font-size:12px;border:1px solid #2f3748;background:transparent;color:#9aa3b2;border-radius:999px;padding:5px 12px;cursor:pointer;touch-action:manipulation}.kind.on{border-color:#4c8dff;color:#9cc0ff;background:rgba(76,141,255,.08)}.empty{font-size:13px;color:#9aa3b2;text-align:center;padding:12px 0}.note{font-size:12px;color:#6b7280;line-height:1.7;margin:16px 0 0}.err{color:#f0716f;font-size:13px}</style></head><body><div class="card"><div class="head"><div class="logo">DSH</div><div><h1>内网访问网关</h1><p class="sub">管理允许访问本机 DSH 的设备 · PWA 已启用</p></div></div><span class="badge"><b></b>运行中 · 端口 ' + PROXY_PORT + '</span><div class="label">手机访问地址（点击复制）</div>' + list + '<div class="label">待批准设备</div><div id="pending" class="empty">加载中…</div><div class="label">已批准设备</div><div id="approved" class="empty">加载中…</div><div class="label">已拒绝设备</div><div id="denied" class="empty">加载中…</div><div class="row" style="margin-top:14px"><button class="btn btn-danger" data-act="revoke-all">全部撤销</button></div><p class="note">手机首次访问会出现在「待批准」中。首选访问方式选择「手机」，可自动注入 PWA（可安装到主屏、离线、任务完成通知）。网关监听 0.0.0.0:' + PROXY_PORT + '，仅放行已批准设备到 DSH。</p><div id="err"></div></div><script>' + 'var KIND={auto:"自动",phone:"手机",desktop:"电脑"};var pendingKinds={};function post(action,ip,kind){fetch("/lan-gate/action",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({action:action,ip:ip||null,kind:kind||null})}).then(function(){refresh()}).catch(function(){})}function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;")}function kindBtns(cur,act,ip){var h="";var ks=["auto","phone","desktop"];for(var i=0;i<ks.length;i++){var k=ks[i];h+="<button class=\"kind"+(cur===k?" on":"")+"\" data-act=\""+act+"\" data-kind=\""+k+"\" data-ip=\""+ip+"\">"+KIND[k]+"</button>"}return h}function fmt(ms){return ms?new Date(ms).toLocaleString():""}function render(s){var pe=s.pending||[],ap=s.approved||[],de=s.denied||[];var h="";if(!pe.length){h+="<div class=\"empty\">暂无设备等待批准</div>"}for(var i=0;i<pe.length;i++){var p=pe[i];var cur=pendingKinds[p.ip]||"auto";h+="<div class=\"item\"><div class=\"ip\">"+esc(p.ip)+"</div><div class=\"muted\">"+esc(p.ua||"")+"</div><div class=\"row\">"+kindBtns(cur,"kind",p.ip)+"</div><div class=\"row\"><button class=\"btn btn-primary\" data-act=\"approve\" data-ip=\""+esc(p.ip)+"\">允许</button><button class=\"btn btn-danger\" data-act=\"deny\" data-ip=\""+esc(p.ip)+"\">拒绝</button></div></div>"}document.getElementById("pending").innerHTML=h;var h2="";if(!ap.length){h2+="<div class=\"empty\">暂无已批准设备</div>"}for(var j=0;j<ap.length;j++){var d=ap[j];var dk=d.kind||"auto";h2+="<div class=\"item\"><div class=\"ip\">"+esc(d.ip)+" · "+(KIND[dk]||"自动")+"</div><div class=\"muted\">批准于 "+fmt(d.at)+"</div><div class=\"row\">"+kindBtns(dk,"set-kind",d.ip)+"<button class=\"btn btn-danger\" data-act=\"revoke\" data-ip=\""+esc(d.ip)+"\">撤销</button></div></div>"}document.getElementById("approved").innerHTML=h2;var h3="";if(!de.length){h3+="<div class=\"empty\">暂无已拒绝设备</div>"}for(var b=0;b<de.length;b++){var dn=de[b];h3+="<div class=\"item\"><div class=\"ip\">"+esc(dn.ip)+"</div><div class=\"row\"><button class=\"btn btn-primary\" data-act=\"approve\" data-ip=\""+esc(dn.ip)+"\">重新允许</button></div></div>"}document.getElementById("denied").innerHTML=h3}function refresh(){fetch("/lan-gate/status").then(function(r){return r.json()}).then(render).catch(function(){var e=document.getElementById("err");if(e)e.innerHTML="<div class=\"err\">无法读取状态</div>"})}document.addEventListener("click",function(ev){var el=ev.target;if(!el||!el.getAttribute)return;var copy=el.getAttribute("data-copy");if(copy){try{if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(copy)}catch(e){}return}var act=el.getAttribute("data-act");if(!act)return;var ip=el.getAttribute("data-ip");var kind=el.getAttribute("data-kind");if(act==="kind"){pendingKinds[ip]=kind;refresh();return}if(act==="approve"){post("approve",ip,pendingKinds[ip]||"auto");return}if(act==="deny"){post("deny",ip);return}if(act==="set-kind"){post("set-kind",ip,kind);return}if(act==="revoke"){post("revoke",ip);return}if(act==="revoke-all"){post("revoke-all");return}});refresh();setInterval(refresh,3000);' + '</script></body></html>'
}

function statusHandler(req, res) {
  var pending = [], approved = [], denied = []
  for (var ip in decisions) { var d = decisions[ip]; if (d.revoked === true) continue; if (d.allow === true) approved.push({ ip: ip, at: d.at, kind: d.kind || 'auto' }); else if (d.allow === false) denied.push({ ip: ip, at: d.at }) }
  for (var ip2 in seen) { var d2 = decisions[ip2]; if (d2 && d2.revoked !== true) continue; pending.push({ ip: ip2, firstSeen: seen[ip2].firstSeen, ua: seen[ip2].ua }) }
  json(res, 200, { state: 'running', port: PROXY_PORT, target: TARGET_HOST + ':' + TARGET_PORT, targetHost: TARGET_HOST, targetPort: TARGET_PORT, pwa: true, vapid: vapidReady(), pushSubscriptions: pushSubscriptions.size, urls: lanIps().map(function (ip) { return 'http://' + ip + ':' + PROXY_PORT }), pending: pending, approved: approved, denied: denied })
}
function actionHandler(req, res) {
  if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'post-only' }); return }
  var chunks = [], size = 0
  req.on('data', function (chunk) { if (size < 16384) { size += chunk.length; chunks.push(chunk) } })
  req.on('end', function () {
    var body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch (e) { json(res, 400, { ok: false }); return }
    var action = String(body.action || ''), ip = String(body.ip || ''), kind = String(body.kind || '')
    if (action === 'approve') decide(ip, true, kind)
    else if (action === 'deny') decide(ip, false, 'auto')
    else if (action === 'set-kind') { if (decisions[ip] && decisions[ip].allow === true && decisions[ip].revoked !== true) decide(ip, true, kind) }
    else if (action === 'revoke') revokeIp(ip)
    else if (action === 'revoke-all') { for (var k in decisions) revokeIp(k) }
    else { json(res, 400, { ok: false }); return }
    json(res, 200, { ok: true })
  })
}
function decide(ip, allow, kind) { var prev = decisions[ip]; var nextKind = kind === 'phone' || kind === 'desktop' ? kind : (prev && (prev.kind === 'phone' || prev.kind === 'desktop') ? prev.kind : 'auto'); decisions[ip] = { ip: ip, allow: allow, at: Date.now(), revoked: false, kind: nextKind, token: randomToken(), issued: false }; save() }
function revokeIp(ip) { var prev = decisions[ip]; decisions[ip] = { ip: ip, allow: prev ? prev.allow === true : true, at: Date.now(), revoked: true, kind: prev && prev.kind ? prev.kind : 'auto' }; save() }
function save() { saveDecisions(decisions) }
function overRate(ip) { var now = Date.now(), rate = rateMap.get(ip); if (!rate || now - rate.started >= 60000) { rate = { started: now, count: 0 }; rateMap.set(ip, rate) } rate.count += 1; return rate.count > RATE_LIMIT_PER_MIN }

function pushSubscribeHandler(req, res) {
  if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'post-only' }); return }
  var chunks = [], size = 0
  req.on('data', function (chunk) { if (size < 32768) { size += chunk.length; chunks.push(chunk) } })
  req.on('end', function () {
    var body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch (e) { json(res, 400, { ok: false }); return }
    var sub = body.subscription
    if (!sub || !sub.endpoint) { json(res, 400, { ok: false, reason: 'bad-subscription' }); return }
    // A push endpoint must be https, and the subscriber's key material is
    // mandatory: without p256dh/auth the body cannot be encrypted for it.
    if (!/^https:\/\//i.test(String(sub.endpoint))) { json(res, 400, { ok: false, reason: 'endpoint-not-https' }); return }
    var keys = sub.keys || {}
    if (!keys.p256dh || !keys.auth) { json(res, 400, { ok: false, reason: 'missing-keys' }); return }
    var id = crypto.createHash('sha256').update(sub.endpoint).digest('hex').slice(0, 12)
    pushSubscriptions.set(id, { endpoint: sub.endpoint, keys: keys, at: Date.now(), ua: req.headers['user-agent'] || '' })
    json(res, 200, { ok: true, id: id })
  })
}
function pushSendHandler(req, res) {
  var ip = normalizeIp(req.socket.remoteAddress)
  // Local callers and approved devices may raise a notification: an approved
  // phone reports "the agent finished" so other subscribed devices get it too.
  var d = decisions[ip]
  var approved = d && d.allow === true && d.revoked !== true
  if (!isLocalSocket(req) && !approved) { json(res, 403, { ok: false, reason: 'not-approved' }); return }
  if (req.method !== 'POST') { json(res, 405, { ok: false, reason: 'post-only' }); return }
  var chunks = [], size = 0
  req.on('data', function (chunk) { if (size < 16384) { size += chunk.length; chunks.push(chunk) } })
  req.on('end', function () {
    var body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch (e) { json(res, 400, { ok: false }); return }
    sendPush({ title: body.title || 'DSH 任务完成', body: body.body || '', tag: body.tag || 'dsh-agent-done', data: body.data || {} }, function (err, r) {
      json(res, err ? 500 : 200, { ok: !err, sent: r ? r.sent : 0, failed: r ? r.failed : 0 })
    })
  })
}

function forwardRequest(decisions, req, res, clientIp) {
  // DSH 0.2 wants a browser session cookie. If the browser has none yet, the
  // gateway mints one with the process launch token and hands it over, so the
  // user opens a plain URL instead of a tokenized one.
  var pathname = String(req.url || '/').split('?')[0]
  var query = String(req.url || '').indexOf('?') >= 0 ? String(req.url).slice(String(req.url).indexOf('?')) : ''
  var carriesToken = /[?&]token=/.test(query)
  if (!carriesToken && !hasDshSessionCookie(req) &&
      (pathname === '/' || pathname === '/index.html')) {
    if (bootstrapDshSession(req, res, clientIp)) return
  }
  var headers = cleanHeaders(req.headers, clientIp)
  var upstream = http.request({ host: TARGET_HOST, port: TARGET_PORT, method: req.method, path: req.url, headers: headers }, function (upRes) {
    var outHeaders = {}; for (var k in upRes.headers) outHeaders[k] = upRes.headers[k]
    var ct = String(outHeaders['content-type'] || '')
    var isHtml = ct.indexOf('text/html') >= 0
    if (isHtml) outHeaders['cache-control'] = 'no-store'
    var kind = deviceKind(decisions, clientIp)
    if (isHtml) {
      var chunks = [], size = 0, sent = false
      var flush = function () {
        if (sent) return; sent = true
        try {
          var html = Buffer.concat(chunks).toString('utf8')
          html = injectHtml(html, kind)
          res.writeHead(upRes.statusCode || 502, outHeaders); res.end(html)
        } catch (e) { try { res.end() } catch (e2) {} }
      }
      upRes.on('data', function (chunk) { if (sent) return; if (size + chunk.length > 524288) { flush(); return } size += chunk.length; chunks.push(chunk) })
      upRes.on('end', flush); upRes.on('error', flush); return
    }
    try { res.writeHead(upRes.statusCode || 502, outHeaders) } catch (e) {}
    upRes.pipe(res)
  })
  upstream.on('error', function () { try { if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Bad Gateway') } catch (e) {} })
  res.on('close', function () { try { upstream.destroy() } catch (e) {} })
  req.pipe(upstream)
}

// ---- server --------------------------------------------------------------------
var server = http.createServer(function (req, res) {
  var ip = normalizeIp(req.socket.remoteAddress)
  var pathname = String(req.url || '/').split('?')[0]
  if (overRate(ip)) { res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '60' }); res.end(rateLimitPage(ip)); return }
  if (pathname === '/lan-gate/status') { if (!isLocalSocket(req)) { json(res, 403, { ok: false }); return } statusHandler(req, res); return }
  if (pathname === '/lan-gate/action') { if (!isLocalSocket(req)) { json(res, 403, { ok: false }); return } actionHandler(req, res); return }
  if (pathname === '/lan-gate/admin') { if (!isLocalSocket(req)) { res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(deniedPage(ip)); return } res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(adminPage()); return }
  // PWA assets are served to approved LAN/remote devices too.
  if (pathname.indexOf('/pwa/') === 0) {
    var approved = decisions[ip] && decisions[ip].allow === true && decisions[ip].revoked !== true
    var local = isLoopbackIp(ip) || lanIps().indexOf(ip) >= 0
    if (local || approved) { if (servePwaAsset(req, res)) return }
  }
  // Push endpoints.
  if (pathname === '/pwa/push/subscribe') { pushSubscribeHandler(req, res); return }
  if (pathname === '/pwa/push/send') { if (!isLocalSocket(req)) { json(res, 403, { ok: false }); return } pushSendHandler(req, res); return }

  if (isLoopbackIp(ip) || lanIps().indexOf(ip) >= 0) { forwardRequest(decisions, req, res, ip); return }
  var d = decisions[ip]
  if (d && d.allow === true && d.revoked !== true) {
    if (!d.token) { d.token = randomToken(); d.issued = false; save() }
    if (parseCookies(req).lg_token === d.token) { forwardRequest(decisions, req, res, ip); return }
    if (d.issued === true) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(boundPage(ip)); return }
    if (queryTicket(req.url) === d.token) { d.issued = true; save(); setTokenCookie(res, d.token, false); res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' }); res.end(''); return }
    res.writeHead(302, { Location: '/?t=' + encodeURIComponent(d.token), 'Cache-Control': 'no-store' }); res.end(''); return
  }
  if (!seen[ip]) seen[ip] = { firstSeen: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 160) }
  if (d && d.allow === false && d.revoked !== true) { res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(deniedPage(ip)); return }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(pendingPage(ip, seen[ip].ua))
})

server.on('upgrade', function (req, socket, head) {
  var ip = normalizeIp(socket.remoteAddress)
  if (overRate(ip)) { try { socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n') } catch (e) {} return }
  var d = decisions[ip]
  var ok = isLoopbackIp(ip) || lanIps().indexOf(ip) >= 0 || (d !== undefined && d.allow === true && d.revoked !== true && d.token !== undefined && parseCookies(req).lg_token === d.token)
  if (!ok) { try { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n') } catch (e) {} return }
  var headers = cleanHeaders(req.headers, ip)
  headers['upgrade'] = req.headers['upgrade'] || 'websocket'
  headers['connection'] = 'Upgrade'
  var upstream = net.connect(TARGET_PORT, TARGET_HOST, function () {
    var raw = req.method + ' ' + req.url + ' HTTP/1.1\r\n'
    for (var k in headers) { var v = headers[k]; if (Array.isArray(v)) { for (var i = 0; i < v.length; i++) raw += k + ': ' + v[i] + '\r\n' } else { raw += k + ': ' + v + '\r\n' } }
    raw += '\r\n'
    var kill = function () { try { socket.destroy() } catch (e) {} try { upstream.destroy() } catch (e) {} }
    socket.on('error', kill); upstream.on('error', kill); socket.on('close', kill); upstream.on('close', kill)
    try { upstream.write(raw) } catch (e) {}
    if (head && head.length > 0) { try { upstream.write(head) } catch (e) {} }
    socket.pipe(upstream); upstream.pipe(socket)
  })
  upstream.on('error', function () { try { socket.destroy() } catch (e) {} })
})

var maxPort = PROXY_PORT + 20
server.on('error', function (err) { if (err && err.code === 'EADDRINUSE' && PROXY_PORT < maxPort) { PROXY_PORT += 1; try { server.listen(PROXY_PORT, LISTEN_HOST) } catch (e2) { console.error('[lan-gate] listen failed: ' + String(e2 && e2.message || e2)); process.exit(1) } return } console.error('[lan-gate] server error: ' + String(err && err.message ? err.message : err)); process.exit(1) })
server.listen(PROXY_PORT, LISTEN_HOST, function () { console.log('[lan-gate] listening on ' + LISTEN_HOST + ':' + PROXY_PORT + ' -> ' + TARGET_HOST + ':' + TARGET_PORT + ' (pwa=on)') })

var sweep = setInterval(function () { var now = Date.now(); rateMap.forEach(function (rate, ip) { if (now - rate.started >= 120000) rateMap.delete(ip) }) }, 3000)
initVapid()
process.on('SIGTERM', function () { clearInterval(sweep); try { server.close() } catch (e) {} process.exit(0) })
process.on('SIGINT', function () { clearInterval(sweep); try { server.close() } catch (e) {} process.exit(0) })
console.log('[lan-gate] gateway starting on port ' + PROXY_PORT)
