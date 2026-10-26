#!/usr/bin/env node
/**
 * Browser self-check: does this machine actually have a working Bot browser?
 *
 * Launches Chrome the same way ds-bot does (through the proxy shim, so launch
 * flags are identical to production), opens a page, and reports what happened
 * as JSON. Exit code 0 means the browser works; 1 means it does not.
 *
 *   node scripts/verify-browser.mjs --chrome /opt/dsbot-browser/chrome/chrome \
 *     --shim /opt/dsbot-browser/pw/pw-proxy-shim.mjs --url https://example.com
 *
 * Options
 *   --chrome <path>     Chrome executable (required)
 *   --shim <path>       proxy shim module; defaults to the one beside this file
 *   --url <url>         page to open (default https://example.com)
 *   --proxy <url>       override the proxy for this run only
 *   --timeout <ms>      navigation timeout (default 30000)
 *   --retries <n>       extra attempts for the main URL (default 2) — a rented
 *                       proxy node is often flaky, which is not a browser fault
 *   --fallback <url>    URL that proves the browser itself works when the main
 *                       URL cannot be reached (default https://www.baidu.com)
 *   --no-fallback       do not try the fallback URL
 *   --no-proxy          force direct, ignoring env and browser-proxy.json
 *   --persistent <dir>  use launchPersistentContext with this profile dir, which
 *                       is the exact call ds-bot makes for a Bot, instead of a
 *                       throwaway launch()
 *   --egress <url>      extra page to read, e.g. https://api.ipify.org to see
 *                       which IP the browser really leaves from
 */
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const chrome = args.chrome && args.chrome !== true ? resolve(String(args.chrome)) : ''
  const shim = args.shim && args.shim !== true ? resolve(String(args.shim)) : join(here, 'pw-proxy-shim.mjs')
  const url = typeof args.url === 'string' ? args.url : 'https://example.com'
  const timeout = Number(args.timeout) > 0 ? Number(args.timeout) : 30000
  const retries = Number(args.retries) >= 0 ? Number(args.retries) : 2
  const fallback = args['no-fallback'] ? '' : (typeof args.fallback === 'string' ? args.fallback : 'https://www.baidu.com')

  const report = {
    ok: false, primaryOk: false, chrome, shim, url, proxy: null,
    title: null, bytes: 0, egress: null, attempts: [], error: null,
  }

  if (!chrome || !existsSync(chrome)) {
    report.error = `Chrome executable not found: ${chrome || '(missing --chrome)'}`
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }
  if (!existsSync(shim)) {
    report.error = `Proxy shim not found: ${shim}`
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }

  // The shim reads these at import time, so set them before importing it.
  if (args['no-proxy']) {
    process.env.DSBOT_BROWSER_PROXY = 'off'
    process.env.DSBOT_BROWSER_PROXY_BYPASS = ''
  } else if (typeof args.proxy === 'string') {
    process.env.DSBOT_BROWSER_PROXY = args.proxy
  }

  let session
  try {
    const shimModule = await import(pathToFileURL(shim).href)
    const { resolveProxy } = shimModule
    report.proxy = typeof resolveProxy === 'function' ? resolveProxy().proxy || null : null

    const chromium = shimModule.chromium
    const persistentDir = typeof args.persistent === 'string' ? resolve(String(args.persistent)) : ''

    if (persistentDir) {
      // ds-bot's own call: a per-Bot persistent profile, same viewport, same
      // base arg. Verifying this path is the point — launch() would miss a
      // profile-permission or cookie-store problem.
      report.persistent = persistentDir
      const context = await chromium.launchPersistentContext(persistentDir, {
        headless: true,
        viewport: { width: 1280, height: 900 },
        acceptDownloads: true,
        executablePath: chrome,
        args: ['--disable-dev-shm-usage'],
      })
      session = {
        page: context.pages()[0] ?? await context.newPage(),
        close: () => context.close(),
      }
    } else {
      const browser = await chromium.launch({
        executablePath: chrome,
        headless: true,
        args: ['--disable-dev-shm-usage'],
      })
      session = { page: await browser.newPage(), close: () => browser.close() }
    }
    const page = session.page

    /** One navigation attempt; records the outcome instead of throwing. */
    const attempt = async (target) => {
      try {
        const response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout })
        const entry = {
          url: target,
          ok: true,
          status: response ? response.status() : null,
          title: await page.title(),
          finalUrl: page.url(),
        }
        report.attempts.push(entry)
        return entry
      } catch (error) {
        report.attempts.push({ url: target, ok: false, error: error?.message ?? String(error) })
        return null
      }
    }

    let hit = null
    for (let round = 0; round <= retries && !hit; round += 1) hit = await attempt(url)

    if (hit) {
      report.primaryOk = true
      report.status = hit.status
      report.title = hit.title
      report.finalUrl = hit.finalUrl
      report.bytes = (await page.screenshot({ type: 'jpeg', quality: 70 })).length
      if (typeof args.egress === 'string') {
        await page.goto(args.egress, { waitUntil: 'domcontentloaded', timeout }).catch(() => {})
        report.egress = (await page.textContent('body').catch(() => null))?.trim().slice(0, 120) ?? null
      }
    } else if (fallback && fallback !== url) {
      // The requested site is unreachable, but that says nothing about the
      // browser. Prove the browser separately so the two failures stay distinct.
      const proof = await attempt(fallback)
      if (proof) {
        report.title = proof.title
        report.status = proof.status
        report.bytes = (await page.screenshot({ type: 'jpeg', quality: 70 })).length
        report.note = `browser works, but ${url} is unreachable through ${report.proxy || 'a direct connection'}`
      }
    }

    report.ok = report.primaryOk || report.attempts.some((entry) => entry.ok)
  } catch (error) {
    report.error = error?.message ?? String(error)
  } finally {
    if (session) await session.close().catch(() => {})
  }

  console.log(JSON.stringify(report, null, 2))
  process.exit(report.ok ? 0 : 1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
