/* dsbot · DSH 0.2 typed-RPC client
 *
 * DSH 0.2 has no REST GET surface. The Web UI reaches the host over a typed
 * RPC envelope: unary calls are HTTP POST /api/<namespace>/<method>, and every
 * stream rides one multiplexed WebSocket at /api/remote.mux.
 *
 * The wire shapes below were read out of the upstream source and then
 * confirmed against a live 0.2 host (a wrong payload wrapper is answered with
 * "Remote payload must contain exactly one plain-object args field", so the
 * `args` wrapper is not decoration):
 *
 *   request   { type: 'client-request', rpcId, method: '<ns>/<method>',
 *               payload: { args: { ... } } }
 *   response  { type: 'server-response', rpcId, result: { ok: true, value } }
 *             | { type: 'server-response', rpcId, result: { ok: false, error } }
 *   stream    client -> { type: 'open', streamId, endpoint, payload: { args } }
 *             host   -> { type: 'item', streamId, value }
 *                      | { type: 'error', streamId, error }
 *                      | { type: 'end', streamId }
 *
 * The module is written so it can be loaded as a plain browser script and
 * required from a node test at the same time: the browser gets
 * `window.__DSH_RPC__`, the test gets the module exports.
 */
;(function (root, factory) {
  var api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.__DSH_RPC__ = api
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict'

  // ---- constants ---------------------------------------------------------

  var API_PREFIX = '/api'
  var STREAM_PATH = '/api/remote.mux'
  // The gateway's own logical stream for forwarded Cordis events.
  var EVENTS_ENDPOINT = '$events'
  // The endpoint a Client answers a forwarded-event waterfall on.
  var EVENTS_RESULT_ENDPOINT = '$events/result'

  // ---- ids ---------------------------------------------------------------

  // crypto.randomUUID is missing on older mobile Safari and on plain http
  // origins, and this shell has to run on both.
  function uuid() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID()
      }
      if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
        var b = new Uint8Array(16)
        crypto.getRandomValues(b)
        b[6] = (b[6] & 15) | 64
        b[8] = (b[8] & 63) | 128
        var h = ''
        for (var i = 0; i < 16; i++) {
          if (i === 4 || i === 6 || i === 8 || i === 10) h += '-'
          var v = b[i].toString(16)
          h += v.length === 1 ? '0' + v : v
        }
        return h
      }
    } catch (e) { /* fall through */ }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0
      var v = c === 'x' ? r : ((r & 0x3) | 0x8)
      return v.toString(16)
    })
  }

  var streamSeq = 0
  function streamId() {
    streamSeq += 1
    return 'lan-' + Date.now().toString(36) + '-' + streamSeq.toString(36)
  }

  // ---- pure wire helpers ------------------------------------------------

  /** The unary request envelope for one namespace method. */
  function buildRequest(ns, method, args, rpcId) {
    return {
      type: 'client-request',
      rpcId: rpcId || uuid(),
      method: ns + '/' + method,
      payload: { args: args || {} }
    }
  }

  /** The envelope that answers one forwarded-event waterfall. */
  function buildEventResult(clientId, eventId, outcome) {
    return { clientId: clientId, eventId: eventId, outcome: outcome }
  }

  /** The HTTP path of one namespace method. */
  function apiUrl(ns, method) {
    return API_PREFIX + '/' + ns + '/' + method
  }

  /** The WebSocket URL of the multiplexed stream carrier. */
  function streamUrl(baseUrl) {
    var base = baseUrl || (typeof document !== 'undefined' ? document.baseURI : 'http://localhost/')
    var url = new URL(STREAM_PATH.slice(1), base)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.href
  }

  /**
   * Turn one host response envelope into its value.
   * Throws when the envelope is not ours, when the rpcId does not match the
   * request, or when the host reported a Remote error.
   */
  function parseResponse(envelope, rpcId) {
    if (!envelope || envelope.type !== 'server-response') {
      throw new Error('dsh: malformed response envelope')
    }
    if (rpcId && envelope.rpcId !== rpcId) {
      throw new Error('dsh: rpcId mismatch')
    }
    var result = envelope.result
    if (!result || typeof result !== 'object') throw new Error('dsh: missing result')
    if (result.ok === true) return result.value
    var error = result.error || {}
    var failure = new Error(error.message || 'dsh: remote call failed')
    failure.code = error.code || 'gateway/internal'
    failure.details = error.details || {}
    throw failure
  }

  /** Parse one carrier frame; returns null for anything that is not a frame. */
  function parseFrame(text) {
    try {
      var value = JSON.parse(text)
      if (!value || typeof value !== 'object') return null
      return value
    } catch (e) {
      return null
    }
  }

  /**
   * The frame that opens one logical stream on the carrier.
   * The args are wrapped the same way a unary call wraps them.
   */
  function buildOpen(streamIdValue, endpoint, args) {
    return {
      type: 'open',
      streamId: streamIdValue,
      endpoint: endpoint,
      payload: { args: args || {} }
    }
  }

  /** The frame that cancels one logical stream. */
  function buildCancel(streamIdValue) {
    return { type: 'cancel', streamId: streamIdValue }
  }

  // ---- session resolution -----------------------------------------------

  /**
   * Pull a session id out of a location string.
   *
   * The Web UI keeps the open conversation in client state rather than in the
   * URL, so this is a best-effort first guess and not the only source: the
   * authoritative answer is the host's own session list.
   */
  function sessionIdFromLocation(href) {
    if (typeof href !== 'string' || href === '') return undefined
    var hash = href.indexOf('#')
    var tail = hash >= 0 ? href.slice(hash + 1) : href
    // The id may sit behind a keyword ("session", "sess", "sid"), separated by
    // a dash, an underscore or an equals sign, and then by a path slash.
    var match = tail.match(/(?:^|[?&/=])(?:session|sess|sid)[-_=]?(?:\/)?([A-Za-z0-9_-]{6,})/)
    if (match) return match[1]
    // A bare id in the hash path is also a session route.
    var path = tail.replace(/^\/+/, '').split(/[?&]/)[0]
    if (/^[A-Za-z0-9_-]{8,}$/.test(path)) return path
    return undefined
  }

  /**
   * Pick the session the phone is most likely looking at.
   *
   * `running` is the strongest signal: a session that is executing right now
   * is the one the user is watching. Otherwise the most recently updated
   * session wins, because the open conversation is the one that just moved.
   */
  function pickSession(summaries, runningFirst) {
    if (!summaries || !summaries.length) return undefined
    var list = summaries.slice()
    if (runningFirst !== false) {
      var running = list.filter(function (s) { return s && s.running })
      if (running.length) {
        return running.sort(byUpdatedAt)[0]
      }
    }
    return list.sort(byUpdatedAt)[0]
  }

  function byUpdatedAt(a, b) {
    var av = a && typeof a.updatedAt === 'number' ? a.updatedAt : 0
    var bv = b && typeof b.updatedAt === 'number' ? b.updatedAt : 0
    if (bv !== av) return bv - av
    return String((a && a.sessionId) || '').localeCompare(String((b && b.sessionId) || ''))
  }

  // ---- client ------------------------------------------------------------

  /**
   * Build a client bound to a fetch and a WebSocket constructor.
   * Both are injectable so the behaviour can be exercised without a browser.
   */
  function createClient(options) {
    var opts = options || {}
    var doFetch = opts.fetch || (typeof fetch === 'function' ? fetch.bind(globalThis) : null)
    var Socket = opts.WebSocket || (typeof WebSocket !== 'undefined' ? WebSocket : null)
    var baseUrl = opts.baseUrl
    // The carrier address can be pinned: in production it is the public
    // authority the page was served from, and the gateway relays it to the
    // host with the browser-facing Host intact.
    var carrierUrl = opts.streamUrl || null

    if (!doFetch) throw new Error('dsh: no fetch available')

    /** One unary call. Resolves with the Remote value, rejects with the Remote error. */
    function call(ns, method, args) {
      var request = buildRequest(ns, method, args)
      return doFetch(apiUrl(ns, method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request)
      }).then(function (response) {
        if (!response.ok) {
          // The host's own explanation is worth more than the status code:
          // a wrong argument wrapper answers 400 with a precise message.
          return (typeof response.text === 'function' ? response.text() : Promise.resolve(''))
            .then(function (body) {
              throw new Error('dsh: transport failure for ' + ns + '/' + method +
                ': HTTP ' + response.status + (body ? ' · ' + body.slice(0, 200) : ''))
            })
        }
        return response.json()
      }).then(function (envelope) {
        return parseResponse(envelope, request.rpcId)
      })
    }

    /**
     * Open one logical stream on the multiplexed carrier.
     *
     * The carrier is shared: one socket carries every stream this client
     * opens, and frames are routed back by their streamId. The args are the
     * method's own arguments, wrapped by the carrier the same way a unary
     * call wraps them.
     */
    function openStream(endpoint, args, handlers) {
      if (!Socket) return Promise.reject(new Error('dsh: no WebSocket available'))
      var onEvent = handlers || {}
      var id = streamId()
      var socket = new Socket(carrierUrl || streamUrl(baseUrl))
      var closed = false

      var ready = new Promise(function (resolve, reject) {
        socket.addEventListener('open', function () {
          socket.send(JSON.stringify(buildOpen(id, endpoint, args)))
          resolve()
        })
        socket.addEventListener('error', function () {
          if (!closed) reject(new Error('dsh: stream carrier failed'))
        })
        socket.addEventListener('close', function () {
          closed = true
          if (onEvent.close) onEvent.close()
        })
        socket.addEventListener('message', function (event) {
          var frame = parseFrame(event.data)
          if (!frame || frame.streamId !== id) return
          if (frame.type === 'item') {
            if (onEvent.item) onEvent.item(frame.value)
          } else if (frame.type === 'error') {
            var failure = new Error((frame.error && frame.error.message) || 'dsh: stream error')
            failure.code = frame.error && frame.error.code
            if (onEvent.error) onEvent.error(failure)
            else reject(failure)
          } else if (frame.type === 'end') {
            closed = true
            if (onEvent.end) onEvent.end()
          }
        })
      })

      return {
        id: id,
        socket: socket,
        ready: ready,
        close: function () {
          if (closed) return
          closed = true
          try { socket.send(JSON.stringify(buildCancel(id))) } catch (e) { /* ignore */ }
          try { socket.close() } catch (e) { /* ignore */ }
        }
      }
    }

    /**
     * Subscribe to the forwarded Cordis events.
     *
     * The gateway opens this stream with an empty args payload and then pushes
     * `ready`, `emit`, `waterfall` and `cancel` frames.
     */
    function events(handlers) {
      var onEvent = handlers || {}
      return openStream(EVENTS_ENDPOINT, {}, {
        item: function (frame) {
          if (!frame || typeof frame !== 'object') return
          if (frame.type === 'ready') {
            if (onEvent.ready) onEvent.ready(frame)
          } else if (frame.type === 'emit') {
            if (onEvent.emit) onEvent.emit(frame.event, frame.args || [])
          } else if (frame.type === 'waterfall') {
            if (onEvent.waterfall) onEvent.waterfall(frame)
          } else if (frame.type === 'cancel') {
            if (onEvent.cancel) onEvent.cancel(frame.eventId)
          }
        },
        error: onEvent.error,
        end: onEvent.end,
        close: onEvent.close
      })
    }

    /** Answer one forwarded-event waterfall. */
    function answerEvent(clientId, eventId, outcome) {
      return call('$events', 'result', buildEventResult(clientId, eventId, outcome))
    }

    /**
     * Resolve the session the phone is on.
     * The host's own list is the authority; the URL is only a fast guess.
     */
    function currentSession() {
      var fromUrl = sessionIdFromLocation(typeof location !== 'undefined' ? location.href : '')
      var listed = call('session', 'list', { _request: {} }).catch(function () { return undefined })
      return listed.then(function (value) {
        var summaries = value && Array.isArray(value.items) ? value.items : []
        var picked = pickSession(summaries)
        if (picked && picked.sessionId) return picked.sessionId
        return fromUrl
      })
    }

    return {
      call: call,
      openStream: openStream,
      events: events,
      answerEvent: answerEvent,
      currentSession: currentSession,
      apiUrl: apiUrl,
      streamUrl: streamUrl
    }
  }

  return {
    API_PREFIX: API_PREFIX,
    STREAM_PATH: STREAM_PATH,
    EVENTS_ENDPOINT: EVENTS_ENDPOINT,
    EVENTS_RESULT_ENDPOINT: EVENTS_RESULT_ENDPOINT,
    uuid: uuid,
    buildRequest: buildRequest,
    buildEventResult: buildEventResult,
    buildOpen: buildOpen,
    buildCancel: buildCancel,
    apiUrl: apiUrl,
    streamUrl: streamUrl,
    parseResponse: parseResponse,
    parseFrame: parseFrame,
    sessionIdFromLocation: sessionIdFromLocation,
    pickSession: pickSession,
    createClient: createClient
  }
})
