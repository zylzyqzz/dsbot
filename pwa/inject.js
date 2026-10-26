/* dsbot · PWA bootstrap (injected into the DSH page)
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

  // ---- Pin the Bot surface ----------------------------------------------
  // ds-bot picks its UI from localStorage: readMode() treats "agent" as the
  // classic Agent screen and anything else as Bot. The classic screen has no
  // way back, so a single tap strands the app in a UI this build does not
  // support. This gateway is the Bot surface, so the key is cleared before the
  // app boots; the reload happens once, guarded, so the page can never loop.
  try {
    var SURFACE_KEY = 'ds-bot:surface'
    var GUARD_KEY = 'dsh-lan-surface-reset'
    if (localStorage.getItem(SURFACE_KEY) === 'agent') {
      localStorage.removeItem(SURFACE_KEY)
      if (!sessionStorage.getItem(GUARD_KEY)) {
        sessionStorage.setItem(GUARD_KEY, '1')
        location.reload()
        return
      }
    }
  } catch (e) { /* storage blocked: nothing to pin */ }

  function base64UrlToBytes(value) {
    var padded = String(value || '').replace(/-/g, '+').replace(/_/g, '/')
    while (padded.length % 4) padded += '='
    var binary = atob(padded)
    var bytes = new Uint8Array(binary.length)
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  }

  // ---- Remove the classic-mode switch ------------------------------------
  // The Bot surface is what this build is; the classic Agent screen has no way
  // back, so one tap strands the app there. The settings page carries that
  // switch in a "模式" section, and its markup uses hashed class names, so the
  // section is found by its own label and taken out of the DOM.
  var CLASSIC_RE = /经典\s*Agent\s*模式|Classic\s*Agent\s*mode/i

  function stripClassicSwitch() {
    var sections = document.querySelectorAll('[role="dialog"] .bt-set-section, [role="dialog"] section')
    for (var i = 0; i < sections.length; i++) {
      var section = sections[i]
      if (section.getAttribute('data-lan-no-classic')) continue
      if (!CLASSIC_RE.test(section.textContent || '')) continue
      section.setAttribute('data-lan-no-classic', '1')
      section.remove()
    }
    // The account menu carries the same door.
    var menus = document.querySelectorAll('.bt-account-menu button, [role="menu"] button')
    for (var j = 0; j < menus.length; j++) {
      if (CLASSIC_RE.test(menus[j].textContent || '')) menus[j].remove()
    }
  }

  // ---- Composer: keep the floating capsule in view, smoothly ------------
  // The capsule floats above the bottom edge, so once the on-screen keyboard
  // opens it can sit under it. DSH lays the composer out in a shrinking
  // viewport, so the fix is not a transform (that would shift it twice) but a
  // smooth scroll of the seat into view after the keyboard has settled.
  //
  // The field is a contenteditable div carrying data-composer-input, not a
  // textarea: DSH's composer is a rich input.
  function watchComposer() {
    var field = document.querySelector('[data-composer-input], [data-composer-card] textarea, [data-composer-card] [contenteditable="true"]')
    if (!field || field.getAttribute('data-lan-composer')) return
    field.setAttribute('data-lan-composer', '1')

    var settle = 0
    var reveal = function () {
      clearTimeout(settle)
      // The keyboard animation is the browser's; wait it out, then glide the
      // seat into view. 'nearest' keeps an already-visible composer still.
      settle = setTimeout(function () {
        var seat = document.querySelector('.wSkVaW_composerStack')
        if (!seat) return
        try { seat.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) } catch (e) { /* older engine */ }
      }, 260)
    }

    field.addEventListener('focus', reveal)
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        var active = document.activeElement
        if (active === field || (field.contains && field.contains(active))) reveal()
      })
    }
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
        console.warn('[dsbot] SW registration failed:', err)
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

  // =====================================================================
  // Phone chrome: the left toolbar becomes an overlay drawer, the header
  // gets a menu button, and a bottom action bar carries the destinations.
  //
  // DSH collapses the left column to a 56px icon rail below 1024px, and the
  // toggle expands it over the squeezed centre: on a 390px phone that leaves
  // the conversation 110px wide. The gateway takes the column out of the grid
  // and floats it over the conversation instead, so the rules are:
  //
  //   * closed by default, and it takes no space at all
  //   * it opens as an overlay from the menu button, never by squeezing
  //   * it closes on a scrim tap, on a selection, on Esc and on the back key
  //   * above the breakpoint every one of DSH's own rules applies again
  // =====================================================================

  var DRAWER_BREAKPOINT = 720
  var drawerMedia = window.matchMedia('(max-width: ' + DRAWER_BREAKPOINT + 'px)')
  var chromeState = {
    frame: null,
    col: null,
    scrim: null,
    menu: null,
    bar: null,
    museNav: null,
    observer: null,
    toggleEl: null,
    toggleKeys: '',
    pushed: false,
    suppressClose: false,
    ready: false
  }

  // Hairline icons, 1.6 stroke, 24px box — the Muse register: the glyph
  // carries the meaning, so the row needs no background, border or pill.
  var ICON_ATTR = 'viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'
  var ICONS = {
    menu: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    // chat: an open speech bubble
    chat: '<svg ' + ICON_ATTR + '><path d="M20.5 11.6a7.9 7.9 0 0 1-8.1 7.9 8.6 8.6 0 0 1-3.2-.6L4 20.5l1.5-4.4a7.6 7.6 0 0 1-1.1-4A7.9 7.9 0 0 1 12 4.2a7.9 7.9 0 0 1 8.5 7.4z"/></svg>',
    // compose: a sheet with a plus
    compose: '<svg ' + ICON_ATTR + '><path d="M13.5 3.5H7a2.5 2.5 0 0 0-2.5 2.5v12A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-6.5"/><path d="M16.5 3.2a2.1 2.1 0 0 1 3 3L12 13.7l-3.6.9.9-3.6z"/></svg>',
    // grid: four rounded squares of unequal weight
    grid: '<svg ' + ICON_ATTR + '><rect x="3.6" y="3.6" width="7" height="7" rx="2"/><rect x="13.4" y="3.6" width="7" height="7" rx="2"/><rect x="13.4" y="13.4" width="7" height="7" rx="2"/><rect x="3.6" y="13.4" width="7" height="7" rx="2"/></svg>',
    // shield: the permission page — a shield with a check inside
    shield: '<svg ' + ICON_ATTR + '><path d="M12 3.5 5 6.2v5.4c0 4.3 2.9 8.2 7 9.4 4.1-1.2 7-5.1 7-9.4V6.2z"/><path d="M9.2 12.1l2 2 3.6-4"/></svg>',
    // zap: automation
    zap: '<svg ' + ICON_ATTR + '><path d="M13.5 2.5 4 14h7l-.5 7.5L20 10h-7z"/></svg>',
    // gear: settings — a ring plus six teeth, not a sunburst
    gear: '<svg ' + ICON_ATTR + '><circle cx="12" cy="12" r="3.1"/><path d="M19.4 14.2a1.7 1.7 0 0 0 .3 1.9 1.4 1.4 0 1 1-2 2 1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5 1.4 1.4 0 1 1-2.8 0 1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3 1.4 1.4 0 1 1-2-2 1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1.1 1.4 1.4 0 1 1 0-2.8 1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9 1.4 1.4 0 1 1 2-2 1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 11 5.2a1.4 1.4 0 1 1 2.8 0 1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3 1.4 1.4 0 1 1 2 2 1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1.1 1.4 1.4 0 1 1 0 2.8 1.7 1.7 0 0 0-1.5 1z"/></svg>',
    // doc / idea / check / stack — the Muse tab set, mirrored here
    doc: '<svg ' + ICON_ATTR + '><path d="M8 3.5h5.5L19 9v9.5a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z"/><path d="M13.5 3.5V9H19"/></svg>',
    idea: '<svg ' + ICON_ATTR + '><path d="M9 17.5a5.9 5.9 0 1 1 6 0"/><path d="M9.5 17.5h5M10.5 20.5h3"/></svg>',
    check: '<svg ' + ICON_ATTR + '><rect x="3.6" y="3.6" width="16.8" height="16.8" rx="4"/><path d="M8.2 12.2 11 15l4.8-5.4"/></svg>',
    stack: '<svg ' + ICON_ATTR + '><rect x="3.6" y="3.6" width="7" height="7" rx="2"/><rect x="13.4" y="3.6" width="7" height="7" rx="2"/><rect x="13.4" y="13.4" width="7" height="7" rx="2"/><rect x="3.6" y="13.4" width="7" height="7" rx="2"/></svg>'
  }

  // DSH's own sidebar toggle. In the collapsed rail the button carries the
  // sidebar.toggle.badge slot, which is a stable hook. The element survives
  // the expand, so it is cached, and its keyboard shortcut is kept as a
  // second way back to it.
  function chromeToggleButton() {
    if (chromeState.toggleEl && chromeState.toggleEl.isConnected) return chromeState.toggleEl
    var root = document.querySelector('[data-slot="sidebar"]')
    if (!root) return null
    var badge = root.querySelector('[data-slot="sidebar.toggle.badge"]')
    if (badge) {
      var btn = badge.closest('button')
      if (btn) {
        chromeState.toggleEl = btn
        if (!chromeState.toggleKeys) chromeState.toggleKeys = btn.getAttribute('aria-keyshortcuts') || ''
        return btn
      }
    }
    if (chromeState.toggleKeys) {
      var byKeys = root.querySelector('button[aria-keyshortcuts="' + chromeState.toggleKeys + '"]')
      if (byKeys) { chromeState.toggleEl = byKeys; return byKeys }
    }
    return null
  }

  // Find a sidebar button by its accessible label. The labels are localised,
  // so every destination is matched against both languages.
  function chromeFindButton(matchers) {
    var root = document.querySelector('[data-slot="sidebar"]')
    if (!root) return null
    var buttons = root.querySelectorAll('button')
    for (var i = 0; i < matchers.length; i++) {
      for (var j = 0; j < buttons.length; j++) {
        var label = buttons[j].getAttribute('aria-label') || ''
        if (matchers[i].test(label)) return buttons[j]
      }
    }
    return null
  }

  function chromeDrawerOpen() {
    if (!chromeState.frame) return
    if (!chromeState.frame.hasAttribute('data-sidebar-collapsed')) return
    var btn = chromeToggleButton()
    if (btn) btn.click()
  }

  function chromeDrawerClose() {
    if (!chromeState.frame) return
    if (chromeState.frame.hasAttribute('data-sidebar-collapsed')) return
    var btn = chromeToggleButton()
    if (btn) btn.click()
  }

  // The drawer state is DSH's state: the frame publishes it as
  // data-sidebar-collapsed. Reading it back keeps the two in step, so the
  // overlay can never disagree with the column it floats.
  function chromeSync() {
    if (!chromeState.frame) return
    var open = !chromeState.frame.hasAttribute('data-sidebar-collapsed')
    document.documentElement.setAttribute('data-dsh-lan-drawer-open', open ? '1' : '0')
    if (open && !chromeState.pushed) {
      chromeState.pushed = true
      try { history.pushState({ dshLanDrawer: 1 }, '') } catch (e) { chromeState.pushed = false }
    } else if (!open && chromeState.pushed) {
      chromeState.pushed = false
      try { history.back() } catch (e) { /* ignore */ }
    }
  }

  function chromeToBottom() {
    var flow = document.querySelector('[data-slot="conversation.chat.flow"]')
    var scroller = flow
    while (scroller && scroller !== document.body) {
      if (scroller.scrollHeight > scroller.clientHeight + 40) break
      scroller = scroller.parentElement
    }
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }

  // A tap inside the drawer closes it, which is right for "go to that
  // conversation" and wrong for "open this panel": the panel would be shut
  // together with the drawer, and the control would look dead. Destinations
  // that open a panel exempt their own click for one turn.
  function chromeExemptClose() {
    chromeState.suppressClose = true
    setTimeout(function () { chromeState.suppressClose = false }, 0)
  }

  function chromeRun(matchers) {
    var btn = chromeFindButton(matchers)
    if (!btn) { chromeDrawerOpen(); return false }
    chromeExemptClose()
    try { btn.click() } catch (e) { /* ignore */ }
    return true
  }

  // Find a labelled entry inside any open popover menu.
  function chromeMenuEntry(matchers) {
    var menus = document.querySelectorAll('[role="menu"]')
    for (var i = 0; i < menus.length; i++) {
      var items = menus[i].querySelectorAll('[role="menuitem"], [role="menuitemradio"], button')
      for (var j = 0; j < items.length; j++) {
        var text = (items[j].textContent || '').trim()
        for (var k = 0; k < matchers.length; k++) if (matchers[k].test(text)) return items[j]
      }
    }
    return null
  }

  // The drawer's one control is the settings gear: DSH's account launcher,
  // restyled. Its own click handler opens the account menu and the capture
  // listener wired in chromeSetup takes the menu's settings entry, so this
  // only has to make sure the gear is on screen before it is pressed.
  function chromeOpenSettings() {
    var launcher = document.querySelector('[data-slot="settings.launcher"] button')
    if (!launcher) return false
    chromeExemptClose()
    if (chromeState.frame && !chromeState.frame.hasAttribute('data-sidebar-collapsed')) {
      try { launcher.click() } catch (e) { return false }
      chromeSettingsNow()
      return true
    }
    var toggle = chromeToggleButton()
    if (!toggle) return false
    toggle.click()
    setTimeout(function () {
      chromeExemptClose()
      try { launcher.click() } catch (e) { /* ignore */ }
      chromeSettingsNow()
    }, 320)
    return true
  }

  function chromePickSettings() {
    // The entry is labelled "Bot 设置" (the account menu carries 用量 /
    // 连接器 / 自动化任务 / Bot 设置), so the match has to be wider than
    // "设置" alone.
    var entry = chromeMenuEntry([/Bot\s*设置/, /^设置$/, /Bot\s*Settings/i, /^Settings$/i])
    if (!entry) return false
    chromeExemptClose()
    try { entry.click() } catch (e) { return false }
    return true
  }

  // The gear is a settings door, not an account menu: the menu flashes open
  // only because that is how DSH reaches the entry. So the entry is taken as
  // soon as the menu exists, retried briefly because the popover mounts on the
  // next frame, and the menu is dismissed if it never shows up.
  function chromeSettingsNow() {
    var tries = 0
    var step = function () {
      if (chromePickSettings()) return
      if (++tries < 14) { setTimeout(step, 40); return }
      // Nothing to take: close the orphaned menu so the tap is not a dead end.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    }
    step()
  }

  // The bottom row is the Muse navigation: five hairline glyphs, no labels, no
  // background, sitting under the composer. Each one is a destination that
  // already exists in DSH, so the row is a shortcut, not a new surface.
  function chromeBuildBar() {
    var bar = document.createElement('nav')
    bar.className = 'dsh-lan-bar'
    bar.setAttribute('aria-label', '主导航')
    var items = [
      { icon: 'chat', label: '对话', run: function () {
        chromeDrawerClose()
        chromeToBottom()
      } },
      { icon: 'compose', label: '新建', run: function () {
        chromeRun([/^新建会话$/, /^New session$/i, /^新会话$/])
        setTimeout(chromeDrawerClose, 260)
      } },
      { icon: 'grid', label: '插件', run: function () { chromeRun([/^插件$/, /^Plugins?$/i]) } },
      { icon: 'zap', label: '自动化', run: function () { chromeRun([/自动化/, /Automation/i, /Schedule/i]) } },
      { icon: 'gear', label: '设置', run: function () {
        if (chromeOpenSettings()) return
        chromeDrawerOpen()
      } }
    ]
    items.forEach(function (item) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'dsh-lan-bar-item'
      button.setAttribute('aria-label', item.label)
      button.innerHTML = ICONS[item.icon] + '<span>' + item.label + '</span>'
      button.addEventListener('click', item.run)
      bar.appendChild(button)
    })
    return bar
  }

  // The drawer's own navigation for the shell's pages.
  //
  // Muse keeps its tabs in the drawer, not in a toolbar: a group label and a
  // short list of destinations. The connector list and the permission page
  // have no stock phone surface in DSH, so the drawer carries them in Muse's
  // register, right above the gear.
  function chromeBuildMuseNav() {
    var nav = document.createElement('nav')
    nav.className = 'dsh-lan-muse'
    nav.setAttribute('aria-label', '智能体')
    var label = document.createElement('div')
    label.className = 'dsh-lan-muse-label'
    label.textContent = '智能体'
    nav.appendChild(label)
    var rows = [
      { icon: 'grid', label: '连接器', page: 'connectors' },
      { icon: 'shield', label: '权限', page: 'permissions' }
    ]
    rows.forEach(function (row) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'dsh-lan-muse-row'
      button.innerHTML = '<span class="dsh-lan-muse-ico">' + ICONS[row.icon] + '</span><span>' + row.label + '</span>'
      button.addEventListener('click', function () {
        var muse = window.__DSH_MUSE__
        if (!muse || typeof muse.open !== 'function') return
        // The drawer steps aside for the page, the way it does for a
        // conversation row.
        chromeExemptClose()
        muse.open(row.page)
      })
      nav.appendChild(button)
    })
    return nav
  }

  function chromeEnsureElements() {
    if (!chromeState.scrim) {
      var scrim = document.createElement('div')
      scrim.className = 'dsh-lan-scrim'
      scrim.setAttribute('aria-hidden', 'true')
      scrim.addEventListener('click', function () { chromeDrawerClose() })
      document.body.appendChild(scrim)
      chromeState.scrim = scrim
    }
    if (!chromeState.menu) {
      var menu = document.createElement('button')
      menu.type = 'button'
      menu.className = 'dsh-lan-menu'
      menu.setAttribute('aria-label', '菜单')
      menu.innerHTML = '<span class="ico-menu">' + ICONS.menu + '</span><span class="ico-close">' + ICONS.close + '</span>'
      menu.addEventListener('click', function () {
        if (chromeState.frame && chromeState.frame.hasAttribute('data-sidebar-collapsed')) chromeDrawerOpen()
        else chromeDrawerClose()
      })
      document.body.appendChild(menu)
      chromeState.menu = menu
    }
    if (!chromeState.bar) {
      chromeState.bar = chromeBuildBar()
    }
    // The drawer's own navigation for the shell's pages. It is part of the
    // column, so it has to live in the column and not in the body.
    if (!chromeState.museNav && chromeState.col) {
      chromeState.museNav = chromeBuildMuseNav()
      chromeState.col.appendChild(chromeState.museNav)
    }
    // No footer row: every destination already lives in the settings pages,
    // so the drawer carries one control (the gear) and no duplicate doors.
  }

  function chromeTeardown() {
    var html = document.documentElement
    html.removeAttribute('data-dsh-lan-drawer')
    html.removeAttribute('data-dsh-lan-drawer-open')
    if (chromeState.frame) {
      chromeState.frame.classList.remove('dsh-lan-frame')
      chromeState.col.classList.remove('dsh-lan-sidebar-col')
    }
    if (chromeState.observer) { chromeState.observer.disconnect(); chromeState.observer = null }
    if (chromeState.museNav && chromeState.museNav.parentNode) {
      chromeState.museNav.parentNode.removeChild(chromeState.museNav)
    }
    chromeState.museNav = null
    chromeState.ready = false
    chromeState.frame = null
    chromeState.col = null
    chromeState.toggleEl = null
    if (chromeState.pushed) {
      chromeState.pushed = false
      try { history.back() } catch (e) { /* ignore */ }
    }
  }

  function chromeSetup() {
    if (!drawerMedia.matches) {
      if (chromeState.ready) chromeTeardown()
      return
    }
    if (chromeState.ready && chromeState.frame && chromeState.frame.isConnected) return
    var root = document.querySelector('[data-slot="sidebar"]')
    if (!root) return
    var col = root.parentElement
    var frame = col ? col.parentElement : null
    if (!col || !frame) return
    chromeState.frame = frame
    chromeState.col = col
    frame.classList.add('dsh-lan-frame')
    col.classList.add('dsh-lan-sidebar-col')
    document.documentElement.setAttribute('data-dsh-lan-drawer', 'on')
    chromeState.ready = true
    chromeEnsureElements()
    if (chromeState.observer) chromeState.observer.disconnect()
    chromeState.observer = new MutationObserver(function () { chromeSync() })
    chromeState.observer.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
    // A selection inside the column means "go there", so the drawer steps
    // aside. The toggle itself is the only control that stays.
    if (!col.getAttribute('data-dsh-lan-wired')) {
      col.setAttribute('data-dsh-lan-wired', '1')
      col.addEventListener('click', function (event) {
        if (chromeState.suppressClose) return
        var target = event.target
        if (!target || !target.closest) return
        // The gear opens a popover, and a tap on it is not a destination.
        var gear = document.querySelector('[data-slot="settings.launcher"] button')
        if (gear && (target === gear || gear.contains(target))) return
        var toggle = chromeToggleButton()
        if (toggle && (target === toggle || toggle.contains(target))) return
        chromeDrawerClose()
      })
    }
    // Tapping the gear opens DSH's account menu; the gear is the settings
    // door, so the menu's own settings entry is taken straight away. Bound
    // once on the element, in the capture phase, so DSH's handler still runs.
    var launcherBtn = document.querySelector('[data-slot="settings.launcher"] button')
    if (launcherBtn && !launcherBtn.getAttribute('data-lan-gear')) {
      launcherBtn.setAttribute('data-lan-gear', '1')
      launcherBtn.addEventListener('click', function () {
        chromeSettingsNow()
      }, true)
    }
    chromeSync()
  }

  function chromeOnBreakpoint() {
    if (drawerMedia.matches) chromeSetup()
    else chromeTeardown()
  }

  if (drawerMedia.addEventListener) drawerMedia.addEventListener('change', chromeOnBreakpoint)
  else if (drawerMedia.addListener) drawerMedia.addListener(chromeOnBreakpoint)

  // The phone's back key closes the drawer instead of leaving the page.
  window.addEventListener('popstate', function () {
    if (!chromeState.pushed) return
    chromeState.pushed = false
    chromeDrawerClose()
  })

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && chromeState.ready) chromeDrawerClose()
  })

  // ---- Load the Muse shell ----------------------------------------------
  // The shell needs the typed-RPC client first, so the two files are loaded in
  // order: the shell reads window.__DSH_RPC__ when it boots.
  function loadPwaScript(src, then) {
    var script = document.createElement('script')
    script.src = src
    script.async = false
    script.onload = function () { if (then) then() }
    script.onerror = function () { console.warn('[dsbot] could not load ' + src) }
    document.head.appendChild(script)
  }

  loadPwaScript('/pwa/dsh-rpc.js', function () {
    loadPwaScript('/pwa/muse-shell.js')
  })

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

    var title = 'DSBot 任务完成'
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
    var observer = new MutationObserver(function () {
      checkRunningState()
      // The sidebar only exists once the app has rendered; wire the drawer
      // to it as soon as it shows up.
      chromeSetup()
      // A settings panel or the account menu may have just mounted.
      stripClassicSwitch()
      // The composer may have been re-rendered; re-attach the reveal hook.
      watchComposer()
    })
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
            if (state === 'granted') subscribe().catch(function (err) { console.warn('[dsbot] push subscribe failed:', err) })
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
