/* dsh-mobile-pwa — browser setup contract test
 *
 * Covers the parts of scripts/ that are pure logic, so a regression in the
 * installer or the proxy shim is caught without a server, a network, or a real
 * Chrome:
 *   1. argv parsing shared by every script
 *   2. Chrome for Testing platform / download selection
 *   3. apt package names across the 64-bit time_t rename (Ubuntu 24.04+)
 *   4. the profile patch block: build, insert, replace, idempotence
 *   5. proxy resolution precedence and Chromium launch-flag merging
 *   6. the shim imports with no Playwright installed (lazy loading)
 *   7. xray split routing: catch-all removal, idempotence, direct/block outbounds
 */
'use strict'
const { test } = require('node:test')
const assert = require('node:assert')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const SCRIPTS = path.join(__dirname, '..', 'scripts')
const load = (file) => import(pathToFileURL(path.join(SCRIPTS, file)).href)

test('parseArgs handles --key value, --flag and --key=value', async () => {
  const { parseArgs } = await load('setup-browser.mjs')
  const args = parseArgs(['--prefix', '/opt/x', '--dry-run', '--proxy=http://p:1', 'positional'])
  assert.strictEqual(args.prefix, '/opt/x')
  assert.strictEqual(args['dry-run'], true)
  assert.strictEqual(args.proxy, 'http://p:1')
  assert.deepStrictEqual(args._, ['positional'])
})

test('chromePlatform and chromeBinaryName map the host correctly', async () => {
  const { chromePlatform, chromeBinaryName } = await load('setup-browser.mjs')
  assert.strictEqual(chromePlatform('linux', 'x64'), 'linux64')
  assert.strictEqual(chromePlatform('darwin', 'arm64'), 'mac-arm64')
  assert.strictEqual(chromePlatform('darwin', 'x64'), 'mac-x64')
  assert.strictEqual(chromePlatform('win32', 'x64'), 'win64')
  assert.strictEqual(chromeBinaryName('linux'), 'chrome')
  assert.strictEqual(chromeBinaryName('win32'), 'chrome.exe')
  assert.match(chromeBinaryName('darwin'), /Contents\/MacOS/)
  assert.throws(() => chromePlatform('aix', 'x64'))
})

test('pickChromeDownload reads the CfT index for the requested platform', async () => {
  const { pickChromeDownload } = await load('setup-browser.mjs')
  const index = {
    channels: {
      Stable: {
        version: '153.0.8010.12',
        downloads: {
          chrome: [
            { platform: 'linux64', url: 'https://x/chrome-linux64.zip' },
            { platform: 'mac-arm64', url: 'https://x/chrome-mac-arm64.zip' },
          ],
        },
      },
    },
  }
  assert.deepStrictEqual(pickChromeDownload(index, 'linux64'), {
    version: '153.0.8010.12',
    url: 'https://x/chrome-linux64.zip',
  })
  assert.throws(() => pickChromeDownload(index, 'win64'), /No Chrome for Testing build/)
  assert.throws(() => pickChromeDownload({ channels: {} }, 'linux64'), /no "Stable" channel/)
})

test('aptDeps renames the time_t packages only where they were renamed', async () => {
  const { aptDeps } = await load('setup-browser.mjs')
  const noble = aptDeps({ id: 'ubuntu', versionId: '24.04' })
  assert.ok(noble.includes('libasound2t64'), 'noble must ask for libasound2t64')
  assert.ok(!noble.includes('libasound2'), 'noble must not ask for the old name')
  assert.ok(noble.includes('libatk1.0-0t64'))

  const jammy = aptDeps({ id: 'ubuntu', versionId: '22.04' })
  assert.ok(jammy.includes('libasound2'))
  assert.ok(!jammy.includes('libasound2t64'))

  const trixie = aptDeps({ id: 'debian', versionId: '13' })
  assert.ok(trixie.includes('libasound2t64'))
})

test('parseOsRelease reads ID and VERSION_ID', async () => {
  const { parseOsRelease } = await load('setup-browser.mjs')
  const parsed = parseOsRelease('NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="24.04"\nPRETTY_NAME="x"')
  assert.strictEqual(parsed.id, 'ubuntu')
  assert.strictEqual(parsed.versionId, '24.04')
})

