#!/usr/bin/env node
/**
 * One-shot Bot browser setup for DSBot / dsh-mobile-pwa.
 *
 * ds-bot can drive a real Chrome, but it ships no browser: it expects
 * `playwrightUrl` + `browserExecutablePath` to point at a Playwright build and a
 * Chrome binary that already exist, and it has no proxy setting at all. Doing
 * that by hand is five fiddly steps (download, deps, chmod, npm, patch) and each
 * one fails differently. This script does all five, verifies the result, and
 * writes the profile patch so the next `dsh web` already has a working browser.
 *
 *   node scripts/setup-browser.mjs                      # full install + verify + patch
 *   node scripts/setup-browser.mjs --proxy http://127.0.0.1:7890
 *   node scripts/setup-browser.mjs --print-config       # only show the YAML block
 *   node scripts/setup-browser.mjs --verify-only        # doctor an existing install
 *
 * Options
 *   --prefix <dir>       install root (default /opt/dsbot-browser, or
 *                        %LOCALAPPDATA%\dsbot-browser on Windows)
 *   --chrome-version <v> pin a Chrome for Testing version (default: current Stable)
 *   --chrome-zip <file>  use a local zip instead of downloading
 *   --mirror <base>      extra download base to try before the built-in ones
 *   --no-mirror          official source only (fails on a mainland network)
 *   --proxy <url>        proxy for the Bot browser, written to browser-proxy.json
 *   --bypass <list>      proxy bypass list (default localhost,127.0.0.1,::1)
 *   --profile <dir>      DSH profile dir to patch (default $DSH_HOME/profiles/web)
 *   --url <url>          verification page (default https://example.com)
 *   --egress <url>       also read this page to show the browser's egress IP
 *   --no-patch           install only, leave the profile patch alone
 *   --no-verify          skip the post-install browser check
 *   --skip-deps          do not touch system packages (apt)
 *   --skip-playwright    reuse an existing playwright-core
 *   --skip-chrome        reuse an existing Chrome
 *   --dry-run            print the plan, change nothing
 *   --print-config       print the profile YAML block and exit
 *
 * Exit codes: 0 success, 1 a step failed, 2 bad usage.
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Chrome for Testing "current stable + download urls" index. */
export const CFT_INDEX_URL = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json'
export const DEFAULT_PLAYWRIGHT_CORE = '1.64.1'

/** Packages Chrome needs on a bare Linux server. */
export const CHROME_APT_DEPS = [
  'libnss3', 'libatk1.0-0', 'libatk-bridge2.0-0', 'libcups2', 'libdrm2',
  'libxkbcommon0', 'libxcomposite1', 'libxdamage1', 'libxfixes3', 'libxrandr2',
  'libgbm1', 'libpango-1.0-0', 'libcairo2', 'libasound2', 'libatspi2.0-0',
  'libx11-xcb1', 'libxcb-dri3-0', 'fonts-liberation',
]

/** Minimal argv parser: --key value, --flag, --key=value. */
export function parseArgs(argv) {
  const out = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) { out._.push(token); continue }
    const body = token.slice(2)
    const eq = body.indexOf('=')
    if (eq !== -1) { out[body.slice(0, eq)] = body.slice(eq + 1); continue }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) { out[body] = next; index += 1 } else { out[body] = true }
  }
  return out
}

