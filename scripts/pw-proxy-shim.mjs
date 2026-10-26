/**
 * Portable Playwright shim for the ds-bot browser plugin.
 *
 * Why this exists
 * ---------------
 * ds-bot launches Chromium with a hardcoded `args: ['--disable-dev-shm-usage']`
 * (src/host/browser/session.js) and exposes no proxy setting, so a Bot browser
 * can only reach whatever the host itself can reach directly. A shim is the
 * supported seam: ds-bot accepts `playwrightUrl` and does `await import(url)`,
 * reading only `.chromium` off the module. Pointing that at this file lets us
 * add launch flags without patching ds-bot or depending on anything internal.
 *
 * What it adds
 * ------------
 *   --proxy-server=<proxy>        when a proxy is configured
 *   --proxy-bypass-list=<list>    loopback never goes through the proxy
 *   --disable-blink-features=AutomationControlled
 *                                 no `navigator.webdriver`, no automation banner
 *
 * Proxy resolution (first hit wins, empty means "no proxy")
 * --------------------------------------------------------
 *   1. process.env.DSBOT_BROWSER_PROXY
 *   2. browser-proxy.json next to this file: {"proxy": "...", "bypass": "..."}
 *   3. none — Chromium launches exactly as ds-bot asked
 *
 * The JSON file matters because DSH scrubs the child environment: a file
 * written by scripts/setup-browser.mjs survives a systemd restart, an exported
 * variable does not.
 *
 * playwright-core resolution (first hit wins)
 * -------------------------------------------
 *   1. process.env.DSBOT_PLAYWRIGHT_CORE (package dir or index.js)
 *   2. ./node_modules/playwright-core next to this file
 *   3. the ordinary `playwright-core` module resolution
 *
 * Loading is lazy so this file stays importable (and testable) on a machine
 * with no Playwright installed.
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

export const CONFIG_FILE = join(here, 'browser-proxy.json')

const DEFAULT_BYPASS = 'localhost,127.0.0.1,::1'

/** Values that mean "do not use a proxy" rather than "proxy at this address". */
const OFF_TOKENS = new Set(['off', 'none', 'no', '0', 'false', 'direct'])

/** Read browser-proxy.json, tolerating a missing or malformed file. */
function readConfigFile(file = CONFIG_FILE) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Resolve the proxy settings for this process.
 * An unset or empty value falls through to the next source; an explicit
 * "off" / "none" / "direct" turns the proxy off and stops the fallback, which is
 * what `--no-proxy` needs once browser-proxy.json exists.
 * @param {{env?: Record<string,string|undefined>, config?: object}} [sources]
 * @returns {{proxy: string, bypass: string}} proxy is '' when disabled
 */
export function resolveProxy({ env = process.env, config = readConfigFile() } = {}) {
  const rawEnv = typeof env.DSBOT_BROWSER_PROXY === 'string' ? env.DSBOT_BROWSER_PROXY.trim() : ''
  const rawFile = typeof config.proxy === 'string' ? config.proxy.trim() : ''
  const disabled = OFF_TOKENS.has(rawEnv.toLowerCase()) || OFF_TOKENS.has(rawFile.toLowerCase())

  const proxy = disabled ? '' : rawEnv || rawFile
  const bypassFromEnv = typeof env.DSBOT_BROWSER_PROXY_BYPASS === 'string' ? env.DSBOT_BROWSER_PROXY_BYPASS.trim() : ''
  const bypassFromFile = typeof config.bypass === 'string' ? config.bypass.trim() : ''
  return { proxy, bypass: bypassFromEnv || bypassFromFile || DEFAULT_BYPASS }
}

/**
 * Merge our launch flags into an existing Playwright options object.
 * @param {string[]} args existing Chromium args
 * @param {{proxy: string, bypass: string}} settings
 * @returns {string[]} args including our flags, without duplicates
 */
export function buildArgs(args, settings) {
  const base = Array.isArray(args) ? args.slice() : []
  const extra = ['--disable-blink-features=AutomationControlled']
  if (settings.proxy) {
    extra.unshift(`--proxy-server=${settings.proxy}`, `--proxy-bypass-list=${settings.bypass}`)
  }
  const seen = new Set(base.map((entry) => String(entry).split('=')[0]))
  const fresh = extra.filter((entry) => !seen.has(entry.split('=')[0]))
  return [...base, ...fresh]
}

/** Apply buildArgs to a Playwright launch call's argument list, in place. */
export function patchLaunchArgs(args, settings = resolveProxy()) {
  const last = args[args.length - 1]
  const looksLikeOptions = last && typeof last === 'object' && !Array.isArray(last)
  if (looksLikeOptions) {
    last.args = buildArgs(last.args, settings)
  } else {
    args.push({ args: buildArgs([], settings) })
  }
  return args
}

let core

/**
 * Load playwright-core and patch its launchers once.
 * @returns the playwright-core module
 */
export function loadCore() {
  if (core) return core
  const explicit = process.env.DSBOT_PLAYWRIGHT_CORE
  const candidates = []
  if (explicit) candidates.push(explicit, join(explicit, 'index.js'))
  candidates.push(join(here, 'node_modules', 'playwright-core', 'index.js'))

  let loaded
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    loaded = require(candidate)
    break
  }
  if (!loaded) loaded = require('playwright-core')

  const settings = resolveProxy()
  const chromium = loaded.chromium
  for (const kind of ['launchPersistentContext', 'launch']) {
    const original = chromium[kind]
    if (typeof original !== 'function') continue
    chromium[kind] = function patched(...args) {
      return original.apply(this, patchLaunchArgs(args, settings))
    }
  }
  core = loaded
  return core
}

/**
 * A lazy stand-in for playwright-core's `chromium`: nothing is loaded until a
 * property is read, so importing this module never requires Playwright.
 */
export const chromium = new Proxy({}, {
  get(_target, key) {
    const value = loadCore().chromium[key]
    return typeof value === 'function' ? value.bind(loadCore().chromium) : value
  },
  set(_target, key, value) {
    loadCore().chromium[key] = value
    return true
  },
  has(_target, key) {
    return key in loadCore().chromium
  },
})

export default { chromium }