test('buildBotRow produces the ds-bot browser config keys', async () => {
  const { buildBotRow } = await load('setup-browser.mjs')
  const block = buildBotRow({
    playwrightUrl: 'file:///opt/dsbot-browser/pw/pw-proxy-shim.mjs',
    executablePath: '/opt/dsbot-browser/chrome/chrome',
  })
  assert.match(block, /^- id: bot$/m)
  assert.match(block, /^ {2}name: ds-bot$/m)
  assert.match(block, /browserPlugin: refs/)
  assert.match(block, /browserHeadless: true/)
  assert.match(block, /playwrightUrl: file:\/\/\/opt\/dsbot-browser\/pw\/pw-proxy-shim\.mjs/)
  assert.match(block, /browserExecutablePath: \/opt\/dsbot-browser\/chrome\/chrome/)
})

test('upsertBotRow inserts, replaces and stays idempotent', async () => {
  const { buildBotRow, upsertBotRow } = await load('setup-browser.mjs')
  const block = buildBotRow({ playwrightUrl: 'file:///p.mjs', executablePath: '/c/chrome' })

  const fresh = upsertBotRow('', block)
  assert.match(fresh, /^- id: bot$/m)
  assert.strictEqual(upsertBotRow(fresh, block), fresh, 'second apply must not change anything')

  const withNeighbours = [
    '- id: llm-pi-ai',
    '  config:',
    '    provider: x',
    '',
    '- id: connection',
    '  config:',
    '    trustedHosts: []',
    '',
  ].join('\n')
  const inserted = upsertBotRow(withNeighbours, block)
  assert.match(inserted, /- id: llm-pi-ai/)
  assert.match(inserted, /- id: bot/)
  assert.match(inserted, /- id: connection/)
  assert.ok(inserted.indexOf('- id: bot') > inserted.indexOf('- id: llm-pi-ai'))

  const replaced = upsertBotRow(inserted, buildBotRow({ playwrightUrl: 'file:///new.mjs', executablePath: '/new/chrome' }))
  assert.match(replaced, /playwrightUrl: file:\/\/\/new\.mjs/)
  assert.ok(!replaced.includes('file:///p.mjs'), 'the old block must be gone, not merged')
  assert.match(replaced, /- id: connection/, 'later blocks must survive')
  assert.strictEqual(replaced.match(/- id: bot/g).length, 1, 'exactly one bot row')
})

test('resolveProxy prefers env over the config file, and defaults the bypass', async () => {
  const { resolveProxy } = await load('pw-proxy-shim.mjs')
  assert.deepStrictEqual(resolveProxy({ env: {}, config: {} }), {
    proxy: '',
    bypass: 'localhost,127.0.0.1,::1',
  })
  assert.strictEqual(resolveProxy({ env: {}, config: { proxy: 'http://file:1' } }).proxy, 'http://file:1')
  assert.strictEqual(
    resolveProxy({ env: { DSBOT_BROWSER_PROXY: 'http://env:2' }, config: { proxy: 'http://file:1' } }).proxy,
    'http://env:2',
  )
  assert.strictEqual(
    resolveProxy({ env: { DSBOT_BROWSER_PROXY_BYPASS: 'a,b' }, config: { proxy: 'http://x:1', bypass: 'c' } }).bypass,
    'a,b',
  )
  assert.strictEqual(
    resolveProxy({ env: {}, config: { proxy: 'http://x:1', bypass: 'c' } }).bypass,
    'c',
  )
})

test('resolveProxy honours an explicit off token even when a file configures one', async () => {
  const { resolveProxy } = await load('pw-proxy-shim.mjs')
  // `--no-proxy` has to win over browser-proxy.json, otherwise the doctor keeps
  // testing the proxy it was told to ignore.
  for (const token of ['off', 'none', 'direct', '0', 'false']) {
    assert.strictEqual(
      resolveProxy({ env: { DSBOT_BROWSER_PROXY: token }, config: { proxy: 'http://file:1' } }).proxy,
      '',
      `${token} must disable the proxy`,
    )
  }
  assert.strictEqual(resolveProxy({ env: {}, config: { proxy: 'off' } }).proxy, '')
  // An empty env value still means "not set", not "off".
  assert.strictEqual(resolveProxy({ env: { DSBOT_BROWSER_PROXY: '' }, config: { proxy: 'http://file:1' } }).proxy, 'http://file:1')
})