/** Chrome for Testing platform id for a Node (platform, arch) pair. */
export function chromePlatform(platform = process.platform, arch = process.arch) {
  if (platform === 'linux') return arch === 'arm64' ? 'linux64' : 'linux64'
  if (platform === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64'
  if (platform === 'win32') return arch === 'x64' ? 'win64' : 'win32'
  throw new Error(`Unsupported platform for Chrome for Testing: ${platform}/${arch}`)
}

/** Executable name inside a Chrome for Testing build. */
export function chromeBinaryName(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  if (platform === 'win32') return 'chrome.exe'
  return 'chrome'
}

/**
 * Pick the Stable Chrome download for a platform out of the CfT index.
 * @param {object} index parsed last-known-good-versions-with-downloads.json
 * @param {string} platform Chrome for Testing platform id
 * @param {string} [channel] Stable / Beta / Dev / Canary
 * @returns {{version: string, url: string}}
 */
export function pickChromeDownload(index, platform, channel = 'Stable') {
  const entry = index?.channels?.[channel]
  if (!entry) throw new Error(`Chrome for Testing index has no "${channel}" channel`)
  const list = entry.downloads?.chrome
  if (!Array.isArray(list)) throw new Error('Chrome for Testing index has no chrome downloads')
  const match = list.find((item) => item.platform === platform)
  if (!match) throw new Error(`No Chrome for Testing build for platform "${platform}"`)
  return { version: String(entry.version), url: String(match.url) }
}

/**
 * apt package list for a distro, renamed for the 64-bit time_t transition.
 * Ubuntu 24.04+ renamed several library packages with a t64 suffix; asking for
 * the old name there makes apt refuse the whole transaction.
 * @param {{id?: string, versionId?: string}} os parsed /etc/os-release
 */
export function aptDeps(os = {}) {
  const id = String(os.id || 'ubuntu').toLowerCase()
  const major = Number(String(os.versionId || '0').split('.')[0])
  const needsT64 = id === 'ubuntu' ? major >= 24 : id === 'debian' ? major >= 13 : false
  if (!needsT64) return [...CHROME_APT_DEPS]
  const renamed = {
    'libasound2': 'libasound2t64',
    'libatk1.0-0': 'libatk1.0-0t64',
    'libatk-bridge2.0-0': 'libatk-bridge2.0-0t64',
    'libcups2': 'libcups2t64',
    'libatspi2.0-0': 'libatspi2.0-0t64',
    'libpango-1.0-0': 'libpango-1.0-0',
  }
  return CHROME_APT_DEPS.map((name) => renamed[name] ?? name)
}

/** Parse /etc/os-release into {id, versionId}. */
export function parseOsRelease(text) {
  const out = {}
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([A-Z_]+)=(.*)$/.exec(line.trim())
    if (!match) continue
    const key = match[1]
    const value = match[2].replace(/^"(.*)"$/, '$1')
    if (key === 'ID') out.id = value
    if (key === 'VERSION_ID') out.versionId = value
  }
  return out
}

/**
 * Mirror bases that carry the same Chrome for Testing builds.
 *
 * `storage.googleapis.com` — where the official index points — is unreachable
 * from mainland China (and from plenty of mainland-hosted servers), while the
 * version index itself often is. Without a mirror the installer resolves a
 * version and then fails on the download, which is the worst failure mode.
 */
export const CHROME_MIRROR_BASES = [
  'https://cdn.npmmirror.com/binaries/chrome-for-testing',
  'https://registry.npmmirror.com/-/binary/chrome-for-testing',
]

/** The official download URL pattern for an explicit version. */
export function officialChromeUrl(version, platform) {
  return `https://storage.googleapis.com/chrome-for-testing-public/${version}/${platform}/chrome-${platform}.zip`
}

/**
 * Every URL worth trying for one build, best first.
 * @param {string} version
 * @param {string} platform
 * @param {{official?: string, mirrors?: string[]}} [options]
 * @returns {string[]}
 */
export function chromeDownloadUrls(version, platform, options = {}) {
  const mirrors = options.mirrors ?? CHROME_MIRROR_BASES
  const urls = []
  if (options.official) urls.push(options.official)
  else urls.push(officialChromeUrl(version, platform))
  for (const base of mirrors) {
    if (!base) continue
    urls.push(`${String(base).replace(/\/+$/, '')}/${version}/${platform}/chrome-${platform}.zip`)
  }
  return [...new Set(urls)]
}

/**
 * Highest version in a mirror directory listing (`[{name: "153.0.1.2/"}]`).
 * @param {Array<{name?: string}>} entries
 * @returns {string} '' when nothing parses
 */
