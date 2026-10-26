# AGENTS.md — Guide for AI agents

This file helps AI coding agents and LLM tooling understand and work in this repo.

## What this repo is

`dsh-mobile-pwa` is a **Cordis bundle plugin for DeepSeek Harness (DSH) 0.2.x** that turns
the DSH Web UI into a complete mobile **PWA**. It runs a **standalone Node gateway child
process** that securely exposes the local DSH Web UI to remote phones, and injects PWA
capability (manifest, service worker, touch layout, gestures, agent-done notification)
into the served HTML.

- Gateway listens on `0.0.0.0:3088`; proxies approved devices to the DSH Web UI address.
- DSH 0.2 **refuses a wildcard bind address** (`--host 0.0.0.0` is rejected at load), so
  the Web UI always stays on one concrete local address. The gateway is the remote door:
  it owns the exposed port and the approval gate; DSH's own `/api` trust fence is intact.

## Target version

- `engines.dsh: ">=0.2.0 <0.3.0"`. DSH compares that range with `includePrerelease`, so a
  `0.2.1-rc.x` runtime satisfies it. Without this field DSH falls back to checking
  `@deepseek-ai/dsh*` peer ranges.
- DSH 0.1's Web-UI DOM is gone. The mobile CSS targets the 0.2 slot vocabulary
  (`main.conversation`, `conversation.view`, `conversation.chat.flow`,
  `conversation.input.model`, `conversation.composer.dock`, `sidebar.panellist`, ...)
  and the 0.2 data markers (`data-composer-*`, `data-chat-*`, `data-phase`).

## Layout

| Path | Role |
| --- | --- |
| `lan-gate.mjs` | Cordis entry. `inject: ['subprocess']`; resolves `node`, resolves the Web UI address from the `webStartup` service, spawns `lib/lan-gate-server.cjs`, wires disposal via `ctx.effect`. Never import the server into the DSH process. |
| `lib/lan-gate-server.cjs` | The gateway. Single-file, **zero-dependency CommonJS**. HTTP + WebSocket reverse proxy, approval state machine, tokens, rate limit, admin page, **HTML PWA injection**, `/pwa/*` static serving, `/pwa/push/*`. |
| `lib/lan-gate-auth.cjs` | Approval state machine, pure functions: an approval binds an **address**, a token binds a **browser**. Keeps the legacy single-token state file readable. |
| `lib/web-push.cjs` | Real Web Push: VAPID keypair + ES256 JWT, ECDH/HKDF derivation, AES-128-GCM body encryption. Zero dependencies, WebCrypto only. |
| `pwa/manifest.json` | PWA install manifest. |
| `pwa/sw.js` | Service worker: cache strategies, push notifications, `pushsubscriptionchange`. |
| `pwa/inject.js` | Injected page bootstrap: SW register, gesture loader, push subscribe, agent-done detection. |
| `pwa/touch-gestures.js` | Pull-to-refresh / edge-swipe / pinch-zoom. |
| `pwa/app.css` | Mobile touch-first CSS (< 44px targets, safe-area, compact type). |
| `pwa/offline.html` | Offline fallback page. |
| `pwa/icons/` | SVG source + rasterized PNGs (192/512 + maskable). |
| `cordis.patch.yml(.example)` | Bundle patch layer / static-mount example. |
| `scripts/setup-browser.mjs` | One-shot Bot browser install: Chrome for Testing (+ CN mirror fallback), apt deps (t64-aware), playwright-core, shim, verification, profile patch. Pure helpers are exported for tests. |
| `scripts/verify-browser.mjs` | Browser doctor. `--persistent <dir>` reproduces ds-bot's exact `launchPersistentContext` call. Reports `ok` (browser works) separately from `primaryOk` (that URL worked). |
| `scripts/pw-proxy-shim.mjs` | The `playwrightUrl` seam. Wraps `launch` / `launchPersistentContext` to add `--proxy-server` and drop automation flags. `playwright-core` loads **lazily**, so importing it never requires Playwright. |
| `scripts/xray-split-route.mjs` | Rewrites xray `routing` only: drop the catch-all rule, `IPOnDemand`, `geosite:cn` / `geoip:cn` → direct. Idempotent, backs up, rolls back when `xray -test` fails. |
| `docs/browser.md` | Bot browser: why the shim exists, proxy resolution, troubleshooting table. |
| `test/gateway.test.cjs` | Smoke tests (boots gateway behind a mock upstream). |
| `test/browser-setup.test.cjs` | Pure-function tests: argv, CfT platform/download/mirror, apt renames, patch upsert, proxy precedence, launch-arg merging, xray routing. |

