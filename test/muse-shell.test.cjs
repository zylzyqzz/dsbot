/* The Muse shell and its typed-RPC client.
 *
 * Both modules are plain browser scripts that also export their pure
 * helpers, so the wire shapes and the Muse grouping rules can be checked
 * without a browser. The wire shapes are not guesses: they were read out of
 * the DSH 0.2 source and confirmed against a live host.
 */
'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/**
 * Load one browser asset as a CommonJS module.
 *
 * The package is `"type": "module"`, so a plain require of a `.js` file
 * would hand it to the ESM loader, where the UMD wrapper takes its browser
 * branch and exports nothing. The assets are browser scripts first, so they
 * stay as they are and the test wraps them the way a CommonJS loader would.
 */
function loadBrowserModule(relative) {
  const file = path.join(__dirname, '..', relative)
  const source = fs.readFileSync(file, 'utf8')
  const wrapper = vm.runInThisContext(
    '(function (module, exports, require, window, document) {\n' + source + '\n})',
    { filename: file }
  )
  const module = { exports: {} }
  wrapper(module, module.exports, require, undefined, undefined)
  return module.exports
}

const RPC = loadBrowserModule('pwa/dsh-rpc.js')
const MUSE = loadBrowserModule('pwa/muse-shell.js')

// ---- the typed-RPC envelope ---------------------------------------------

test('the request envelope is the one the host accepts', () => {
  const request = RPC.buildRequest('session', 'list', { _request: {} }, 'rpc-1')
  assert.deepStrictEqual(request, {
    type: 'client-request',
    rpcId: 'rpc-1',
    method: 'session/list',
    payload: { args: { _request: {} } }
  })
})

test('the payload carries exactly one args object', () => {
  // The host answers a wrong wrapper with "Remote payload must contain
  // exactly one plain-object args field", so the wrapper is not optional.
  const request = RPC.buildRequest('pluginManager', 'listPlugins', {}, 'rpc-2')
  assert.deepStrictEqual(Object.keys(request.payload), ['args'])
  assert.strictEqual(typeof request.payload.args, 'object')
})

test('a missing args field still produces a valid envelope', () => {
  const request = RPC.buildRequest('permissionPresets', 'catalog')
  assert.deepStrictEqual(request.payload, { args: {} })
})

test('the response envelope yields its value', () => {
  const envelope = { type: 'server-response', rpcId: 'r', result: { ok: true, value: { a: 1 } } }
  assert.deepStrictEqual(RPC.parseResponse(envelope, 'r'), { a: 1 })
})

test('a failed response carries the host error code and message', () => {
  const envelope = {
    type: 'server-response',
    rpcId: 'r',
    result: { ok: false, error: { code: 'gateway/arguments-invalid', message: 'missing "request"', details: {} } }
  }
  assert.throws(() => RPC.parseResponse(envelope, 'r'), (err) => {
    assert.strictEqual(err.code, 'gateway/arguments-invalid')
    assert.match(err.message, /missing "request"/)
    return true
  })
})

test('a response for another request is refused', () => {
  const envelope = { type: 'server-response', rpcId: 'other', result: { ok: true, value: 1 } }
  assert.throws(() => RPC.parseResponse(envelope, 'mine'), /rpcId mismatch/)
})

test('a foreign envelope is refused', () => {
  assert.throws(() => RPC.parseResponse({ type: 'nope' }, 'r'), /malformed/)
  assert.throws(() => RPC.parseResponse(null, 'r'), /malformed/)
})

test('the endpoint path is the host route', () => {
  assert.strictEqual(RPC.apiUrl('session', 'list'), '/api/session/list')
  assert.strictEqual(RPC.apiUrl('pluginManager', 'setPluginEnabled'), '/api/pluginManager/setPluginEnabled')
})

test('the carrier URL follows the page scheme', () => {
  assert.strictEqual(RPC.streamUrl('http://host:3088/'), 'ws://host:3088/api/remote.mux')
  assert.strictEqual(RPC.streamUrl('https://host/'), 'wss://host/api/remote.mux')
})

test('the stream open frame carries the endpoint and its args', () => {
  const frame = RPC.buildOpen('s1', 'session/follow', { request: { sessionId: 'x' } })
  assert.deepStrictEqual(frame, {
    type: 'open',
    streamId: 's1',
    endpoint: 'session/follow',
    payload: { args: { request: { sessionId: 'x' } } }
  })
})

test('an event result is answered with the correlation ids', () => {
  assert.deepStrictEqual(
    RPC.buildEventResult('c1', 'e1', { kind: 'result', value: 'ok' }),
    { clientId: 'c1', eventId: 'e1', outcome: { kind: 'result', value: 'ok' } }
  )
})

test('a frame that is not JSON is ignored', () => {
  assert.strictEqual(RPC.parseFrame('not json'), null)
  assert.strictEqual(RPC.parseFrame('null'), null)
  assert.deepStrictEqual(RPC.parseFrame('{"type":"item"}'), { type: 'item' })
})

// ---- session resolution -------------------------------------------------

test('a session id is read out of the location', () => {
  assert.strictEqual(RPC.sessionIdFromLocation('https://h/#/session/abc-123'), 'abc-123')
  assert.strictEqual(RPC.sessionIdFromLocation('https://h/?session=xyz789'), 'xyz789')
  assert.strictEqual(RPC.sessionIdFromLocation('https://h/#/sess_0011223344'), '0011223344')
})