export function pickHighestVersion(entries) {
  const versions = (Array.isArray(entries) ? entries : [])
    .map((entry) => String(entry?.name ?? '').replace(/\/$/, ''))
    .filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name))
    .map((name) => ({ name, parts: name.split('.').map(Number) }))
    .sort((a, b) => {
      for (let index = 0; index < 4; index += 1) {
        if (a.parts[index] !== b.parts[index]) return b.parts[index] - a.parts[index]
      }
      return 0
    })
  return versions[0]?.name ?? ''
}

/**
 * The profile patch block that turns the Bot browser on.
 * @param {{playwrightUrl: string, executablePath: string, headless?: boolean, plugin?: string}} options
 */
export function buildBotRow({ playwrightUrl, executablePath, headless = true, plugin = 'refs' }) {
  return [
    '# Bot browser: real Chrome via playwright-core, installed by',
    '# scripts/setup-browser.mjs. playwrightUrl points at the proxy shim so',
    '# launch flags (proxy, no automation banner) apply without patching ds-bot.',
    '- id: bot',
    '  name: ds-bot',
    '  config:',
    `    browserPlugin: ${plugin}`,
    `    browserHeadless: ${headless}`,
    `    playwrightUrl: ${playwrightUrl}`,
    `    browserExecutablePath: ${executablePath}`,
  ].join('\n')
}

/**
 * Insert or replace the `- id: bot` block in a patch file.
 * DSH replaces a matched row's whole config, so replacing the block is the
 * correct semantics, not merging into it.
 * @param {string} text existing patch yaml ('' for a new file)
 * @param {string} block the block from buildBotRow
 * @returns {string}
 */
export function upsertBotRow(text, block) {
  const lines = String(text ?? '').split(/\r?\n/)
  const blockLines = String(block).replace(/\s+$/, '').split(/\r?\n/)
  const start = lines.findIndex((line) => /^- id:\s*bot\s*$/.test(line))

  let result
  if (start === -1) {
    const body = String(text ?? '').replace(/\s+$/, '')
    result = body ? `${body}\n\n${blockLines.join('\n')}\n` : `${blockLines.join('\n')}\n`
  } else {
    // The block carries its own comment header directly above `- id: bot`.
    // Absorb it, otherwise a second run keeps the old header and stacks a new
    // one on top, which is how a patch file grows duplicates.
    let headStart = start
    while (headStart > 0 && /^\s*#/.test(lines[headStart - 1])) headStart -= 1

    let end = lines.length
    for (let index = start + 1; index < lines.length; index += 1) {
      if (/^-\s/.test(lines[index])) { end = index; break }
    }
    const head = lines.slice(0, headStart)
    const tail = lines.slice(end)
    while (head.length && head[head.length - 1].trim() === '') head.pop()
    result = [...head, ...blockLines, ...(tail.length ? ['', ...tail] : [])].join('\n')
    result = `${result.replace(/\s+$/, '')}\n`
  }
  return result.replace(/\n{3,}/g, '\n\n')
}

/** Resolve the install root for this platform. */
export function defaultPrefix(platform = process.platform, env = process.env) {
  if (env.DSBOT_BROWSER_HOME) return env.DSBOT_BROWSER_HOME
  if (platform === 'win32') return join(env.LOCALAPPDATA || homedir(), 'dsbot-browser')
  return '/opt/dsbot-browser'
}

/** Find the DSH profile directory to patch. */
export function findProfileDir(explicit, env = process.env) {
  if (explicit) return resolve(String(explicit))
  const home = env.DSH_HOME || join(homedir(), '.dsh')
  const web = join(home, 'profiles', 'web')
  return web
}

const isWindows = process.platform === 'win32'

function log(message) { console.log(message) }
function step(title) { console.log(`\n== ${title}`) }

/** Run a command, inheriting stdio, returning {ok, status}. */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.quiet ? 'pipe' : 'inherit', encoding: 'utf8', ...options })
  return { ok: result.status === 0, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

/** Is this command on PATH? */
function has(command) {
  const probe = isWindows ? 'where' : 'which'
  return run(probe, [command], { quiet: true }).ok
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`)
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(destination, buffer)
  return buffer.length
}

function extractZip(zip, destination) {
  mkdirSync(destination, { recursive: true })
  if (!isWindows && has('unzip')) {
    const result = run('unzip', ['-q', '-o', zip, '-d', destination])
    if (!result.ok) throw new Error('unzip failed')
    return
  }
  if (isWindows) {
    const result = run('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${destination}' -Force`])
    if (!result.ok) throw new Error('Expand-Archive failed')
    return
  }
  throw new Error('No unzip available; install unzip and retry')
}

