/* dsh-mobile-pwa · service worker
 * Offline-capable caching + agent-done push notifications for the DSH Web UI.
 *
 * Strategy:
 *  - Static app shell (JS/CSS/img)  -> cache-first (fast, offline shell)
 *  - DSH runtime calls & API routes -> network-first (keep data fresh)
 *  - SPA navigations (HTML doc)     -> network-first w/ cache fallback
 *
 * Served by the gateway at /pwa/sw.js. Registered from the injected PWA script.
 */
'use strict'

const SHELL_CACHE = 'dsh-mobile-pwa-shell-v3'
const RUNTIME_CACHE = 'dsh-mobile-pwa-runtime-v3'
const SHELL_DOCUMENT = '/__dsh-shell-document'

const SHELL_REGEX = /\.(js|mjs|css|woff2?|ttf|otf|png|webp|svg|jpg|jpeg|gif|ico)(\?|$)/i
const API_REGEX = /^\/api\//i

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll([
      '/pwa/manifest.json',
      '/pwa/icons/icon-192.png',
      '/pwa/icons/icon-512.png',
      '/pwa/icons/icon-maskable-512.png'
    ]))
  )
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
      )
    )
  )
  self.clients.claim()
})

// ---- fetch handler -------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)

  // Same-origin only; we only manage the DSH origin behind the gateway.
  if (url.origin !== self.location.origin) return

  // The plugin's own assets (this worker included) always come from the
  // network, so an updated worker never serves a stale copy of itself.
  if (url.pathname.indexOf('/pwa/') === 0) return

  // 1. PWA shell static assets -> cache-first.
  if (req.method === 'GET' && SHELL_REGEX.test(url.pathname)) {
    event.respondWith(staleWhileRevalidate(req, SHELL_CACHE))
    return
  }

  // 2. API calls -> network-first (never cache auth/session data persistently).
  if (API_REGEX.test(url.pathname)) {
    event.respondWith(networkFirst(req, RUNTIME_CACHE))
    return
  }

  // 3. HTML navigations -> network-first with offline fallback to cached shell.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(req))
    return
  }
})

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(req)
  const fetchPromise = fetch(req)
    .then((res) => {
      if (res && res.ok) cache.put(req, res.clone())
      return res
    })
    .catch(() => cached)
  return cached || fetchPromise
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName)
  try {
    const res = await fetch(req)
    if (res && res.ok && req.method === 'GET') cache.put(req, res.clone())
    return res
  } catch (err) {
    const cached = await cache.match(req)
    if (cached) return cached
    throw err
  }
}

async function networkFirstNavigation(req) {
  const cache = await caches.open(SHELL_CACHE)
  try {
    const res = await fetch(req)
    // Keep the last served document under its own key: the offline page stays
    // the offline page instead of being overwritten by the app shell.
    if (res && res.ok) cache.put(SHELL_DOCUMENT, res.clone())
    return res
  } catch (err) {
    const cached = await cache.match(SHELL_DOCUMENT)
    if (cached) return cached
    const offline = await cache.match('/pwa/offline.html')
    if (offline) return offline
    // Last resort: offline fallback hint.
    return new Response(
      '<!doctype html><meta charset="utf-8"><title>离线</title><style>body{font-family:system-ui;background:#0f1115;color:#e6e8ec;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}p{max-width:24em;text-align:center;line-height:1.7}</style><script>setInterval(()=>location.reload(),4000)</script><p>无法连接到 DSH 服务器，正在重试…<br>请确认你的网关与服务仍在运行。</p>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    )
  }
}

// ---- push (agent-done) notifications ------------------------------------
self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch (e) { /* ignore */ }
  const title = data.title || 'DSH 任务完成'
  const options = {
    body: data.body || '你的智能体已完成某一步。',
    icon: '/pwa/icons/icon-192.png',
    badge: '/pwa/icons/icon-192.png',
    tag: data.tag || 'dsh-agent-done',
    renotify: true,
    data: data.data || {}
  }
  event.waitUntil(self.registration.showNotification(title, options))
})

// A rotated push subscription has to be handed to the gateway again.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    self.registration.pushManager.getSubscription().then((sub) => {
      if (!sub) return null
      return fetch('/pwa/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() })
      })
    }).catch(() => null)
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) { client.navigate(target); return client.focus() }
      }
      return self.clients.openWindow(target)
    })
  )
})