## Key behaviours — don't break these

1. **Isolation**: the gateway is a child process. Never import its server code into
   the DSH process; keep spawn + lifecycle in `lan-gate.mjs`.
2. **Explicit child environment**: DSH 0.2's `ctx.subprocess` scrubs ambient credentials
   and `DSH_*` facts before applying the caller's `env`. Every value the gateway reads
   (`LAN_GATE_*`, `DSH_HOME`, VAPID keys) must be passed explicitly in the spawn request.
3. **`pwa/` serves the real browser scripts**: `/pwa/manifest.json`, `/pwa/sw.js`,
   `/pwa/app.css`, `/pwa/icons/*` are served from disk (read via `servePwaAsset`).
   The service worker MUST live at a fixed path (`/pwa/sw.js`) for registration to
   scope correctly.
4. **Scope mobile CSS**: every mobile rule must be prefixed with
   `html[data-lan-device="phone"]` (or the `@media (max-width:820px)` fallback that
   excludes `desktop`). Desktop must never be affected.
5. **Stable selectors**: prefer `[data-slot]`/`[data-*]`/ARIA selectors over hashed build
   class names (`Sh0Q9G_` etc.), which change per frontend build. When DSH renames a
   slot, the mobile layout silently stops applying — re-check the slot list against the
   upstream `packages/client` sources.
6. **Persistence**: approvals stored at `~/.dsh/lan-gate-state.json`; the VAPID keypair at
   `~/.dsh/lan-gate-vapid.json`; the pending list (`seen`) is in-memory and resets on restart.
7. **Approval binds an address, a token binds a browser**: never collapse them back into one
   token per address. A phone and a laptop behind the same NAT share one public address, and
   the single-token design locked the second browser out with "需要重新授权". Each browser of
   an approved device mints its own token. There is deliberately **no cap** on how many
   browsers one approved device holds — the address is what was approved.
8. **Optional password gate**: `LAN_GATE_PASSWORD` puts a login page in front of everything
   except the local-only admin endpoints. The password must never be logged, never written
   into the repository, and never sent to the browser — the browser stores an HMAC-derived
   proof (`lg_pass` cookie, HttpOnly, 30 days). The comparison is constant-time. Because
   `ctx.subprocess` scrubs the child environment, the plugin has to hand
   `LAN_GATE_PASSWORD` over explicitly.
9. **Local-only admin**: `/lan-gate/status`, `/lan-gate/action` must reject non-local
   sockets (403). `/pwa/push/send` additionally accepts an approved device, so a phone can
   report "the agent finished" for the other subscribers.
10. **Push must be encrypted**: a push service rejects a plain-text body. Use
    `lib/web-push.cjs` (`encryptPayload` + `buildVapidAuthorization`), never plain JSON.
11. **Forward the browser-facing Host**: DSH 0.2's Host/Origin fence compares the
    received Host against the accepted authorities, and the browser session cookie
    is bound to that authority. The gateway therefore forwards Host unchanged
    (override with `LAN_GATE_REWRITE_HOST=1`). The public authority must be
    trusted: `LAN_GATE_TRUSTED_HOSTS` or `--trusted-host`.