/** Chrome for Testing ships without exec bits after a zip round-trip. */
function fixExecBits(chromeDir) {
  if (isWindows) return
  const targets = ['chrome', 'chrome_crashpad_handler', 'chrome_sandbox']
  for (const name of targets) {
    const file = join(chromeDir, name)
    if (!existsSync(file)) continue
    try { chmodSync(file, 0o755) } catch { /* best effort */ }
  }
}

async function fetchJson(url) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

/** Ask a mirror which versions it carries, when the official index is unreachable. */
async function versionFromMirror(mirror, log) {
  for (const base of [mirror, ...CHROME_MIRROR_BASES].filter(Boolean)) {
    try {
      const listing = await fetchJson(`${String(base).replace(/\/+$/, '')}/`)
      const version = pickHighestVersion(listing)
      if (version) { log(`  version ${version} from mirror ${base}`); return version }
    } catch { /* try the next mirror */ }
  }
  return ''
}

/** Download the first URL that answers, reporting every failure on the way. */
async function downloadWithFallback(urls, destination, log) {
  const failures = []
  for (const url of urls) {
    try {
      const bytes = await download(url, destination)
      log(`  downloaded ${(bytes / 1024 / 1024).toFixed(1)} MB from ${new URL(url).host}`)
      return bytes
    } catch (error) {
      failures.push(`${new URL(url).host}: ${error?.message ?? error}`)
      log(`  ${new URL(url).host} failed, trying the next source`)
    }
  }
  throw new Error(`every download source failed:\n    ${failures.join('\n    ')}`)
}

