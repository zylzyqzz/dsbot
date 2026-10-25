/* dsh-mobile-pwa · PWA bootstrap (injected into the DSH page)
 *
 * Registers the service worker (offline cache + push), loads the touch
 * gestures on phone devices, and watches the DSH 0.2 conversation DOM for the
 * agent "running" state so a finished turn can raise a notification.
 *
 * DSH 0.2 markers used here:
 *   [data-chat-running]  present while the agent is working (RunningStatus)
 *   [data-streaming]     present on content that is still streaming
 */
;(function () {
  'use strict'
  if (!window.__DSH_PWA__) window.__DSH_PWA__ = {}

  var PWA = window.__DSH_PWA__

  function base64UrlToBytes(value) {
    var padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
    while (padded.length % 4) padded += '='
    var binary = atob(padded)
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  // ---- Register service worker ------------------------------------------
  var swReady = null
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      // The worker lives under /pwa/ but must control the whole origin for the
      // offline shell to cover the DSH routes; the gateway sends
      // Service-Worker-Allowed: / so this scope is accepted.
      navigator.serviceWorker.register('/pwa/sw.js', { scope: '/' }).then(function (reg) {
        PWA.reg = reg
      }).catch(function (err) {
        console.warn('[dsh-pwa] SW registration failed:', err)
      })
    })
    swReady = navigator.serviceWorker.ready.catch(function () { return null })
  }

  // ---- Load touch gestures when on a phone device -----------------------
  var isPhone = document.documentElement.getAttribute('data-lan-device') === 'phone'
  if (isPhone) {
    var g = document.createElement('script')
    g.src = '/pwa/touch-gestures.js'
    g.async = true
    document.head.appendChild(g)
  }

  // ---- Push subscription ------------------------------------------------
  function subscribe() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return Promise.reject(new Error('push unsupported'))
    }
    var key = PWA.vapid
    if (!key) return Promise.reject(new Error('no vapid key'))

    var ready = PWA.reg ? Promise.resolve(PWA.reg) : swReady
    return ready.then(function (reg) {
      if (!reg) throw new Error('no service worker')
      return reg.pushManager.getSubscription().then(function (existing) {
        if (existing) return existing
        return reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: base64UrlToBytes(key)
        })
      })
    }).then(function (sub) {
      // Hand the subscription to the gateway so it can route pushes to it.
      return fetch('/pwa/push/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON() })
      }).then(function (res) {
        if (!res.ok) throw new Error('subscribe rejected: ' + res.status)
        return sub
      })
    })
  }

  PWA.subscribe = subscribe

  // Keep the gateway in sync with an existing subscription on every visit.
  if (PWA.vapid && 'serviceWorker' in navigator && 'PushManager' in window) {
    window.addEventListener('load', function () {
      swReady.then(function (reg) {
        if (!reg) return
        reg.pushManager.getSubscription().then(function (sub) {
          if (!sub) return
          return fetch('/pwa/push/subscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ subscription: sub.toJSON() })
          })
        }).catch(function () { /* ignore */ })
      })
    })
  }

  // ---- Agent-done detection ---------------------------------------------
  // DSH renders [data-chat-running] while the agent works. When it disappears
  // the turn is over: raise a local notification and tell the gateway, so any
  // other subscribed device can be nudged too.
  var wasRunning = false
  var lastNotifiedAt = 0

  function agentRunning() {
    return !!document.querySelector('[data-chat-running]')
  }

  function notifyAgentDone() {
    var now = Date.now()
    if (now - lastNotifiedAt < 3000) return
    lastNotifiedAt = now

    var title = 'DSH 任务完成'
    var body = '智能体已完成当前步骤。'

    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, {
          body: body,
          icon: '/pwa/icons/icon-192.png',
          badge: '/pwa/icons/icon-192.png',
          tag: 'dsh-agent-done'
        })
      }
    } catch (e) { /* ignore */ }

    try {
      fetch('/pwa/push/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title, body: body, tag: 'dsh-agent-done' })
      }).catch(function () { /* ignore */ })
    } catch (e) { /* ignore */ }
  }

  function checkRunningState() {
    var running = agentRunning()
    if (running) {
      wasRunning = true
      return
    }
    if (wasRunning) {
      wasRunning = false
      notifyAgentDone()
    }
  }

  if (typeof MutationObserver === 'function') {
    var observer = new MutationObserver(function () { checkRunningState() })
    var startObserving = function () {
      if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-chat-running', 'data-streaming'] })
      } else {
        setTimeout(startObserving, 200)
      }
    }
    startObserving()
  }

  // ---- Notification enable hint (phone only, once) -----------------------
  if (isPhone && 'Notification' in window) {
    var seen = localStorage.getItem('dsh-pwa-notif-hint')
    if (!seen && window.Notification && window.Notification.permission === 'default') {
      var toast = document.createElement('div')
      toast.id = 'dsh-pwa-notif-hint'
      toast.style.cssText =
        'position:fixed;left:max(12px,env(safe-area-inset-left));right:max(12px,env(safe-area-inset-right));' +
        'bottom:max(96px,calc(env(safe-area-inset-bottom) + 96px));z-index:2147483005;' +
        'background:rgba(22,26,34,.96);border:1px solid #2a2f3a;border-radius:14px;' +
        'padding:14px 16px;color:#e6e8ec;font:13px/1.6 system-ui;' +
        '-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.5)'
      toast.innerHTML =
        '<div style="font-weight:600;margin-bottom:4px">🧭 任务完成提醒</div>' +
        '<div style="color:#9aa3b2;margin-bottom:10px">开启后，智能体完成工作时这台手机会收到通知；切到别的 App 也能收到推送。</div>' +
        '<div style="display:flex;gap:8px">' +
        '<button data-act="on" style="flex:1;background:#4c8dff;color:#fff;border:0;border-radius:9px;padding:9px 0;font-weight:600">开启</button>' +
        '<button data-act="off" style="flex:1;background:#2a2f3a;color:#9aa3b2;border:0;border-radius:9px;padding:9px 0">暂不</button>' +
        '</div>'
      toast.querySelector('[data-act="on"]').addEventListener('click', function () {
        localStorage.setItem('dsh-pwa-notif-hint', '1')
        try {
          Notification.requestPermission().then(function (state) {
            if (state === 'granted') subscribe().catch(function (err) { console.warn('[dsh-pwa] push subscribe failed:', err) })
          })
        } catch (err) { /* ignore */ }
        toast.remove()
      })
      toast.querySelector('[data-act="off"]').addEventListener('click', function () {
        localStorage.setItem('dsh-pwa-notif-hint', '1')
        toast.remove()
      })
      document.body.appendChild(toast)
    }
  }
})()