12. **Browser session bootstrap**: DSH only signs a session cookie for a request
    carrying the process launch token. The plugin reads that token from
    `ctx.connection.authenticatedUrl()` and passes it to the gateway, which
    exchanges it for the browser's cookie. Never print or require the tokenized
    launch URL.
13. **Port fallback**: on `EADDRINUSE`, server increments the port (up to +20).
14. **Injection quoting**: the HTML-injected inline CSS/JS strings in
    `lib/lan-gate-server.cjs` are JS string literals — keep quote usage consistent
    (historical bug: double quotes inside double quotes broke the injected script).
15. **Never patch ds-bot for the browser**: it hardcodes
    `args: ['--disable-dev-shm-usage']` and has no proxy option. The supported seam is
    `playwrightUrl` — ds-bot only reads `.chromium` off the imported module, so
    `scripts/pw-proxy-shim.mjs` adds flags there. Do not vendor or fork ds-bot.
16. **The shim must import without Playwright**: ds-bot imports `playwrightUrl` while
    mounting the plugin, before any browser exists. Keep `playwright-core` lazy
    (`loadCore()`), or a missing dependency becomes a plugin-mount failure.
17. **Proxy config is a file, not just env**: DSH scrubs the child environment, so
    `browser-proxy.json` next to the shim is what survives a systemd restart. An
    explicit `off`/`none`/`direct` must win over that file (`--no-proxy` depends on it).
18. **Chrome binaries need a CN mirror**: `storage.googleapis.com` is unreachable from
    mainland hosts while the version index often is, so a download must fall back
    (`cdn.npmmirror.com`, then `registry.npmmirror.com`). Never hardcode one host.
19. **Verification must separate browser from egress**: `ok` means the browser rendered
    something; `primaryOk` means the requested URL worked. A flaky rented proxy is not a
    browser bug, and conflating them sends people debugging the wrong layer.

## Common tasks

- **Change port / rate / target**: env vars `LAN_GATE_PORT`, `LAN_GATE_HOST`,
  `LAN_GATE_TARGET_HOST`, `LAN_GATE_TARGET_PORT`, `LAN_GATE_RATE_LIMIT`,
  `LAN_GATE_VAPID_PUBLICKEY`, `LAN_GATE_VAPID_PRIVATEKEY`, `LAN_GATE_VAPID_SUBJECT`.
  The plugin resolves the target automatically from `webStartup`; the env var wins.
- **Add a mobile CSS tweak**: append a `html[data-lan-device="phone"] ...` rule to
  `pwa/app.css` (kept in the file loaded by the injected `<link>`).
- **Change injected page behaviour**: edit `pwa/inject.js` (wired into the injected
  bootstrap) and touch gestures in `pwa/touch-gestures.js`.
- **Change PWA metadata/icons**: edit `pwa/manifest.json` and `pwa/icons/*`; re-run
  `rsvg-convert` if you change the SVG.
- **Give the Bots a browser**: `node scripts/setup-browser.mjs --proxy <http-proxy>`.
  It is idempotent — re-running reuses an existing Chrome / playwright-core and only
  rewrites the `- id: bot` block (with a timestamped backup). `--dry-run`,
  `--print-config`, `--verify-only` for inspection.
- **Diagnose the browser**: `node scripts/setup-browser.mjs --verify-only`, or
  `node scripts/verify-browser.mjs --chrome <c> --shim <s> --persistent <dir>
  --egress https://api.ipify.org`. `--persistent` reproduces ds-bot's own call.
- **Fix proxy routing**: `sudo node scripts/xray-split-route.mjs` (backs up, runs
  `xray -test`, rolls back on failure). `--dry-run` prints the routing block only.

## Testing

```bash
npm test
```

Runs `node --test test/*.test.cjs`, booting `lib/lan-gate-server.cjs` behind a mock
DSH upstream (isolated temp `DSH_HOME`) and asserting `/pwa` asset serving, HTML
injection, PWA status reporting, and the Web Push encryption round-trip.
