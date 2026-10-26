#!/usr/bin/env node
/**
 * Give an existing xray install a working split route: China direct, rest proxied.
 *
 * Why this exists
 * ---------------
 * A stock xray config often ships one unconditional rule
 * (`{"type":"field","outboundTag":"proxy"}`), which means *everything* goes
 * through the proxy — including Chinese sites, which then crawl or time out
 * because the traffic leaves the country and comes back. The other classic
 * mistake is `domainStrategy: "IPIfNonMatch"`, which resolves every domain first
 * (through the proxy) and can deadlock before any rule matches.
 *
 * This script rewrites only `routing` and guarantees `direct` / `block`
 * outbounds exist. It never touches inbound or outbound credentials, it backs up
 * the file before writing, and it refuses to install a config that fails
 * `xray -test`.
 *
 *   sudo node scripts/xray-split-route.mjs              # patch + verify
 *   sudo node scripts/xray-split-route.mjs --dry-run     # show the plan only
 *   node scripts/xray-split-route.mjs --config ./x.json  # patch any file
 *
 * Options
 *   --config <file>   xray config (default /usr/local/etc/xray/config.json)
 *   --geo-dir <dir>   where geoip.dat / geosite.dat live (default /usr/local/share/xray)
 *   --no-geo          do not download missing geo files
 *   --no-test         skip `xray -test`
 *   --dry-run         print the resulting routing block, write nothing
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))

export const GEO_SOURCES = {
  'geoip.dat': 'https://github.com/v2fly/geoip/releases/latest/download/geoip.dat',
  'geosite.dat': 'https://github.com/v2fly/domain-list-community/releases/latest/download/geosite.dat',
}

/** Rule fields that actually match traffic. A rule with none of them is a catch-all. */
const MATCHER_KEYS = ['domain', 'ip', 'port', 'source', 'user', 'inboundTag', 'protocol', 'attrs', 'network', 'sourcePort']

/** The rules this script owns, in evaluation order. */
export function splitRules(directTag = 'direct') {
  return [
    { type: 'field', domain: ['geosite:cn'], outboundTag: directTag },
    { type: 'field', ip: ['geoip:cn', 'geoip:private'], outboundTag: directTag },
  ]
}

/** Does this rule already match every value on that matcher? */
export function covers(rule, matcher, values) {
  const list = Array.isArray(rule?.[matcher]) ? rule[matcher] : []
  return values.every((value) => list.includes(value))
}

/** A rule that matches everything and therefore shadows every later rule. */
export function isCatchAll(rule) {
  if (!rule || typeof rule !== 'object') return false
  return !MATCHER_KEYS.some((key) => Array.isArray(rule[key]) ? rule[key].length > 0 : rule[key] !== undefined)
}

/** Tag of the outbound that is not direct/block, i.e. the proxy itself. */
export function proxyTag(outbounds = []) {
  const found = outbounds.find((entry) => entry && entry.tag && entry.tag !== 'direct' && entry.tag !== 'block' && entry.protocol !== 'freedom' && entry.protocol !== 'blackhole')
  return found?.tag
}

/**
 * Rewrite a config's routing for split traffic. Pure: returns a new object.
 * @param {object} config parsed xray config.json
 * @param {{directTag?: string, proxyTag?: string}} [options]
 * @returns {{config: object, changed: boolean, notes: string[]}}
 */