test('buildArgs adds proxy flags only when a proxy is set, without duplicates', async () => {
  const { buildArgs } = await load('pw-proxy-shim.mjs')
  const direct = buildArgs(['--disable-dev-shm-usage'], { proxy: '', bypass: 'x' })
  assert.deepStrictEqual(direct, ['--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'])

  const proxied = buildArgs(['--disable-dev-shm-usage'], { proxy: 'http://127.0.0.1:7890', bypass: 'localhost' })
  assert.ok(proxied.includes('--proxy-server=http://127.0.0.1:7890'))
  assert.ok(proxied.includes('--proxy-bypass-list=localhost'))

  const twice = buildArgs(proxied, { proxy: 'http://127.0.0.1:7890', bypass: 'localhost' })
  assert.strictEqual(twice.filter((a) => a.startsWith('--proxy-server=')).length, 1)
  assert.strictEqual(twice.filter((a) => a.startsWith('--disable-blink-features=')).length, 1)
})

test('patchLaunchArgs works for both launch() and launchPersistentContext()', async () => {
  const { patchLaunchArgs } = await load('pw-proxy-shim.mjs')
  const settings = { proxy: 'http://p:1', bypass: 'localhost' }

  const persistent = patchLaunchArgs(['/tmp/profile', { headless: true, args: ['--x'] }], settings)
  assert.strictEqual(persistent[0], '/tmp/profile')
  assert.ok(persistent[1].args.includes('--proxy-server=http://p:1'))

  const plain = patchLaunchArgs([{ headless: true }], settings)
  assert.ok(plain[0].args.includes('--proxy-server=http://p:1'))

  const noOptions = patchLaunchArgs([], settings)
  assert.ok(noOptions[0].args.includes('--proxy-server=http://p:1'))
})

test('the shim imports without Playwright installed', async () => {
  // A real ds-bot import happens before any browser exists; if this threw, the
  // plugin would fail to mount instead of failing on first use.
  const shim = await load('pw-proxy-shim.mjs')
  assert.ok(shim.chromium)
  assert.strictEqual(typeof shim.resolveProxy, 'function')
})