async function ensureChrome({ prefix, version, zipPath, dryRun, mirror, noMirror, log }) {
  const target = join(prefix, 'chrome')
  const binary = join(target, chromeBinaryName())
  if (existsSync(binary)) {
    log(`  Chrome already present: ${binary}`)
    return binary
  }
  if (dryRun) {
    log(`  would install Chrome into ${target}`)
    return binary
  }

  const platform = chromePlatform()
  let source = zipPath ? resolve(String(zipPath)) : ''
  let resolvedVersion = version || ''

  if (!source) {
    let officialUrl = ''
    try {
      const index = await fetchJson(CFT_INDEX_URL)
      if (version) {
        officialUrl = officialChromeUrl(version, platform)
      } else {
        const picked = pickChromeDownload(index, platform)
        resolvedVersion = picked.version
        officialUrl = picked.url
      }
    } catch (error) {
      log(`  official index unavailable (${error?.message ?? error})`)
      if (!resolvedVersion) resolvedVersion = await versionFromMirror(mirror, log)
      if (!resolvedVersion) throw new Error('cannot resolve a Chrome version; pass --chrome-version')
    }

    const mirrors = noMirror ? [] : [mirror, ...CHROME_MIRROR_BASES].filter(Boolean)
    const urls = chromeDownloadUrls(resolvedVersion, platform, { official: officialUrl, mirrors })
    log(`  downloading Chrome for Testing ${resolvedVersion} (${platform})`)
    source = join(tmpdir(), `chrome-${platform}-${resolvedVersion}.zip`)
    await downloadWithFallback(urls, source, log)
  }

  const staging = join(tmpdir(), `chrome-extract-${Date.now()}`)
  extractZip(source, staging)
  const inner = join(staging, `chrome-${platform}`)
  const from = existsSync(inner) ? inner : staging
  mkdirSync(prefix, { recursive: true })
  rmSync(target, { recursive: true, force: true })
  try {
    renameSync(from, target)
  } catch {
    cpSync(from, target, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
  rmSync(staging, { recursive: true, force: true })
  fixExecBits(target)

  if (!existsSync(binary)) throw new Error(`Chrome binary missing after extract: ${binary}`)
  log(`  installed: ${binary}`)
  return binary
}

function ensureDeps({ skipDeps, dryRun }) {
  if (isWindows || process.platform === 'darwin') { log('  skipped (not Linux)'); return true }
  if (skipDeps) { log('  skipped (--skip-deps)'); return true }

  let os = { id: 'ubuntu', versionId: '22.04' }
  try { os = parseOsRelease(readFileSync('/etc/os-release', 'utf8')) } catch { /* keep default */ }
  const packages = aptDeps(os)
  log(`  packages: ${packages.join(' ')}`)
  if (dryRun) { log('  would run apt-get install'); return true }

  const sudo = typeof process.getuid === 'function' && process.getuid() !== 0 ? ['sudo'] : []
  const base = [...sudo, 'apt-get']
  const install = (list) => run(base[0], [...base.slice(1), 'install', '-y', ...list], { quiet: true })

  const all = install(packages)
  if (all.ok) { log('  system libraries ready'); return true }

  // One unknown package name must not roll back the whole transaction.
  log('  batch install failed, retrying package by package')
  const failed = []
  for (const name of packages) {
    if (!install([name]).ok) failed.push(name)
  }
  if (failed.length) log(`  still missing (may be optional): ${failed.join(' ')}`)
  else log('  system libraries ready')
  return true
}

function ensurePlaywright({ prefix, dryRun, skipPlaywright }) {
  const dir = join(prefix, 'pw')
  const core = join(dir, 'node_modules', 'playwright-core', 'index.js')
  if (existsSync(core)) { log(`  playwright-core already present: ${core}`); return dir }
  if (skipPlaywright) { log('  skipped (--skip-playwright)'); return dir }
  if (dryRun) { log(`  would npm install playwright-core into ${dir}`); return dir }

  if (!has('npm')) throw new Error('npm not found; install Node.js >= 20 first')
  mkdirSync(dir, { recursive: true })
  // A fresh package.json keeps npm away from any parent pnpm `link:` protocol.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsbot-browser-pw',
    private: true,
    version: '1.0.0',
    description: 'playwright-core for the DSBot Bot browser',
  }, null, 2) + '\n')

  const result = run('npm', ['install', '--no-audit', '--no-fund', `playwright-core@${DEFAULT_PLAYWRIGHT_CORE}`], { cwd: dir })
  if (!result.ok) throw new Error('npm install playwright-core failed')
  if (!existsSync(core)) throw new Error(`playwright-core missing after install: ${core}`)
  log(`  installed: ${core}`)
  return dir
}

function installShim({ prefix, proxy, bypass, dryRun }) {
  const dir = join(prefix, 'pw')
  const target = join(dir, 'pw-proxy-shim.mjs')
  if (!dryRun) {
    mkdirSync(dir, { recursive: true })
    copyFileSync(join(here, 'pw-proxy-shim.mjs'), target)
    const configFile = join(dir, 'browser-proxy.json')
    if (proxy) {
      writeFileSync(configFile, JSON.stringify({ proxy, bypass }, null, 2) + '\n')
      log(`  proxy ${proxy} (bypass ${bypass})`)
    } else if (existsSync(configFile)) {
      log(`  kept existing ${configFile}`)
    } else {
      log('  no proxy configured (direct)')
    }
  }
  log(`  shim: ${target}`)
  return target
}

function verify({ chrome, shim, url, egress, timeout }) {
  const args = [join(here, 'verify-browser.mjs'), '--chrome', chrome, '--shim', shim, '--url', url, '--timeout', String(timeout)]
  if (egress) args.push('--egress', egress)
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  let parsed
  try { parsed = JSON.parse(output.slice(output.indexOf('{'))) } catch { parsed = null }
  return { ok: result.status === 0, parsed, output }
}

