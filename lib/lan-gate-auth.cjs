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
 * - denied   : the device was denied
 * - pending  : the device was never approved (or was revoked)
 *
 * `tokens` on an `issue` verdict is the token list the caller should store:
 * the new token plus the ones it keeps.
 *
 * There is deliberately no limit on how many browsers one approved device may
 * hold. The address is what was approved — the token only says which browser
 * this is — so capping the count would buy no security and would reintroduce
 * the "此设备的访问令牌已绑定到其他浏览器" wall for anyone on a shared
 * address.
 */
function resolveRemote(decisions, ip, cookieToken, ticket) {
  var d = decisions[ip]
  if (!d) return { action: 'pending' }
  if (d.revoked === true) return { action: 'pending' }
  if (d.allow !== true) return { action: 'denied' }
  if (cookieToken && hasToken(d, cookieToken)) return { action: 'forward' }
  if (ticket && hasToken(d, ticket)) return { action: 'ticket', token: ticket }
  var fresh = randomToken()
  return { action: 'issue', token: fresh, tokens: tokenList(d).concat([fresh]) }
}

/**
 * Derive the proof a browser stores after a successful password entry.
 *
 * The stored value is a keyed digest, not the password, so the password never
 * travels to the browser. It is deterministic, which keeps a signed-in browser
 * signed in across a gateway restart, and it is password-equivalent in
 * exactly the way a session cookie is.
 */
function passwordProof(password, context) {
  return crypto.createHmac('sha256', String(context || 'dsh-mobile-pwa'))
    .update(String(password), 'utf8')
    .digest('base64url')
}

/** Compare two proofs in constant time. */
function proofMatches(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) {
    // Compare something of the same length anyway, so the answer does not
    // leak the length through timing.
    crypto.timingSafeEqual(ba, ba)
    return false
  }
  return crypto.timingSafeEqual(ba, bb)
}

module.exports = {
  randomToken,
  normalizeDecision,
  normalizeDecisions,
  tokenList,
  hasToken,
  approveDevice,
  denyDevice,
  revokeDevice,
  resolveRemote,
  passwordProof,
  proofMatches
}