test('chromeDownloadUrls tries the official host first, then the CN mirrors', async () => {
  const { chromeDownloadUrls, officialChromeUrl } = await load('setup-browser.mjs')
  const urls = chromeDownloadUrls('153.0.8010.12', 'linux64')
  assert.strictEqual(urls[0], officialChromeUrl('153.0.8010.12', 'linux64'))
  assert.match(urls[0], /^https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\//)
  assert.ok(urls.some((u) => u.startsWith('https://cdn.npmmirror.com/binaries/chrome-for-testing/153.0.8010.12/linux64/chrome-linux64.zip')))
  assert.ok(urls.some((u) => u.startsWith('https://registry.npmmirror.com/-/binary/chrome-for-testing/')))
  assert.strictEqual(new Set(urls).size, urls.length, 'no duplicate sources')

  const pinned = chromeDownloadUrls('153.0.8010.12', 'linux64', { official: 'https://example.com/x.zip', mirrors: [] })
  assert.deepStrictEqual(pinned, ['https://example.com/x.zip'])
})

test('pickHighestVersion sorts numerically, not lexically', async () => {
  const { pickHighestVersion } = await load('setup-browser.mjs')
  const listing = [
    { name: '99.0.4844.51/' },
    { name: '153.0.8010.12/' },
    { name: '9.0.1.2/' },
    { name: 'not-a-version/' },
  ]
  assert.strictEqual(pickHighestVersion(listing), '153.0.8010.12')
  assert.strictEqual(pickHighestVersion([{ name: '153.0.8010.9/' }, { name: '153.0.8010.12/' }]), '153.0.8010.12')
  assert.strictEqual(pickHighestVersion([]), '')
  assert.strictEqual(pickHighestVersion(undefined), '')
})

test('applyImagePatch turns the base64 screenshot into an attachment block', async () => {
  const { applyImagePatch, MARKER } = await load('patch-ds-bot-image.mjs')
  // The three anchors as they appear in ds-bot's mount.js.
  const original = [
    'export const browserOutput = {',
    '  schema: {',
    '    oneOf: [',
    '      { type: \'string\' },',
    '      {',
    '        type: \'object\',',
    '        properties: {',
    '          text: { type: \'string\', required: true },',
    '          image: { type: \'string\' },',
    '        },',
    '        additionalProperties: false,',
    '      },',
    '    ],',
    '  },',
    '  render(_args, value) {',
    '    if (value && typeof value === \'object\') {',
    '      const blocks = [{ type: \'text\', text: String(value.text ?? \'\') }]',
    '      if (value.image) blocks.push({ type: \'image\', data: value.image, mediaType: \'image/jpeg\' })',
    '      return blocks',
    '    }',
    '  },',
    '}',
    '',
    '/**',
    ' * @param {any} ctx',
    ' * @param {{ toolDefs: any[], defineTool: Function }} options',
    ' */',
    'export function mountBrowserPlugin(ctx, options) {',
    '      async execute(args, exec) {',
    '        const gate = authorize ? action => authorize(exec, botId, action) : undefined',
    '        return gateScope.run(gate, () => spec.execute(args ?? {}, {',
    '          botId,',
    '          profileDir: join(profileRoot, botId),',
    '          session,',
    '          complete: completeFor?.(exec),',
    '        }))',
    '      },',
    '}',
  ].join('\n')

  const result = applyImagePatch(original)
  assert.strictEqual(result.changed, true)
  assert.deepStrictEqual(result.missing, [])
  assert.strictEqual(result.applied.length, 4)

  assert.match(result.source, new RegExp(MARKER), 'marker is present so a re-run is a no-op')
  assert.match(result.source, /attachment: \{ type: 'object', additionalProperties: true \}/, 'schema allows the ref, explicitly closed')
  assert.match(result.source, /if \(value\.attachment\) blocks\.push\(\{ type: 'image', attachment: value\.attachment \}\)/)
  assert.ok(!result.source.includes("type: 'image', data: value.image"), 'the crashing shape is gone')
  assert.match(result.source, /await attachments\.saveImages\(\[\{/)
  assert.match(result.source, /const result = await gateScope\.run/)
  assert.match(result.source, /return withScreenshotAttachment\(result, ctx\)/)

  // Idempotent: the marker short-circuits a second run.
  const again = applyImagePatch(result.source)
  assert.strictEqual(again.patched, true)
  assert.strictEqual(again.changed, false)
  assert.strictEqual(again.source, result.source)
})

test('applyImagePatch refuses to guess when ds-bot has drifted', async () => {
  const { applyImagePatch } = await load('patch-ds-bot-image.mjs')
  const result = applyImagePatch('// some other version\nexport const x = 1\n')
  assert.strictEqual(result.changed, false)
  assert.strictEqual(result.missing.length, 4)
  assert.strictEqual(result.source, '// some other version\nexport const x = 1\n', 'nothing is rewritten')
})

test('applyHistoryGuardPatch stops stale image blocks from breaking a session', async () => {
  const { applyHistoryGuardPatch, HISTORY_MARKER } = await load('patch-ds-bot-image.mjs')
  const original = [
    '    for (const message of messages) {',
    '      if (!liveImages(message)) continue',
    '      for (const block of message.content) {',
    "        if (block?.type === 'image' && !block.offloaded) images.set(String(block.attachment.attachmentId), block.attachment)",
    '      }',
    '    }',
    '    return messages.map(message => (liveImages(message)',
    '      ? {',
    '          ...message,',
    "          content: message.content.map(block => (block?.type === 'image' && !block.offloaded",
    "            ? imageAsText(block.attachment, readings.get(String(block.attachment.attachmentId)))",
    '            : block)),',
    '        }',
    '      : message))',
  ].join('\n')

  const result = applyHistoryGuardPatch(original)
  assert.strictEqual(result.changed, true)
  assert.deepStrictEqual(result.missing, [])
  assert.match(result.source, new RegExp(HISTORY_MARKER))
  assert.match(result.source, /block\?\.type === 'image' && block\.attachment && !block\.offloaded\) images\.set/)
  assert.match(result.source, /content: message\.content\.map\(block => \(block\?\.type === 'image' && block\.attachment && !block\.offloaded/)
  // Every occurrence of the old unguarded condition must be gone; both call
  // sites now require an attachment before touching it.
  assert.ok(
    !result.source.includes("type === 'image' && !block.offloaded"),
    'no unguarded `type === image && !offloaded` condition survives',
  )

  assert.strictEqual(applyHistoryGuardPatch(result.source).patched, true)
})

test('isCatchAll spots the rule that swallows every other rule', async () => {
  const { isCatchAll } = await load('xray-split-route.mjs')
  assert.strictEqual(isCatchAll({ type: 'field', outboundTag: 'proxy' }), true)
  assert.strictEqual(isCatchAll({ type: 'field', network: 'tcp,udp', outboundTag: 'proxy' }), false)
  assert.strictEqual(isCatchAll({ type: 'field', domain: ['geosite:cn'], outboundTag: 'direct' }), false)
  assert.strictEqual(isCatchAll({ type: 'field', ip: [], outboundTag: 'proxy' }), true)
})

test('applySplitRouting fixes a stock catch-all config', async () => {
  const { applySplitRouting } = await load('xray-split-route.mjs')
  const stock = {
    inbounds: [{ port: 7890, protocol: 'http', tag: 'http-in' }],
    outbounds: [
      { tag: 'proxy', protocol: 'vless', settings: {} },
      { tag: 'direct', protocol: 'freedom', settings: {} },
    ],
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [{ type: 'field', outboundTag: 'proxy' }],
    },
  }
  const { config, changed, notes } = applySplitRouting(stock)
  assert.strictEqual(changed, true)
  assert.strictEqual(config.routing.domainStrategy, 'IPOnDemand')
  assert.ok(notes.some((n) => /catch-all/.test(n)))
  assert.ok(!config.outbounds.some((o) => o.tag === 'block'), 'no unreferenced block outbound')

  const rules = config.routing.rules
  assert.deepStrictEqual(rules[0].domain, ['geosite:cn'])
  assert.deepStrictEqual(rules[1].ip, ['geoip:cn', 'geoip:private'])
  assert.ok(rules.every((r) => !(r.outboundTag === 'proxy' && !r.network)), 'no catch-all may survive')
  assert.ok(rules.some((r) => r.outboundTag === 'proxy'), 'something must still reach the proxy')

  // The input object is not mutated.
  assert.strictEqual(stock.routing.rules.length, 1)
  assert.strictEqual(stock.routing.domainStrategy, 'IPIfNonMatch')
})

test('applySplitRouting adds a block outbound only when a rule uses it', async () => {
  const { applySplitRouting } = await load('xray-split-route.mjs')
  const config = {
    outbounds: [{ tag: 'proxy', protocol: 'vless', settings: {} }],
    routing: {
      rules: [
        { type: 'field', domain: ['geosite:category-ads-all'], outboundTag: 'block' },
        { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' },
      ],
    },
  }
  const { config: next, notes } = applySplitRouting(config)
  assert.ok(notes.some((n) => /block/.test(n)))
  assert.ok(next.outbounds.some((o) => o.tag === 'block' && o.protocol === 'blackhole'))
  assert.ok(next.outbounds.some((o) => o.tag === 'direct' && o.protocol === 'freedom'))
  assert.ok(next.routing.rules.some((r) => r.outboundTag === 'block'), 'the ad rule survives')
})

test('applySplitRouting is idempotent and keeps user rules', async () => {
  const { applySplitRouting } = await load('xray-split-route.mjs')
  const outbounds = [
    { tag: 'proxy', protocol: 'vless', settings: {} },
    { tag: 'direct', protocol: 'freedom', settings: {} },
    { tag: 'block', protocol: 'blackhole', settings: {} },
  ]
  // Already correct, in the shape a hand-tuned config usually has: the values
  // are grouped differently from what this script would emit, and that is fine.
  const canonical = {
    outbounds,
    routing: {
      domainStrategy: 'IPOnDemand',
      rules: [
        { type: 'field', outboundTag: 'direct', domain: ['geosite:cn', 'geosite:private'] },
        { type: 'field', outboundTag: 'direct', ip: ['geoip:cn', 'geoip:private'] },
        { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' },
      ],
    },
  }
  const once = applySplitRouting(canonical)
  assert.strictEqual(once.changed, false, 'an already-correct config must not churn')
  assert.deepStrictEqual(once.config.routing, canonical.routing)

  // A shuffled config converges in one pass and then stops moving.
  const shuffled = {
    outbounds,
    routing: {
      domainStrategy: 'IPOnDemand',
      rules: [
        { type: 'field', domain: ['domain:corp.example'], outboundTag: 'direct' },
        { type: 'field', domain: ['geosite:cn'], outboundTag: 'direct' },
        { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' },
      ],
    },
  }
  const first = applySplitRouting(shuffled)
  assert.strictEqual(first.changed, true)
  const second = applySplitRouting(first.config)
  assert.strictEqual(second.changed, false, 'the second pass must be a no-op')
  assert.deepStrictEqual(second.config.routing, first.config.routing)
  assert.ok(second.config.routing.rules.some((r) => r.domain?.includes('domain:corp.example')), 'user rules survive')
  assert.strictEqual(
    second.config.routing.rules.filter((r) => r.domain?.includes('geosite:cn')).length,
    1,
    'our rules are not duplicated',
  )
})