export function applySplitRouting(config, options = {}) {
  if (!config || typeof config !== 'object') throw new Error('config must be an object')
  const next = JSON.parse(JSON.stringify(config))
  const notes = []
  const before = JSON.stringify(config)

  const outbounds = Array.isArray(next.outbounds) ? next.outbounds : []
  const directTag = options.directTag
    ?? outbounds.find((entry) => entry?.tag === 'direct')?.tag
    ?? 'direct'
  const blockTag = outbounds.find((entry) => entry?.tag === 'block')?.tag ?? 'block'

  if (!outbounds.some((entry) => entry?.tag === directTag)) {
    outbounds.push({ tag: directTag, protocol: 'freedom', settings: {} })
    notes.push(`added outbound "${directTag}" (freedom)`)
  }
  next.outbounds = outbounds

  const fallbackTag = options.proxyTag ?? proxyTag(outbounds)
  const routing = next.routing && typeof next.routing === 'object' ? next.routing : {}
  const rules = Array.isArray(routing.rules) ? routing.rules : []

  // Only add `block` when a rule actually routes to it: an unreferenced
  // outbound is noise in a config the user reads by hand.
  const referencesBlock = rules.some((rule) => rule?.outboundTag === blockTag)
  if (referencesBlock && !outbounds.some((entry) => entry?.tag === blockTag)) {
    outbounds.push({ tag: blockTag, protocol: 'blackhole', settings: {} })
    notes.push(`added outbound "${blockTag}" (blackhole)`)
  }

  const kept = []
  for (const rule of rules) {
    if (isCatchAll(rule)) {
      notes.push(`dropped catch-all rule -> ${rule.outboundTag ?? '(no outbound)'}`)
      continue
    }
    kept.push(rule)
  }

  // Add only what is genuinely missing. An existing direct rule that already
  // lists `geosite:cn` (or `geoip:cn` / `geoip:private`) is left exactly as the
  // user wrote it — a hand-tuned config must not be reordered just because this
  // script would have grouped the same values differently.
  const directRules = rules.filter((rule) => rule?.outboundTag === directTag)
  const missingDomain = !directRules.some((rule) => covers(rule, 'domain', ['geosite:cn']))
  const missingCnIp = !directRules.some((rule) => covers(rule, 'ip', ['geoip:cn']))
  const missingPrivate = !directRules.some((rule) => covers(rule, 'ip', ['geoip:private']))

  const additions = []
  if (missingDomain) additions.push(splitRules(directTag)[0])
  if (missingCnIp || missingPrivate) {
    const ip = [...(missingCnIp ? ['geoip:cn'] : []), ...(missingPrivate ? ['geoip:private'] : [])]
    additions.push({ type: 'field', ip, outboundTag: directTag })
  }

  routing.domainStrategy = 'IPOnDemand'
  routing.rules = [...additions, ...kept]

  // If nothing routes to the proxy any more, restore one explicit final rule so
  // the config still behaves like a proxy instead of silently going direct.
  const reachesProxy = fallbackTag && routing.rules.some((rule) => rule.outboundTag === fallbackTag)
  if (fallbackTag && !reachesProxy) {
    routing.rules.push({ type: 'field', network: 'tcp,udp', outboundTag: fallbackTag })
    notes.push(`re-added final rule -> ${fallbackTag}`)
  }

  next.routing = routing
  const changed = JSON.stringify(next) !== before
  if (changed && notes.length === 0) notes.push('rewrote routing rules')
  return { config: next, changed, notes }
}

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

function log(message) { console.log(message) }
function step(title) { console.log(`\n== ${title}`) }

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`)
  writeFileSync(destination, Buffer.from(await response.arrayBuffer()))
}

async function ensureGeo(geoDir, enabled) {
  mkdirSync(geoDir, { recursive: true })
  for (const [name, url] of Object.entries(GEO_SOURCES)) {
    const file = join(geoDir, name)
    if (existsSync(file)) { log(`  ${name} present (${(readFileSync(file).length / 1024).toFixed(0)} KB)`); continue }
    if (!enabled) { log(`  ${name} missing and --no-geo set`); continue }
    log(`  downloading ${name}`)
    await download(url, file)
    log(`  ${name} -> ${file} (${(readFileSync(file).length / 1024).toFixed(0)} KB)`)
  }
}

function xrayTest(configFile) {
  const probe = spawnSync('xray', ['-test', '-config', configFile], { encoding: 'utf8' })
  if (probe.error) return { ok: false, output: `xray not found: ${probe.error.message}` }
  const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim()
  return { ok: probe.status === 0, output }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const configFile = resolve(typeof args.config === 'string' ? args.config : '/usr/local/etc/xray/config.json')
  const geoDir = resolve(typeof args['geo-dir'] === 'string' ? args['geo-dir'] : '/usr/local/share/xray')
  const dryRun = Boolean(args['dry-run'])

  log(`xray split route${dryRun ? ' (dry run)' : ''}`)
  log(`  config:  ${configFile}`)
  log(`  geo dir: ${geoDir}`)

  if (!existsSync(configFile)) throw new Error(`config not found: ${configFile}`)
  const original = readFileSync(configFile, 'utf8')
  const parsed = JSON.parse(original)

  step('geo data')
  if (!dryRun) await ensureGeo(geoDir, !args['no-geo'])
  else log('  skipped in dry run')

  step('routing')
  const { config, changed, notes } = applySplitRouting(parsed)
  for (const note of notes) log(`  ${note}`)
  if (!changed) log('  already split-routed, nothing to do')
  log(`\n${JSON.stringify(config.routing, null, 2)}\n`)

  if (dryRun) { log('dry run: nothing written'); return 0 }
  if (!changed) return 0

  const backup = `${configFile}.bak.${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '')}`
  copyFileSync(configFile, backup)
  log(`  backup: ${backup}`)
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n')
  log(`  written: ${configFile}`)

  if (!args['no-test']) {
    step('xray -test')
    const result = xrayTest(configFile)
    log(`  ${result.output.split('\n').slice(-3).join('\n  ')}`)
    if (!result.ok) {
      copyFileSync(backup, configFile)
      log('  config failed validation, restored the backup')
      return 1
    }
  }

  log('\nDone. Restart the proxy:')
  log('  systemctl restart xray    # or: xray run -config ' + configFile)
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(`\nFailed: ${error?.message ?? error}`)
    process.exitCode = 1
  }
}
