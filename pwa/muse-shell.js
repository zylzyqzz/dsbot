/* dsbot · Muse-style phone shell
 *
 * The Muse app (com.facebook.aura) is not a chat app with a theme on top: it
 * is a phone shell around an agent. Three of its surfaces carry the whole
 * product idea, and this file reproduces them on top of a stock DSH 0.2 Web
 * UI, reading the data from the host through pwa/dsh-rpc.js:
 *
 *   连接器  Muse lists what the agent can reach: what is connected and what
 *           is merely available. DSH's equivalent is its plugin inventory:
 *           `pluginManager/listPlugins` returns every plugin of the running
 *           profile with `enabled`, the localized title and description, and
 *           the reason a row cannot be switched. Enabling one is
 *           `pluginManager/setPluginEnabled`.
 *
 *   权限    Muse asks how much the agent may do without stopping. DSH folds
 *           the same question into a permission preset: `read-only`,
 *           `workspace-write` and `danger-full-access`, where the first two
 *           keep asking on an escape and the last one stops asking at all.
 *           The catalog is `permissionPresets/catalog`, the live value is the
 *           `permissions` session projection, and the switch is the
 *           `/permission <preset>` command the official UI submits too.
 *
 *   头像    Muse floats the agent's identity over the conversation, with a
 *           dot while it works. DSH's own signal is `[data-chat-running]`;
 *           the tool that is running comes from the `session/follow` stream.
 *
 * The shell never owns the host's state: every surface reads through the
 * typed RPC and writes through the same endpoints the Web UI itself uses.
 */