function patchProfile({ profileDir, block, dryRun, noPatch }) {
  if (noPatch) { log('  skipped (--no-patch)'); return }
  const file = join(profileDir, 'cordis.patch.yml')
  if (dryRun) { log(`  would upsert "- id: bot" in ${file}`); return }
  if (!existsSync(profileDir)) {
    log(`  profile not found: ${profileDir}`)
    log('  create it with `dsh web` once, then re-run; the YAML block is printed below')
    log(`\n${block}\n`)
    return
  }
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
  const next = upsertBotRow(existing, block)
  if (next === existing) { log(`  already up to date: ${file}`); return }
  if (existing) {
    const backup = `${file}.bak.${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`
    writeFileSync(backup, existing)
    log(`  backup: ${backup}`)
  }
  writeFileSync(file, next)
  log(`  patched: ${file}`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.h) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*?/, '').replace(/^ \* ?/gm, ''))
    return 0
  }

  const prefix = resolve(String(args.prefix && args.prefix !== true ? args.prefix : defaultPrefix()))
  const proxy = typeof args.proxy === 'string' ? args.proxy.trim() : ''
  const bypass = typeof args.bypass === 'string' ? args.bypass : 'localhost,127.0.0.1,::1'
  const dryRun = Boolean(args['dry-run'])
  const url = typeof args.url === 'string' ? args.url : 'https://example.com'
  const egress = typeof args.egress === 'string' ? args.egress : ''
  const timeout = Number(args.timeout) > 0 ? Number(args.timeout) : 30000
  const profileDir = findProfileDir(args.profile && args.profile !== true ? args.profile : '')

  log(`DSBot browser setup${dryRun ? ' (dry run)' : ''}`)
  log(`  platform: ${process.platform}/${process.arch} -> ${chromePlatform()}`)
  log(`  prefix:   ${prefix}`)
  log(`  profile:  ${profileDir}`)

  const shimPath = join(prefix, 'pw', 'pw-proxy-shim.mjs')
  const chromePath = join(prefix, 'chrome', chromeBinaryName())
  const block = buildBotRow({
    playwrightUrl: pathToFileURL(shimPath).href,
    executablePath: chromePath,
    headless: true,
    plugin: 'refs',
  })

  if (args['print-config']) { log(`\n${block}\n`); return 0 }

  if (args['verify-only']) {
    step('verify')
    if (!existsSync(chromePath)) throw new Error(`Chrome not found: ${chromePath}`)
    if (!existsSync(shimPath)) throw new Error(`Shim not found: ${shimPath}`)
    const result = verify({ chrome: chromePath, shim: shimPath, url, egress, timeout })
    log(result.output)
    return result.ok ? 0 : 1
  }

  step('1/5 Chrome for Testing')
  const chrome = await ensureChrome({
    prefix,
    version: typeof args['chrome-version'] === 'string' ? args['chrome-version'] : '',
    zipPath: typeof args['chrome-zip'] === 'string' ? args['chrome-zip'] : '',
    mirror: typeof args.mirror === 'string' ? args.mirror : '',
    noMirror: Boolean(args['no-mirror']),
    dryRun,
    log,
  })

  step('2/5 system libraries')
  ensureDeps({ skipDeps: Boolean(args['skip-deps']), dryRun })

  step('3/5 playwright-core')
  ensurePlaywright({ prefix, dryRun, skipPlaywright: Boolean(args['skip-playwright']) })

  step('4/5 proxy shim')
  const shim = installShim({ prefix, proxy, bypass, dryRun })

  let verified = true
  if (args['no-verify'] || dryRun) {
    step('5/5 verify (skipped)')
  } else {
    step('5/5 verify')
    const result = verify({ chrome, shim, url, egress, timeout })
    log(`  ${result.parsed ? JSON.stringify(result.parsed) : result.output}`)
    verified = result.ok
    if (!verified) log('  the browser did not complete a page load; see the error above')
  }

  step('profile patch')
  patchProfile({ profileDir, block, dryRun, noPatch: Boolean(args['no-patch']) })

  log('\nDone.')
  if (!args['no-patch']) {
    log(`Restart the DSH web service to pick up the new row, then ask a Bot to open a page.`)
  }
  log(`Doctor any time: node ${join(here, 'verify-browser.mjs')} --chrome "${chrome}" --shim "${shim}"`)
  return verified ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(`\nFailed: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
