/* dsh-mobile-pwa · lib/lan-gate-auth.cjs
 *
 * Device approvals and browser tokens.
 *
 * An approval is bound to a network address; a token is bound to a browser.
 * Keeping those two apart matters in practice: a phone and a laptop behind
 * the same NAT share one public address, and so does the operator testing
 * from the same network. One token per address would lock every browser out
 * but the first — the "此设备的访问令牌已绑定到其他浏览器" wall.
 *
 * The address decision stays the access control. The token only proves that
 * this particular browser belongs to a device that was approved.
 */

'use strict'

const crypto = require('node:crypto')

// How many browsers one approved device may hold at the same time. The cap
// keeps a leaked address from turning into an open door; past it the admin
// has to revoke and re-approve the device.
const MAX_TOKENS_PER_DEVICE = Number(process.env.LAN_GATE_MAX_TOKENS || 8)

function randomToken() { return crypto.randomBytes(16).toString('hex') }

/**
 * Bring a persisted decision record into the current shape.
 *
 * Records written by the single-token gateway carry `token`/`issued`; they
 * become a one-entry token list, so the browser that already holds the cookie
 * keeps working after an upgrade.
 */
function normalizeDecision(d) {
  if (!d || typeof d !== 'object') return null
  var list = Array.isArray(d.tokens) ? d.tokens.slice() : []
  if (!list.length && typeof d.token === 'string' && d.token.length >= 16) list.push(d.token)
  d.tokens = list.filter(function (t) { return typeof t === 'string' && t.length >= 16 })
  delete d.token
  delete d.issued
  return d
}

function normalizeDecisions(raw) {
  if (!raw || typeof raw !== 'object') return {}
  for (var ip in raw) {
    if (!normalizeDecision(raw[ip])) delete raw[ip]
  }
  return raw
}

function tokenList(d) { return d && Array.isArray(d.tokens) ? d.tokens : [] }

function hasToken(d, token) {
  if (!d || !token) return false
  return tokenList(d).indexOf(token) >= 0
}

/**
 * Approve a device. `keepTokens` preserves the browsers that are already
 * signed in — used when only the device kind changes, so that switching
 * "自动 / 手机 / 电脑" does not sign the user out.
 */
function approveDevice(decisions, ip, kind, keepTokens) {
  var prev = decisions[ip]
  var nextKind = kind === 'phone' || kind === 'desktop'
    ? kind
    : (prev && (prev.kind === 'phone' || prev.kind === 'desktop') ? prev.kind : 'auto')
  decisions[ip] = {
    ip: ip,
    allow: true,
    at: Date.now(),
    revoked: false,
    kind: nextKind,
    tokens: keepTokens ? tokenList(prev).slice() : []
  }
  return decisions[ip]
}

/** Deny a device and drop every browser token it held. */
function denyDevice(decisions, ip) {
  decisions[ip] = { ip: ip, allow: false, at: Date.now(), revoked: false, kind: 'auto', tokens: [] }
  return decisions[ip]
}

/** Revoke a device: the address stays known, but every token dies with it. */
function revokeDevice(decisions, ip) {
  var prev = decisions[ip]
  decisions[ip] = {
    ip: ip,
    allow: prev ? prev.allow === true : true,
    at: Date.now(),
    revoked: true,
    kind: prev && prev.kind ? prev.kind : 'auto',
    tokens: []
  }
  return decisions[ip]
}

/**
 * Decide what to do with a request that arrived from a remote address.
 *
 * - forward  : this browser already holds a token of this device
 * - ticket   : the URL carries a token this device owns — hand it back as a cookie
 * - issue    : a new browser — mint a token for it
 * - too-many : the device already holds the maximum number of browsers
 * - denied   : the device was denied
 * - pending  : the device was never approved (or was revoked)
 */
function resolveRemote(decisions, ip, cookieToken, ticket) {
  var d = decisions[ip]
  if (!d) return { action: 'pending' }
  if (d.revoked === true) return { action: 'pending' }
  if (d.allow !== true) return { action: 'denied' }
  if (cookieToken && hasToken(d, cookieToken)) return { action: 'forward' }
  if (ticket && hasToken(d, ticket)) return { action: 'ticket', token: ticket }
  var tokens = tokenList(d)
  if (tokens.length >= MAX_TOKENS_PER_DEVICE) return { action: 'too-many', count: tokens.length }
  return { action: 'issue', token: randomToken() }
}

module.exports = {
  MAX_TOKENS_PER_DEVICE,
  randomToken,
  normalizeDecision,
  normalizeDecisions,
  tokenList,
  hasToken,
  approveDevice,
  denyDevice,
  revokeDevice,
  resolveRemote
}