;(function (root, factory) {
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else {
    root.__DSH_MUSE__ = api
    if (typeof document !== 'undefined') api.boot(root)
  }
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'

  // ---- pure helpers ------------------------------------------------------

  /**
   * The localized title of a plugin row.
   *
   * The host ships metadata as `{ en, zh }` maps. A row without metadata has
   * no display name of its own, and the module name is the honest fallback.
   */
  function pluginTitle(plugin, lang) {
    var meta = (plugin && plugin.meta) || {}
    var title = localized(meta.title, lang)
    if (title) return title
    var moduleName = (plugin && plugin.moduleName) || ''
    return moduleName.replace(/^@[^/]+\//, '')
  }

  /** The localized one-line description of a plugin row. */
  function pluginDescription(plugin, lang) {
    var meta = (plugin && plugin.meta) || {}
    return localized(meta.description, lang) || ''
  }

  /** Read one `{ en, zh }` metadata map in the page language. */
  function localized(map, lang) {
    if (!map || typeof map !== 'object') return ''
    if (typeof map === 'string') return map
    var key = lang === 'zh' ? 'zh' : 'en'
    if (typeof map[key] === 'string' && map[key] !== '') return map[key]
    if (typeof map.en === 'string' && map.en !== '') return map.en
    if (typeof map.zh === 'string' && map.zh !== '') return map.zh
    return ''
  }

  /**
   * Split the plugin list the way Muse splits its connectors: what is
   * connected, and what is only available.
   */
  function groupPlugins(plugins) {
    var connected = []
    var available = []
    var list = plugins || []
    for (var i = 0; i < list.length; i++) {
      var plugin = list[i]
      if (!plugin) continue
      if (plugin.enabled) connected.push(plugin)
      else available.push(plugin)
    }
    return { connected: connected, available: available }
  }

  /**
   * What a connector row can do.
   *
   * A row the host marked read-only cannot be switched from the UI: the host
   * owns it, and offering a switch would be a lie.
   */
  function pluginAction(plugin) {
    if (!plugin) return 'locked'
    if (plugin.readOnlyReason) return 'locked'
    if (plugin.enabled) return 'disconnect'
    return 'connect'
  }

  /** The DSH permission presets, with the wording Muse uses for them. */
  var PERMISSION_PRESETS = [
    {
      value: 'read-only',
      title: '只读',
      titleEn: 'Read only',
      description: '只能读取内容。任何写入或越界操作都会先问你。',
      descriptionEn: 'Reads only. Every write or escape is asked first.'
    },
    {
      value: 'workspace-write',
      title: '工作区可写',
      titleEn: 'Workspace write',
      description: '可以在工作区内读写，越出工作区仍然先问你。',
      descriptionEn: 'Writes inside the workspace. Leaving it still asks first.'
    },
    {
      value: 'danger-full-access',
      title: '完全访问',
      titleEn: 'Full access',
      description: '不再逐项确认，危险操作也会直接执行。',
      descriptionEn: 'No more per-action confirmation, including risky ones.'
    }
  ]

  /** The display entry of one preset value. */
  function presetEntry(value, lang) {
    for (var i = 0; i < PERMISSION_PRESETS.length; i++) {
      if (PERMISSION_PRESETS[i].value === value) return PERMISSION_PRESETS[i]
    }
    return { value: value, title: value, titleEn: value, description: '', descriptionEn: '' }
  }

  /** The title of a preset value in the page language. */
  function presetTitle(value, lang) {
    var entry = presetEntry(value, lang)
    return lang === 'zh' ? entry.title : entry.titleEn
  }

  /** The description of a preset value in the page language. */
  function presetDescription(value, lang) {
    var entry = presetEntry(value, lang)
    return lang === 'zh' ? entry.description : entry.descriptionEn
  }

  /**
   * The download URL of one produced file.
   *
   * The host serves artifacts over `GET /api/file?path=<absolute>` and
   * redirects to a versioned URL, so the plain src is already the right
   * download target: the browser follows the redirect and saves the bytes.
   */
  function artifactDownloadHref(src) {
    if (typeof src !== 'string' || src === '') return ''
    if (src.indexOf('/api/file') === 0) return src
    return ''
  }

  /**
   * Whether one element is a produced artifact the phone can save.
   *
   * Only images that the host serves through the file endpoint qualify: a
   * remote avatar or an inline data URL is not something the agent produced.
   */
  function isArtifactImage(img, doc) {
    if (!img || !img.tagName) return false
    if (String(img.tagName).toLowerCase() !== 'img') return false
    var src = img.getAttribute('src') || ''
    if (artifactDownloadHref(src) === '') return false
    var doc2 = doc || (typeof document !== 'undefined' ? document : null)
    if (!doc2) return true
    // An artifact is never a 16px avatar tile.
    var size = img.getAttribute('width') || ''
    if (size !== '' && parseInt(size, 10) > 0 && parseInt(size, 10) < 48) return false
    return true
  }

  // ---- icons -------------------------------------------------------------

  var ICON_ATTR = 'viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" ' +
    'stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"'

  var ICONS = {
    back: '<svg ' + ICON_ATTR + '><path d="M15 5l-7 7 7 7"/></svg>',
    shield: '<svg ' + ICON_ATTR + '><path d="M12 3.5 5 6.2v5.4c0 4.3 2.9 8.2 7 9.4 4.1-1.2 7-5.1 7-9.4V6.2z"/><path d="M9.2 12.1l2 2 3.6-4"/></svg>',
    grid: '<svg ' + ICON_ATTR + '><rect x="3.6" y="3.6" width="7" height="7" rx="2"/><rect x="13.4" y="3.6" width="7" height="7" rx="2"/><rect x="13.4" y="13.4" width="7" height="7" rx="2"/><rect x="3.6" y="13.4" width="7" height="7" rx="2"/></svg>',
    download: '<svg ' + ICON_ATTR + '><path d="M12 4v10"/><path d="M8 10.5l4 4 4-4"/><path d="M5 18.5h14"/></svg>',
    check: '<svg ' + ICON_ATTR + '><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    chevron: '<svg ' + ICON_ATTR + '><path d="M9.5 5.5l6.5 6.5-6.5 6.5"/></svg>',
    search: '<svg ' + ICON_ATTR + '><circle cx="11" cy="11" r="6.4"/><path d="M15.8 15.8 20 20"/></svg>'
  }

  // ---- boot --------------------------------------------------------------

  /**
   * Install the shell.
   *
   * The phone gate is the same one the rest of the plugin uses: the shell is
   * a phone surface, and a desktop browser keeps the stock DSH layout.
   */
  function boot(root) {
    if (!root || root.__DSH_MUSE_BOOTED__) return
    root.__DSH_MUSE_BOOTED__ = true

    var rpc = root.__DSH_RPC__
    if (!rpc || typeof rpc.createClient !== 'function') {
      console.warn('[dsbot] dsh-rpc.js is missing, the Muse shell stays off')
      return
    }

    var client = rpc.createClient()
    var lang = detectLang(root)
    var state = {
      client: client,
      lang: lang,
      sheet: null,
      plugins: null,
      presets: null,
      currentPreset: null,
      sessionId: null,
      follow: null,
      tool: ''
    }

    root.__DSH_MUSE__.open = function (name) { return openSheet(name) }
    root.__DSH_MUSE__.state = state

    var media = root.matchMedia('(max-width: 720px)')
    function sync() {
      if (media.matches) {
        ensurePill()
        ensureArtifactButtons()
        ensureSession()
      } else {
        closeSheet()
        hidePill()
      }
    }
    if (media.addEventListener) media.addEventListener('change', sync)
    else if (media.addListener) media.addListener(sync)

    // The host re-renders the conversation constantly; the shell has to
    // re-attach its decorations to the new nodes.
    if (typeof MutationObserver === 'function') {
      var observer = new MutationObserver(function () {
        if (!media.matches) return
        ensurePill()
        ensureArtifactButtons()
      })
      var start = function () {
        if (document.body) observer.observe(document.body, { childList: true, subtree: true })
        else setTimeout(start, 200)
      }
      start()
    }

    sync()
    watchAgentState()
    openEventStream()
  }

  /** The page language, reduced to the two the host localizes. */
  function detectLang(root) {
    var doc = root.document
    var tag = (doc && doc.documentElement && doc.documentElement.lang) || ''
    if (!tag && root.navigator) tag = root.navigator.language || ''
    return String(tag).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
  }

  // ---- session -----------------------------------------------------------

  /**
   * Resolve the session the phone is on, once.
   *
   * The host's own session list is the authority: the open conversation is
   * the one that just moved, and a session that is running right now is the
   * one the user is certainly watching.
   */
  function ensureSession() {
    var state = window.__DSH_MUSE__.state
    if (state.sessionId) return Promise.resolve(state.sessionId)
    return state.client.currentSession().then(function (sessionId) {
      state.sessionId = sessionId || null
      if (state.sessionId) startFollow(state.sessionId)
      return state.sessionId
    }).catch(function () { return null })
  }

  /**
   * Follow one session so the shell can name the tool that is running.
   *
   * The stream carries the durable session journal: `tool/call` opens a tool
   * call and `tool/result` closes it.
   */
  function startFollow(sessionId) {
    var state = window.__DSH_MUSE__.state
    if (state.follow) return
    try {
      state.follow = state.client.openStream('session/follow', {
        request: { address: { kind: 'session', sessionId: sessionId }, assistantStream: true }
      }, {
        item: function (frame) {
          if (!frame || frame.type !== 'event' || !frame.event) return
          var event = frame.event
          var type = event.type || ''
          var data = event.data || {}
          if (type === 'tool/call') {
            state.tool = data.name || ''
            paintPill()
          } else if (type === 'tool/result') {
            state.tool = ''
            paintPill()
          }
        },
        error: function () { state.follow = null }
      })
    } catch (e) {
      state.follow = null
    }
  }

  /**
   * Watch the forwarded Cordis events.
   *
   * The host pushes `plugin-manager/changed` when a plugin is switched and
   * `permission-presets/catalog-changed` when the permission catalog moves,
   * so an open sheet refreshes itself instead of showing a stale list.
   */
  function openEventStream() {
    var state = window.__DSH_MUSE__.state
    try {
      state.client.events({
        emit: function (name) {
          if (name === 'plugin-manager/changed' && state.sheet === 'connectors') {
            loadPlugins(true)
          }
          if (name === 'permission-presets/catalog-changed' && state.sheet === 'permissions') {
            loadPresets(true)
          }
        },
        waterfall: function () { /* approvals are handled by the host UI */ },
        error: function () { /* the shell stays usable without the event feed */ }
      })
    } catch (e) { /* the shell stays usable without the event feed */ }
  }

  // ---- sheet -------------------------------------------------------------

  /** Open one of the shell's pages. Returns false when it cannot. */
  function openSheet(name) {
    var state = window.__DSH_MUSE__.state
    if (!state) return false
    if (name === 'connectors') {
      showSheet('connectors', '连接器', state.lang === 'zh' ? 'Connectors' : 'Connectors')
      loadPlugins(false)
      return true
    }
    if (name === 'permissions') {
      showSheet('permissions', '权限', state.lang === 'zh' ? 'Permissions' : 'Permissions')
      loadPresets(false)
      return true
    }
    return false
  }

  /** Close the open sheet. */
  function closeSheet() {
    var state = window.__DSH_MUSE__.state
    if (!state || !state.sheet) return
    var node = document.getElementById('dsh-muse-sheet')
    if (node) node.remove()
    state.sheet = null
    state.sheetBody = null
    document.documentElement.removeAttribute('data-dsh-muse-sheet')
    document.removeEventListener('keydown', onSheetKey)
  }

  /** Build the sheet chrome: a header with a back control and a title. */
  function showSheet(name, title, titleEn) {
    var state = window.__DSH_MUSE__.state
    closeSheet()
    state.sheet = name
    document.documentElement.setAttribute('data-dsh-muse-sheet', name)

    var sheet = document.createElement('div')
    sheet.id = 'dsh-muse-sheet'
    sheet.className = 'muse-sheet'
    sheet.setAttribute('role', 'dialog')
    sheet.setAttribute('aria-modal', 'true')
    sheet.setAttribute('aria-label', state.lang === 'zh' ? title : titleEn)

    var head = document.createElement('header')
    head.className = 'muse-sheet-head'
    var back = document.createElement('button')
    back.type = 'button'
    back.className = 'muse-sheet-back'
    back.setAttribute('aria-label', '返回')
    back.innerHTML = ICONS.back
    back.addEventListener('click', closeSheet)
    var heading = document.createElement('h1')
    heading.className = 'muse-sheet-title'
    heading.textContent = state.lang === 'zh' ? title : titleEn
    head.appendChild(back)
    head.appendChild(heading)

    var body = document.createElement('div')
    body.className = 'muse-sheet-body'

    sheet.appendChild(head)
    sheet.appendChild(body)
    document.body.appendChild(sheet)

    state.sheetBody = body
    document.addEventListener('keydown', onSheetKey)
    return body
  }

  function onSheetKey(event) {
    if (event.key === 'Escape') {
      closeSheet()
      document.removeEventListener('keydown', onSheetKey)
    }
  }

  // ---- connectors --------------------------------------------------------

  /** Load the plugin inventory and paint the connector rows. */
  function loadPlugins(force) {
    var state = window.__DSH_MUSE__.state
    if (state.plugins && !force) {
      paintConnectors(state.plugins)
      return Promise.resolve(state.plugins)
    }
    return state.client.call('pluginManager', 'listPlugins', {}).then(function (plugins) {
      state.plugins = plugins || []
      paintConnectors(state.plugins)
      return state.plugins
    }).catch(function (err) {
      paintError(err)
      throw err
    })
  }

  /** Paint the connector list: what is connected, what is available. */
  function paintConnectors(plugins) {
    var state = window.__DSH_MUSE__.state
    var body = state.sheetBody
    if (!body || state.sheet !== 'connectors') return
    body.innerHTML = ''

    var groups = groupPlugins(plugins)
    var tabs = document.createElement('div')
    tabs.className = 'muse-seg'
    tabs.setAttribute('role', 'tablist')
    if (!state.connectorTab) state.connectorTab = 'available'
    var tabState = { tab: state.connectorTab }

    ;[
      { key: 'available', label: state.lang === 'zh' ? '可用' : 'Available', count: groups.available.length },
      { key: 'connected', label: state.lang === 'zh' ? '已连接' : 'Connected', count: groups.connected.length }
    ].forEach(function (tab) {
      var button = document.createElement('button')
      button.type = 'button'
      button.className = 'muse-seg-item'
      button.setAttribute('role', 'tab')
      button.setAttribute('aria-selected', tabState.tab === tab.key ? 'true' : 'false')
      button.innerHTML = '<span>' + tab.label + '</span><span class="muse-seg-count">' + tab.count + '</span>'
      button.addEventListener('click', function () {
        state.connectorTab = tab.key
        paintConnectors(state.plugins)
      })
      tabs.appendChild(button)
    })
    body.appendChild(tabs)

    var list = tabState.tab === 'connected' ? groups.connected : groups.available
    if (!list.length) {
      var empty = document.createElement('p')
      empty.className = 'muse-empty'
      empty.textContent = tabState.tab === 'connected'
        ? (state.lang === 'zh' ? '还没有已连接的插件。' : 'No plugin is connected yet.')
        : (state.lang === 'zh' ? '没有更多可用插件。' : 'No further plugin is available.')
      body.appendChild(empty)
      return
    }

    var card = document.createElement('section')
    card.className = 'muse-card'
    list.forEach(function (plugin) {
      card.appendChild(pluginRow(plugin))
    })
    body.appendChild(card)
  }

  /** One connector row: identity on the left, the one action on the right. */
  function pluginRow(plugin) {
    var state = window.__DSH_MUSE__.state
    var row = document.createElement('div')
    row.className = 'muse-row'

    var mark = document.createElement('span')
    mark.className = 'muse-row-mark'
    mark.setAttribute('aria-hidden', 'true')
    mark.textContent = (pluginTitle(plugin, state.lang) || '?').slice(0, 1).toUpperCase()

    var text = document.createElement('div')
    text.className = 'muse-row-text'
    var title = document.createElement('div')
    title.className = 'muse-row-title'
    title.textContent = pluginTitle(plugin, state.lang)
    text.appendChild(title)
    var description = pluginDescription(plugin, state.lang)
    if (description) {
      var sub = document.createElement('div')
      sub.className = 'muse-row-sub'
      sub.textContent = description
      text.appendChild(sub)
    }

    var action = document.createElement('button')
    action.type = 'button'
    var kind = pluginAction(plugin)
    if (kind === 'locked') {
      action.className = 'muse-row-action is-locked'
      action.textContent = state.lang === 'zh' ? '由宿主管理' : 'Host managed'
      action.disabled = true
    } else {
      action.className = 'muse-row-action'
      action.textContent = kind === 'connect'
        ? (state.lang === 'zh' ? '连接' : 'Connect')
        : (state.lang === 'zh' ? '断开' : 'Disconnect')
      action.addEventListener('click', function () {
        action.disabled = true
        action.textContent = state.lang === 'zh' ? '处理中…' : 'Working…'
        togglePlugin(plugin, kind === 'connect')
      })
    }

    row.appendChild(mark)
    row.appendChild(text)
    row.appendChild(action)
    return row
  }

  /** Switch one plugin and refresh the list from the host's own answer. */
  function togglePlugin(plugin, enable) {
    var state = window.__DSH_MUSE__.state
    return state.client.call('pluginManager', 'setPluginEnabled', {
      id: plugin.entryId,
      enabled: enable
    }).then(function () {
      return loadPlugins(true)
    }).catch(function (err) {
      paintError(err)
      return loadPlugins(true)
    })
  }

  // ---- permissions -------------------------------------------------------

  /** Load the permission catalog and the live value, then paint them. */
  function loadPresets(force) {
    var state = window.__DSH_MUSE__.state
    if (state.presets && !force) {
      paintPermissions(state.presets, state.currentPreset)
      return Promise.resolve(state.presets)
    }
    return state.client.call('permissionPresets', 'catalog', {}).then(function (catalog) {
      state.presets = catalog && catalog.options ? catalog.options : []
      return ensureSession().then(function () {
        return readCurrentPreset()
      }).then(function (current) {
        state.currentPreset = current
        paintPermissions(state.presets, current)
        return state.presets
      })
    }).catch(function (err) {
      paintError(err)
      throw err
    })
  }

  /** Read the permission value of the session the phone is on. */
  function readCurrentPreset() {
    var state = window.__DSH_MUSE__.state
    if (!state.sessionId) return Promise.resolve(null)
    return state.client.call('session', 'projections', {
      request: { sessionId: state.sessionId }
    }).then(function (value) {
      var values = value && value.values ? value.values : null
      if (!values) return null
      var permissions = values.permissions
      return permissions && permissions.currentValue ? permissions.currentValue : null
    }).catch(function () { return null })
  }

  /** Paint the permission page: one card, one row per preset. */
  function paintPermissions(options, current) {
    var state = window.__DSH_MUSE__.state
    var body = state.sheetBody
    if (!body || state.sheet !== 'permissions') return
    body.innerHTML = ''

    var label = document.createElement('p')
    label.className = 'muse-section-label'
    label.textContent = state.lang === 'zh' ? '智能体权限' : 'Agent permissions'
    body.appendChild(label)

    var card = document.createElement('section')
    card.className = 'muse-card'
    options.forEach(function (option) {
      card.appendChild(presetRow(option.value, current))
    })
    body.appendChild(card)

    var note = document.createElement('p')
    note.className = 'muse-note'
    note.textContent = state.lang === 'zh'
      ? '切换后立即对当前会话生效，越权操作仍会单独询问。'
      : 'Takes effect on the current session at once; escapes are still asked about.'
    body.appendChild(note)
  }

  /** One permission row: the preset on the left, a check on the current one. */
  function presetRow(value, current) {
    var state = window.__DSH_MUSE__.state
    var row = document.createElement('div')
    row.className = 'muse-row muse-row-select'
    if (value === current) row.className += ' is-current'

    var text = document.createElement('div')
    text.className = 'muse-row-text'
    var title = document.createElement('div')
    title.className = 'muse-row-title'
    title.textContent = presetTitle(value, state.lang)
    text.appendChild(title)
    var description = presetDescription(value, state.lang)
    if (description) {
      var sub = document.createElement('div')
      sub.className = 'muse-row-sub'
      sub.textContent = description
      text.appendChild(sub)
    }

    if (value === current) {
      var mark = document.createElement('span')
      mark.className = 'muse-row-check'
      mark.setAttribute('aria-label', state.lang === 'zh' ? '当前' : 'Current')
      mark.innerHTML = ICONS.check
      row.appendChild(text)
      row.appendChild(mark)
      return row
    }

    var action = document.createElement('button')
    action.type = 'button'
    action.className = 'muse-row-action'
    action.textContent = state.lang === 'zh' ? '启用' : 'Enable'
    action.addEventListener('click', function () {
      action.disabled = true
      applyPreset(value)
    })
    row.appendChild(text)
    row.appendChild(action)
    return row
  }

  /**
   * Switch the permission preset of the open session.
   *
   * The write path is the `/permission <preset>` command: the official Web UI
   * popup submits the very same line, and the host folds it into the
   * `permission/preset`, `sandbox/mode` and `approval/policy` knobs.
   */
  function applyPreset(value) {
    var state = window.__DSH_MUSE__.state
    return ensureSession().then(function (sessionId) {
      if (!sessionId) throw new Error('dsh: no session to apply the permission to')
      return state.client.call('session', 'prompt', {
        request: {
          requestId: rpcUuid(),
          sessionId: sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: '/permission ' + value }]
        }
      })
    }).then(function () {
      state.currentPreset = value
      paintPermissions(state.presets, value)
      return value
    }).catch(function (err) {
      paintError(err)
      throw err
    })
  }

  /** A request id for one prompt. */
  function rpcUuid() {
    var rpc = (typeof window !== 'undefined' && window.__DSH_RPC__) || null
    if (rpc && typeof rpc.uuid === 'function') return rpc.uuid()
    return 'muse-' + Date.now().toString(36)
  }

  // ---- the floating agent ------------------------------------------------

  /**
   * The floating agent pill.
   *
   * Muse floats the agent's identity over the conversation with a dot while
   * it works. The pill carries the same three states: idle, working, and
   * working on a named tool.
   */
  function ensurePill() {
    if (document.getElementById('dsh-muse-pill')) return
    var pill = document.createElement('button')
    pill.id = 'dsh-muse-pill'
    pill.type = 'button'
    pill.className = 'muse-pill'
    pill.setAttribute('aria-label', '智能体')
    var dot = document.createElement('span')
    dot.className = 'muse-pill-dot'
    var name = document.createElement('span')
    name.className = 'muse-pill-name'
    name.textContent = 'DSB'
    var tool = document.createElement('span')
    tool.className = 'muse-pill-tool'
    pill.appendChild(dot)
    pill.appendChild(name)
    pill.appendChild(tool)
    pill.addEventListener('click', scrollToActiveTurn)
    document.body.appendChild(pill)
    paintPill()
  }

  /** Paint the pill against the live agent state. */
  function paintPill() {
    var state = window.__DSH_MUSE__.state
    var pill = document.getElementById('dsh-muse-pill')
    if (!pill || !state) return
    var running = agentRunning()
    pill.classList.toggle('is-running', running)
    var tool = state.tool || ''
    pill.classList.toggle('has-tool', running && tool !== '')
    var toolNode = pill.querySelector('.muse-pill-tool')
    if (toolNode) toolNode.textContent = tool
  }

  /** Whether the host is working right now. */
  function agentRunning() {
    return !!document.querySelector('[data-chat-running]')
  }

  /** Follow the agent state and repaint the pill when it changes. */
  function watchAgentState() {
    if (typeof MutationObserver !== 'function') return
    var observer = new MutationObserver(function () { paintPill() })
    var start = function () {
      if (document.body) {
        observer.observe(document.body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['data-chat-running', 'data-streaming']
        })
      } else setTimeout(start, 200)
    }
    start()
  }

  /** Jump to the turn the agent is working on. */
  function scrollToActiveTurn() {
    var running = document.querySelector('[data-chat-running]')
    var target = running && running.closest('[data-chat-node-key]')
    if (!target) {
      var flow = document.querySelector('[data-slot="conversation.chat.flow"]')
      if (flow) flow.scrollIntoView({ block: 'end', behavior: 'smooth' })
      return
    }
    try {
      target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    } catch (e) {
      target.scrollIntoView()
    }
  }

  // ---- artifacts ---------------------------------------------------------

  /**
   * Put a save button on every artifact the agent produced.
   *
   * Muse puts a download control under a generated image. The host serves
   * artifacts over `/api/file`, so the button is a link to that URL: the
   * browser follows the redirect and saves the bytes.
   */
  function ensureArtifactButtons() {
    var flow = document.querySelector('[data-slot="conversation.chat.flow"]')
    if (!flow) return
    var images = flow.querySelectorAll('img')
    for (var i = 0; i < images.length; i++) {
      var img = images[i]
      if (!isArtifactImage(img, document)) continue
      if (img.getAttribute('data-muse-dl')) continue
      img.setAttribute('data-muse-dl', '1')
      var wrap = document.createElement('span')
      wrap.className = 'muse-artifact'
      img.parentNode.insertBefore(wrap, img)
      wrap.appendChild(img)
      var link = document.createElement('a')
      link.className = 'muse-artifact-dl'
      link.href = artifactDownloadHref(img.getAttribute('src'))
      link.setAttribute('download', '')
      link.setAttribute('aria-label', '下载')
      link.innerHTML = ICONS.download
      wrap.appendChild(link)
    }
  }

  // ---- errors ------------------------------------------------------------

  /** Show a failure in the open sheet instead of an empty page. */
  function paintError(err) {
    var state = window.__DSH_MUSE__.state
    var body = state.sheetBody
    if (!body) return
    var box = document.createElement('p')
    box.className = 'muse-error'
    box.textContent = state.lang === 'zh'
      ? '读取失败：' + (err && err.message ? err.message : String(err))
      : 'Could not load: ' + (err && err.message ? err.message : String(err))
    body.appendChild(box)
  }

  return {
    PERMISSION_PRESETS: PERMISSION_PRESETS,
    pluginTitle: pluginTitle,
    pluginDescription: pluginDescription,
    localized: localized,
    groupPlugins: groupPlugins,
    pluginAction: pluginAction,
    presetEntry: presetEntry,
    presetTitle: presetTitle,
    presetDescription: presetDescription,
    artifactDownloadHref: artifactDownloadHref,
    isArtifactImage: isArtifactImage,
    boot: boot
  }
})
