// dsh-mobile-pwa — Cordis plugin entry (DeepSeek Harness 0.2.x)
//
// Spawns the enhanced LAN/remote PWA gateway (lib/lan-gate-server.cjs) as an
// isolated child process, reverse-proxying the local DSH Web UI with:
//   - secure remote access (first-visit approval, one-token-per-browser, rate limit)
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

function envInt(name) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Resolve the DSH Web UI address the gateway must proxy to.
 *
 * Preference order: explicit env override, then the live `webStartup` service
 * (authoritative for `dsh web --host/--port`), then the documented defaults.
 * The service may mount after this plugin does, so it is polled for a while.
 */
async function resolveTarget(ctx) {
  const envHost = process.env.LAN_GATE_TARGET_HOST
  const envPort = envInt('LAN_GATE_TARGET_PORT')
  const deadline = Date.now() + 20000

  for (;;) {
    const startup = ctx.get('webStartup')
    if (startup && (startup.port !== undefined || startup.host !== undefined)) {
      const host = envHost || startup.host || DEFAULT_TARGET_HOST
      const port = envPort || startup.port || DEFAULT_TARGET_PORT
      return { host, port, source: 'webStartup' }
    }
    if (envHost && envPort) return { host: envHost, port: envPort, source: 'env' }
    if (Date.now() > deadline) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  const host = envHost || DEFAULT_TARGET_HOST
  const port = envPort || DEFAULT_TARGET_PORT
  return { host, port, source: envHost || envPort ? 'env' : 'default' }
}

export function apply(ctx) {
  let handle = null
  let disposed = false

  const start = async () => {
    try {
      const target = await resolveTarget(ctx)
      const nodePath = await ctx.subprocess.resolveExecutable('node')

      // DSH 0.2 scrubs the child environment, so every value the gateway reads
      // has to be handed over explicitly.
      const env = {
        LAN_GATE_TARGET_HOST: target.host,
        LAN_GATE_TARGET_PORT: String(target.port)
      }
      for (const key of [
        'LAN_GATE_PORT',
        'LAN_GATE_HOST',
        'LAN_GATE_RATE_LIMIT',
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
        `[dsh-mobile-pwa] gateway starting -> ${target.host}:${target.port} (${target.source})`
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
      const schedule = typeof ctx.timeout === 'function'
        ? ctx.timeout(report, 1500)
        : (ctx.get('timer') && ctx.get('timer').timeout(report, 1500))
    } catch (err) {
      console.error(`[dsh-mobile-pwa] ${String((err && err.message) || err)}`)
    }
  }

  start()

  ctx.effect(() => {
    return () => {
      disposed = true
      if (handle) {
        try { handle.terminate() } catch (e) { /* ignore */ }
      }
    }
  })

  return () => { disposed = true }
}