test('a location without a session yields nothing', () => {
  assert.strictEqual(RPC.sessionIdFromLocation('https://h/'), undefined)
  assert.strictEqual(RPC.sessionIdFromLocation(''), undefined)
  assert.strictEqual(RPC.sessionIdFromLocation(undefined), undefined)
})

test('the running session wins over the merely recent one', () => {
  const picked = RPC.pickSession([
    { sessionId: 'a', updatedAt: 900, running: false },
    { sessionId: 'b', updatedAt: 100, running: true }
  ])
  assert.strictEqual(picked.sessionId, 'b')
})

test('without a running session the most recent one wins', () => {
  const picked = RPC.pickSession([
    { sessionId: 'a', updatedAt: 100, running: false },
    { sessionId: 'b', updatedAt: 900, running: false }
  ])
  assert.strictEqual(picked.sessionId, 'b')
})

test('an empty session list picks nothing', () => {
  assert.strictEqual(RPC.pickSession([]), undefined)
  assert.strictEqual(RPC.pickSession(undefined), undefined)
})

// ---- connector rows -----------------------------------------------------

test('a plugin title comes from the localized metadata', () => {
  const plugin = { moduleName: '@deepseek-ai/dsh-timer', meta: { title: { en: 'timer', zh: '计时服务' } } }
  assert.strictEqual(MUSE.pluginTitle(plugin, 'zh'), '计时服务')
  assert.strictEqual(MUSE.pluginTitle(plugin, 'en'), 'timer')
})

test('a plugin without metadata falls back to its module name', () => {
  assert.strictEqual(MUSE.pluginTitle({ moduleName: '@deepseek-ai/dsh-hmr' }, 'zh'), 'dsh-hmr')
  assert.strictEqual(MUSE.pluginTitle({ moduleName: 'cordis:include' }, 'en'), 'cordis:include')
})

test('a description is read in the page language', () => {
  const plugin = { meta: { description: { en: 'Timer service', zh: '为其他插件提供延时能力。' } } }
  assert.strictEqual(MUSE.pluginDescription(plugin, 'zh'), '为其他插件提供延时能力。')
  assert.strictEqual(MUSE.pluginDescription(plugin, 'en'), 'Timer service')
  assert.strictEqual(MUSE.pluginDescription({}, 'zh'), '')
})

test('connectors are split into what is connected and what is available', () => {
  const groups = MUSE.groupPlugins([
    { entryId: 'a', enabled: true },
    { entryId: 'b', enabled: false },
    { entryId: 'c', enabled: true },
    null
  ])
  assert.deepStrictEqual(groups.connected.map((p) => p.entryId), ['a', 'c'])
  assert.deepStrictEqual(groups.available.map((p) => p.entryId), ['b'])
})

test('a host-managed row offers no switch', () => {
  assert.strictEqual(MUSE.pluginAction({ enabled: true }), 'disconnect')
  assert.strictEqual(MUSE.pluginAction({ enabled: false }), 'connect')
  assert.strictEqual(MUSE.pluginAction({ enabled: true, readOnlyReason: 'management-required' }), 'locked')
  assert.strictEqual(MUSE.pluginAction({ enabled: false, readOnlyReason: 'unaddressable' }), 'locked')
})

// ---- permission rows ----------------------------------------------------

test('every DSH permission preset has a Muse wording', () => {
  const values = MUSE.PERMISSION_PRESETS.map((p) => p.value)
  assert.deepStrictEqual(values, ['read-only', 'workspace-write', 'danger-full-access'])
  for (const preset of MUSE.PERMISSION_PRESETS) {
    assert.ok(preset.title.length > 0)
    assert.ok(preset.description.length > 0)
  }
})

test('a preset is named in the page language', () => {
  assert.strictEqual(MUSE.presetTitle('read-only', 'zh'), '只读')
  assert.strictEqual(MUSE.presetTitle('read-only', 'en'), 'Read only')
  assert.strictEqual(MUSE.presetTitle('workspace-write', 'zh'), '工作区可写')
  assert.strictEqual(MUSE.presetTitle('danger-full-access', 'zh'), '完全访问')
})

test('an unknown preset still renders as itself', () => {
  assert.strictEqual(MUSE.presetTitle('auto', 'zh'), 'auto')
  assert.strictEqual(MUSE.presetDescription('auto', 'zh'), '')
})

// ---- artifacts ----------------------------------------------------------

test('only host-served files are downloadable', () => {
  assert.strictEqual(MUSE.artifactDownloadHref('/api/file?path=%2Froot%2Fa.png'), '/api/file?path=%2Froot%2Fa.png')
  assert.strictEqual(MUSE.artifactDownloadHref('https://example.com/a.png'), '')
  assert.strictEqual(MUSE.artifactDownloadHref('data:image/png;base64,AAA'), '')
  assert.strictEqual(MUSE.artifactDownloadHref(''), '')
})

test('an artifact image is a host file, not an avatar', () => {
  const doc = { createElement: () => ({ getAttribute: () => null, tagName: 'IMG' }) }
  const artifact = { tagName: 'IMG', getAttribute: (n) => (n === 'src' ? '/api/file?path=%2Ftmp%2Fa.png' : null) }
  const avatar = { tagName: 'IMG', getAttribute: (n) => (n === 'src' ? '/api/file?path=%2Ftmp%2Fface.png' : (n === 'width' ? '24' : null)) }
  assert.strictEqual(MUSE.isArtifactImage(artifact, doc), true)
  assert.strictEqual(MUSE.isArtifactImage(avatar, doc), false)
  assert.strictEqual(MUSE.isArtifactImage({ tagName: 'DIV' }, doc), false)
})
