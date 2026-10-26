# dsh-mobile-pwa · DeepSeek Harness as a real mobile PWA

> Turn [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) into a **complete mobile PWA**: secure remote access to your own DSH, install-to-homescreen, offline capable, touch gestures, agent-done notifications.

Built on the MIT [`dsh-mobile-gate`](https://github.com/Bernardxu123/dsh-mobile-gate) gateway base.

**Current version `0.2.0` — targets DSH `0.2.x`** (`engines.dsh: ">=0.2.0 <0.3.0"`).

[![npm version](https://img.shields.io/npm/v/dsh-mobile-pwa)](https://www.npmjs.com/package/dsh-mobile-pwa)
[![license](https://img.shields.io/github/license/zylzyqzz/dsh-mobile-pwa)](https://github.com/zylzyqzz/dsh-mobile-pwa/blob/main/LICENSE)

---

## Features

| Module | What it does |
| --- | --- |
| 📡 **Secure remote access** | Standalone child-process gateway: first-visit approval (the approval binds an address, the token binds a browser — a phone and a laptop behind one NAT can be signed in at the same time), optional access password, per-IP rate limit. The DSH webserver itself stays on loopback, so its `/api` trust fence is untouched. |
| 📱 **Real PWA** | `manifest.json` + service worker: install-to-homescreen runs it as a standalone app with icon, splash and theme colour. |
| 🌐 **Offline capable** | Static shell cached first, API network-first, navigation falls back to an offline page. |
| 👆 **Touch gestures** | Pull-to-refresh, edge-swipe back, pinch font zoom. |
| 🔔 **Agent-done notifications** | Real Web Push (RFC 8291 aes128gcm body, RFC 8292 VAPID auth). |
| 📐 **Touch layout** | 44px targets, safe-area insets, full-screen dialogs, compact type, scrollable code — desktop untouched. |
| 🌐 **Bot browser** | One command gives your Bots a real Chrome (Chrome for Testing + playwright-core + proxy shim + profile patch + self-check). Screenshots land **in the conversation**, and login/payment/captcha can be handed off to the human. See [docs/browser.md](docs/browser.md) |
| 🎯 **0.2 DOM alignment** | The mobile CSS targets the DSH 0.2 slot vocabulary (`main.conversation`, `conversation.view`, `conversation.chat.flow`, `conversation.input.model`, `conversation.composer.dock`, …). Every 0.1-era selector is gone. |

---

## Architecture

```
phone ──> gateway (standalone Node child process · 0.0.0.0:3088)
           ├─ unapproved  -> "waiting for approval" page (polls /lan-gate/admin)
           ├─ approved    -> reverse proxy to the DSH Web UI (local host:port)
           │      └─ HTML injection: manifest link + PWA bootstrap + touch CSS + randomUUID polyfill
           ├─ /pwa/*      -> manifest / sw.js / app.css / icons / offline.html
           ├─ /pwa/push/* -> subscribe / send (real encrypted push)
           └─ over limit  -> 429 page
laptop 127.0.0.1:3088/lan-gate/admin -> approve / deny / revoke, pick phone / desktop / auto
```

- The gateway is an **isolated child process**: if it dies the harness keeps running, and it is terminated when the plugin unloads.
- Since **DSH 0.2 rejects a wildcard bind address** (`--host 0.0.0.0` fails at load), the Web UI always listens on one concrete local address. This gateway is the remote door: it owns the exposed port and the approval gate.
- The target address is **not hardcoded**: the plugin reads the real host/port from the `webStartup` service, so `dsh web --port 0` and `--host <addr>` keep working.

---

## Install

```bash
npm add dsh-mobile-pwa@0.2.0
dsh plugin --profile web add dsh-mobile-pwa
```

From a checkout:

```bash
git clone https://github.com/zylzyqzz/dsh-mobile-pwa.git
cd dsh-mobile-pwa
dsh plugin --profile web add ./dsh-mobile-pwa
```

### Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `LAN_GATE_PORT` | `3088` | Gateway listen port |
| `LAN_GATE_HOST` | `0.0.0.0` | Gateway listen address |
| `LAN_GATE_TARGET_HOST` | `127.0.0.1` | DSH Web UI host (the plugin fills `webStartup.host`; this wins) |
| `LAN_GATE_TARGET_PORT` | `3080` | DSH Web UI port (the plugin fills `webStartup.port`; this wins) |
| `LAN_GATE_RATE_LIMIT` | `120` | Requests per IP per minute |
| `LAN_GATE_PASSWORD` | – | Access password. When set, the gateway asks for it before serving anything. The password stays on the server; the browser only gets an HMAC-derived session cookie |
| `LAN_GATE_TRUSTED_HOSTS` | – | **Public authorities the gateway serves**, comma separated (`111.170.171.25,app.example`). DSH 0.2's Host/Origin fence compares the browser-facing Host, which the gateway forwards unchanged, so the public authority has to be declared here; a port-less entry matches any port |
| `LAN_GATE_REWRITE_HOST` | – | Set to `1` to rewrite Host to the loopback address (only needed by older DSH) |
| `LAN_GATE_DSH_TOKEN` | auto | DSH process launch token; the plugin reads it from `ctx.connection` and hands it to the gateway |
| `LAN_GATE_PUBLIC_URL` | – | Base URL used when minting the tokenized URL |
| `LAN_GATE_VAPID_PUBLICKEY` | generated | Web Push VAPID public key (base64url) |
| `LAN_GATE_VAPID_PRIVATEKEY` | generated | Web Push VAPID private key (base64url PKCS#8) |
| `LAN_GATE_VAPID_SUBJECT` | `mailto:dsh-mobile-pwa@localhost` | VAPID contact |

> When no VAPID keypair is supplied, one is generated once and stored in `~/.dsh/lan-gate-vapid.json` (mode 600) so subscriptions survive restarts.

### How DSH 0.2 browser authentication is handled

Since DSH 0.2 a browser needs a **signed session cookie**, and the first issue of that cookie needs a **process launch token** that changes on every restart. This plugin removes that step for the user:

1. The plugin reads the launch token from `ctx.connection.authenticatedUrl()` inside the DSH process and hands it to the gateway child.
2. The gateway forwards the **browser-facing Host unchanged** (DSH's Host/Origin fence and the cookie's authority both depend on it) and, when the browser has no session cookie yet, exchanges the token upstream and passes the cookie straight to the browser.
3. The user therefore opens a **plain URL** — no tokenized link to copy from the startup log.

DSH must trust the public authority for this to work: set `LAN_GATE_TRUSTED_HOSTS` to the public `host` or `host:port` (the bundle's `connection` row merges it into the `--trusted-host` list), or pass `--trusted-host <public authority>` on the command line.


### Flow

1. **Server**: start DSH with the plugin; look for `[lan-gate] listening on 0.0.0.0:3088 -> <host>:<port> (pwa=on)`.
2. **Phone**: open `http://<server-ip>:3088` → "waiting for approval".
3. **Laptop**: open `http://127.0.0.1:3088/lan-gate/admin` → approve the device, choose "phone".
4. **Phone**: pull to refresh → the DSH Web UI, PWA injected.
5. **Install**: browser menu → "Add to Home Screen".
6. **Optional**: allow notifications when the page offers it.

---

## Bot browser (real Chrome, one command)

ds-bot ships 12 browser tools but **no browser**, its launch args are hardcoded, and it has no proxy setting. One command fills the gap:

```bash
# on your DSH server
node scripts/setup-browser.mjs --proxy http://127.0.0.1:7890
sudo systemctl restart dsh-web
```

It downloads Chrome for Testing, installs the system libraries (including the Ubuntu 24.04 `libasound2t64` rename),
installs playwright-core, drops in the proxy shim, **opens a real page to verify**, then writes the `- id: bot`
row into your profile patch (with a backup).

Your Bots then get `browser_open` / `browser_snapshot` / `browser_click` / `browser_screenshot` /
`browser_handoff` and seven more — and a screenshot arrives **as an image in the conversation**, not a tool log line.

```bash
node scripts/setup-browser.mjs --verify-only      # doctor at any time
node scripts/setup-browser.mjs --print-config     # just print the YAML
sudo node scripts/xray-split-route.mjs            # split route: China direct, rest proxied
```

Why the shim exists, how proxy selection works, troubleshooting → **[docs/browser.md](docs/browser.md)**

---

## How agent-done is detected

DSH 0.2 renders `[data-chat-running]` while the agent is working. The injected script watches it with a `MutationObserver`; when it disappears the turn is over, so the page raises a local `Notification` and reports it to the gateway, which pushes it to the other subscribed devices.

> The 0.1-era host plugin `dsh-push.mjs` was removed: it depended on DSH 0.1's `conversation`/`http` services, which no longer exist in 0.2. Browser-side detection is more accurate (DSH's own DOM is the source of truth) and keeps the host process clean.

---

## Local test

```bash
npm test
```

Boots the real gateway behind a mock upstream and asserts `/pwa` asset serving, HTML injection, status reporting and a full Web Push encrypt/decrypt round-trip.

---

## Layout

| Path | Role |
| --- | --- |
| `lan-gate.mjs` | Cordis entry: resolve the target address, spawn the gateway, own its lifetime |
| `lib/lan-gate-server.cjs` | The gateway: zero-dependency single file (proxy, approval, tokens, rate limit, PWA injection) |
| `lib/web-push.cjs` | Real Web Push: VAPID keys + ES256 JWT, ECDH/HKDF derivation, AES-128-GCM body encryption |
| `pwa/manifest.json` | Install manifest |
| `pwa/sw.js` | Service worker: caching, push, subscription rotation |
| `pwa/inject.js` | Page bootstrap: SW registration, gestures, push subscription, agent-done detection |
| `pwa/touch-gestures.js` | Pull-to-refresh / edge swipe / pinch zoom |
| `pwa/app.css` | Touch-first mobile CSS |
| `pwa/offline.html` | Offline fallback |
| `pwa/icons/` | SVG source + 192/512 PNG + maskable icons |
| `cordis.patch.yml` / `.example` | Bundle patch layer |
| `scripts/setup-browser.mjs` | One-command Bot browser: Chrome + system libs + playwright-core + shim + self-check + profile patch |
| `scripts/verify-browser.mjs` | Browser doctor: opens a real page and prints a JSON report |
| `scripts/pw-proxy-shim.mjs` | Playwright shim: injects `--proxy-server` and drops automation flags without patching ds-bot |
| `scripts/xray-split-route.mjs` | Fix xray routing: China direct, rest proxied, with `xray -test` and automatic rollback |
| `docs/browser.md` | Bot browser: how it works, configuration, troubleshooting |
| `test/gateway.test.cjs` | Gateway smoke tests |
| `test/browser-setup.test.cjs` | Pure-function tests for the installer, shim and routing rules |

---

## Notes for contributors

- **Isolation**: the gateway is a child process. Never import its server code into the DSH process.
- **Pass the environment explicitly**: DSH 0.2's `ctx.subprocess` scrubs ambient credentials and `DSH_*` facts before applying the caller's `env`, so every `LAN_GATE_*` value, `DSH_HOME` and the VAPID keys must be handed over in the spawn request.
- **Scope the mobile CSS**: every rule belongs under `html[data-lan-device="phone"]` (or the `@media(max-width:820px)` fallback that excludes `desktop`). The desktop must never be affected.
- **Stable selectors**: prefer `[data-slot]`/`[data-*]`/ARIA over hashed build class names. When DSH renames a slot the mobile layout silently stops applying — re-check the slot list against upstream `packages/client` after a DSH upgrade.
- **Push must be encrypted**: a push service rejects a plain-text body. Use `lib/web-push.cjs`.

---

## License

MIT. `lib/lan-gate-server.cjs` extends `dsh-mobile-gate` and keeps the original MIT copyright and licence — see [LICENSE](LICENSE).
