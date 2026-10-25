// dsh-mobile-pwa — Cordis plugin entry (DeepSeek Harness 0.2.x)
//
// Spawns the enhanced LAN/remote PWA gateway (lib/lan-gate-server.cjs) as an
// isolated child process, reverse-proxying the local DSH Web UI with:
//   - secure remote access (first-visit approval, per-browser token, optional
//     password gate, rate limit)
//   - PWA serving (/pwa/*) + mobile layout + touch gesture + offline + notifications
//
// DSH 0.2 notes:
//   * The Web surface refuses a wildcard bind address, so the browser UI stays on
//     one concrete local address. This gateway is the sanctioned remote door:
//     DSH itself keeps listening on loopback, the gateway owns the exposed port.
//   * `ctx.subprocess` scrubs the ambient child environment (credentials and
//     DSH_* facts), so every setting the gateway needs is passed explicitly.
//   * The bound host/port come from the `webStartup` service instead of being
//     hardcoded, so `dsh web --port 0` or `--host <addr>` still works.
//   * DSH 0.2 authenticates browsers with a launch token that is exchanged for a
//     signed session cookie. The plugin reads that token from the Connection
//     service and hands it to the gateway, which mints the cookie on the
//     browser's behalf: the user opens a plain URL, never a tokenized one.
//
// Mount via cordis.patch.yml (see cordis.patch.yml.example) or `dsh plugin add`.
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const name = 'dsh-mobile-pwa'
export const inject = ['subprocess']

const here = dirname(fileURLToPath(import.meta.url))
const serverFile = join(here, 'lib', 'lan-gate-server.cjs')

const DEFAULT_TARGET_HOST = '127.0.0.1'
const DEFAULT_TARGET_PORT = 3080
const RESOLVE_TIMEOUT_MS = 20000

function envInt(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Wait for a host service to mount, without failing when it never does.
 * @param ctx - plugin context
 * @param service - service key, e.g. "webStartup" or "connection"
 * @param timeoutMs - how long to wait before giving up
 * @returns the service value, or undefined on timeout
 */
function waitForService(ctx, service, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), timeoutMs)
    try {
      ctx.inject([service], (serviceCtx) => {
        let value
        try { value = serviceCtx.get(service) } catch (e) { value = undefined }
        finish(value)
      })
    } catch (e) {
      finish(undefined)
    }
  })
}

/**
 * Resolve the DSH Web UI address the gateway must proxy to.
 *
 * Preference order: explicit env override, then the live `webStartup` service
 * (authoritative for `dsh web --host/--port`), then the documented defaults.
 */
async function resolveTarget(ctx) {
  const envHost = process.env.LAN_GATE_TARGET_HOST
  const envPort = envInt('LAN_GATE_TARGET_PORT')
  const startup = await waitForService(ctx, 'webStartup', RESOLVE_TIMEOUT_MS)
  if (startup && (startup.port !== undefined || startup.host !== undefined)) {
    const host = envHost || startup.host || DEFAULT_TARGET_HOST
    const port = envPort || startup.port || DEFAULT_TARGET_PORT
    return { host, port, source: 'webStartup' }
  }
  const host = envHost || DEFAULT_TARGET_HOST
  const port = envPort || DEFAULT_TARGET_PORT
  return { host, port, source: envHost || envPort ? 'env' : 'default' }
}

/**
 * Read DSH's process launch token from the Connection service.
 *
 * DSH mints a browser session cookie only for a request carrying this token;
 * the gateway uses it to obtain that cookie for the browser, so the launch URL
 * never has to be shared.
 *
 * @returns the launch token, or an empty string when unavailable
 */
async function resolveLaunchToken(ctx) {
  const connection = await waitForService(ctx, 'connection', RESOLVE_TIMEOUT_MS)
  if (!connection || typeof connection.authenticatedUrl !== 'function') return ''
  try {
    const base = process.env.LAN_GATE_PUBLIC_URL || 'http://127.0.0.1/'
    const url = new URL(connection.authenticatedUrl(base))
    return url.searchParams.get('token') || ''
  } catch (e) {
    return ''
  }
}

export function apply(ctx) {
  let handle = null
  let reportTimer = null

  const start = async () => {
    try {
      const [target, token] = await Promise.all([
        resolveTarget(ctx),
        resolveLaunchToken(ctx)
      ])
      const nodePath = await ctx.subprocess.resolveExecutable('node')

      // DSH 0.2 scrubs the child environment, so every value the gateway reads
      // has to be handed over explicitly.
      const env = {
        LAN_GATE_TARGET_HOST: target.host,
        LAN_GATE_TARGET_PORT: String(target.port)
      }
      if (token) env.LAN_GATE_DSH_TOKEN = token
      for (const key of [
        'LAN_GATE_PORT',
        'LAN_GATE_HOST',
        'LAN_GATE_RATE_LIMIT',
        'LAN_GATE_REWRITE_HOST',
        'LAN_GATE_PASSWORD',
        'LAN_GATE_VAPID_PUBLICKEY',
        'LAN_GATE_VAPID_PRIVATEKEY',
        'LAN_GATE_VAPID_SUBJECT',
        'DSH_HOME'
      ]) {
        const value = process.env[key]
        if (value !== undefined && value !== '') env[key] = value
      }

      handle = ctx.subprocess.spawn({
        argv: [nodePath, serverFile],
        cwd: here,
        env,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: 131072 },
          stderr: { maxBytes: 131072 }
        },
        graceMs: 3000
      })

      handle.done.then((outcome) => {
        console.log(`[dsh-mobile-pwa] gateway exited code=${outcome.exitCode} signal=${outcome.signal}`)
      }).catch((err) => {
        console.error(`[dsh-mobile-pwa] spawn failed: ${String((err && err.message) || err)}`)
      })

      console.log(
        `[dsh-mobile-pwa] gateway starting -> ${target.host}:${target.port} (${target.source})` +
        (token ? ' · dsh session bootstrap armed' : ' · dsh session bootstrap unavailable')
      )

      const report = () => {
        const out = handle && handle.collected && handle.collected.stdout
        if (out) {
          const read = out.readFrom(0)
          if (read && read.text) console.log(`[dsh-mobile-pwa] ${read.text.trim()}`)
        }
        const err = handle && handle.collected && handle.collected.stderr
        if (err) {
          const eread = err.readFrom(0)
          if (eread && eread.text) console.error(`[dsh-mobile-pwa] stderr: ${eread.text.trim()}`)
        }
      }
      reportTimer = setTimeout(report, 1500)
    } catch (err) {
      console.error(`[dsh-mobile-pwa] ${String((err && err.message) || err)}`)
    }
  }

  start()

  ctx.effect(() => {
    return () => {
      if (reportTimer) { clearTimeout(reportTimer); reportTimer = null }
      if (handle) {
        try { handle.terminate() } catch (e) { /* ignore */ }
      }
    }
  })
}
