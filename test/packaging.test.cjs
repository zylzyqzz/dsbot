/* Packaging guards.
 *
 * Two things broke once already and both would break silently:
 *
 *  1. A scoped package name is not a legal YAML plain scalar. `@` is a
 *     reserved indicator, so `name: @zylzyqzz/dsbot` makes the whole bundle
 *     patch unparseable and DSH silently *skips the bundle* - the gateway
 *     just never starts, with no error on the plugin side.
 *
 *  2. The password proof contexts are load-bearing. Renaming them would
 *     invalidate every access password and every device token an installed
 *     deployment already handed out.
 */
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('the package is published under the scoped DSBot name', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.strictEqual(pkg.name, '@zylzyqzz/dsbot')
  assert.strictEqual(pkg.version, '0.3.0')
})

test('the bundle patch rows name the package in quotes', () => {
  for (const file of ['cordis.patch.yml', 'cordis.patch.yml.example']) {
    const text = read(file)
    assert.ok(
      text.includes("name: '@zylzyqzz/dsbot'"),
      file + ' must quote the scoped package name'
    )
    assert.ok(
      !/^\s*name:\s*@\S/m.test(text),
      file + ' has a bare @-prefixed YAML scalar, which YAML forbids'
    )
  }
})

test('the bundle patch row ids are the short plugin id', () => {
  for (const file of ['cordis.patch.yml', 'cordis.patch.yml.example']) {
    const text = read(file)
    assert.ok(text.includes('id: dsbot'), file + ' must insert the dsbot entry id')
    assert.ok(
      !/^\s*id:\s*dsh-mobile-pwa/m.test(text),
      file + ' still carries the pre-rename entry id'
    )
  }
})

test('no published file names the old package any more', () => {
  const files = [
    'package.json', 'README.md', 'README.en.md', 'AGENTS.md', 'LICENSE',
    'llms.txt', 'cordis.patch.yml', 'cordis.patch.yml.example', 'lan-gate.mjs',
    'lib/lan-gate-auth.cjs', 'lib/lan-gate-server.cjs', 'lib/web-push.cjs',
    'pwa/app.css', 'pwa/inject.js', 'pwa/manifest.json', 'pwa/offline.html',
    'pwa/sw.js', 'pwa/touch-gestures.js', 'pwa/dsh-rpc.js', 'pwa/muse-shell.js'
  ]
  for (const file of files) {
    const text = read(file)
    // The two password contexts are the only legitimate mentions left.
    const stripped = text
      .split("'dsh-mobile-pwa-gate'").join('')
      .split("String(context || 'dsh-mobile-pwa')").join('')
    assert.ok(
      !stripped.includes('dsh-mobile-pwa'),
      file + ' still mentions the old package name'
    )
  }
})

test('the password proof contexts survive a rename untouched', () => {
  assert.ok(
    read('lib/lan-gate-server.cjs').includes("var PASS_CONTEXT = 'dsh-mobile-pwa-gate'"),
    'the access-password context must not change when the product is renamed'
  )
  assert.ok(
    read('lib/lan-gate-auth.cjs').includes("String(context || 'dsh-mobile-pwa')"),
    'the device-token context must not change when the product is renamed'
  )
})

test('the wiring the deployment depends on keeps its old names', () => {
  // Environment variables, cookie names, storage keys and data attributes
  // are part of the contract with an installed deployment.
  const server = read('lib/lan-gate-server.cjs')
  assert.ok(server.includes('LAN_GATE_PORT'))
  assert.ok(server.includes('LAN_GATE_PASSWORD'))
  // The trusted-host list is merged into DSH's connection row by the bundle
  // patch, not by the gateway child process.
  assert.ok(read('cordis.patch.yml').includes('LAN_GATE_TRUSTED_HOSTS'))

  const sw = read('pwa/sw.js')
  assert.ok(sw.includes('dsh-agent-done'), 'the push tag is a persisted contract')
  assert.ok(
    read('pwa/inject.js').includes('dsh-pwa-notif-hint'),
    'the notification hint key is persisted in localStorage'
  )
  assert.ok(
    read('pwa/touch-gestures.js').includes('dsh-pwa-fontscale'),
    'the font-scale key is persisted in localStorage'
  )
})

test('the installed app presents itself as DSBot', () => {
  const manifest = JSON.parse(read('pwa/manifest.json'))
  assert.strictEqual(manifest.name, 'DSBot')
  assert.strictEqual(manifest.short_name, 'DSBot')
  assert.strictEqual(manifest.id, '/')
  assert.strictEqual(manifest.start_url, '/')

  const server = read('lib/lan-gate-server.cjs')
  assert.ok(server.includes("base.short_name || 'DSBot'"))
  assert.ok(server.includes('<div class="logo">DSB</div>'))
})
