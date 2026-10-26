/* dsbot · touch gestures
 * Touch-first gestures for the DSH Web UI on phones:
 *   - Pull-to-refresh on the conversation view
 *   - Edge-swipe back navigation
 *   - Pinch to resize code / markdown font size
 *
 * Loaded only on `html[data-lan-device="phone"]` via the injected PWA script.
 * Keeps out of the way on desktop.
 */
(function () {
  'use strict'
  if (window.matchMedia('(pointer: coarse)').matches === false) return

  // ---- Pull to refresh ------------------------------------------------
  const PULL_THRESHOLD = 96 // px
  let pullStartY = null
  let pulling = false
  const indicator = document.createElement('div')
  indicator.id = 'dsh-pwa-pull'
  const holder = document.createElement('div')
  holder.style.cssText =
    'position:fixed;inset-inline:0;top:0;z-index:2147483000;' +
    'display:flex;align-items:center;justify-content:center;height:0;overflow:hidden;' +
    'background:rgba(15,17,21,.85);color:#9cc0ff;font:600 13px/1 system-ui,sans-serif;' +
    'border-bottom:1px solid #2a2f3a;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)'
  indicator.appendChild(holder)
  document.documentElement.appendChild(indicator)

  function setPull(px) {
    const h = Math.min(px, PULL_THRESHOLD + 24)
    holder.style.height = h + 'px'
    holder.style.opacity = px >= PULL_THRESHOLD ? '1' : String(px / PULL_THRESHOLD)
    holder.textContent = px >= PULL_THRESHOLD ? '松开刷新' : '下拉刷新'
  }
  function clearPull() {
    holder.style.height = '0px'
    holder.style.opacity = '0'
  }

  document.addEventListener('touchstart', (e) => {
    if (window.scrollY <= 0) pullStartY = e.touches[0].clientY
  }, { passive: true })

  document.addEventListener('touchmove', (e) => {
    if (pullStartY == null) return
    const dy = e.touches[0].clientY - pullStartY
    if (dy > 0 && window.scrollY <= 0) {
      pulling = true
      setPull(dy)
    }
  }, { passive: true })

  document.addEventListener('touchend', () => {
    const wasPulling = pulling
    pullStartY = null
    pulling = false
    clearPull()
    if (wasPulling) window.location.reload()
  }, { passive: true })

  // ---- Edge-swipe back (history.back) --------------------------------
  const EDGE = 24
  let swipeState = null
  const edge = document.createElement('div')
  edge.style.cssText =
    'position:fixed;left:0;top:0;bottom:0;width:' + EDGE + 'px;z-index:2147483001;' +
    'background:transparent;touch-action:none'
  document.documentElement.appendChild(edge)

  edge.addEventListener('touchstart', (e) => {
    swipeState = { x: e.touches[0].clientX, y: e.touches[0].clientY }
  }, { passive: true })

  edge.addEventListener('touchmove', (e) => {
    if (!swipeState) return
    e.preventDefault()
  }, { passive: false })

  edge.addEventListener('touchend', (e) => {
    if (!swipeState) return
    const dx = e.changedTouches[0].clientX - swipeState.x
    const dy = e.changedTouches[0].clientY - swipeState.y
    const traveledRight = dx > 90 && Math.abs(dy) < dx * 0.5
    swipeState = null
    if (traveledRight) { try { window.history.back() } catch (err) { /* ignore */ } }
  }, { passive: true })

  // ---- Pinch to resize font -------------------------------------------
  const FONT_KEY = 'dsh-pwa-fontscale'
  const SPACES = [10, 11, 12, 13, 14, 15, 16, 17, 18]
  const root = document.documentElement
  let baseScale = parseFloat(localStorage.getItem(FONT_KEY)) || 1
  applyFont(baseScale)

  let pinchStartDist = null
  let pinchStartScale = baseScale
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      pinchStartDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      )
      pinchStartScale = baseScale
    }
  }, { passive: true })

  document.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || pinchStartDist == null) return
    e.preventDefault()
    const d = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    )
    const ratio = d / pinchStartDist
    const candidates = SPACES.map((s) => s * 0.1 * ratio)
    const next = Math.min(1.8, Math.max(0.9, pinchStartScale * ratio))
    // Snap to nearest discrete step to avoid jitter.
    const snapped = snapTo(next)
    if (snapped !== baseScale) {
      baseScale = snapped
      applyFont(baseScale)
      localStorage.setItem(FONT_KEY, String(baseScale))
    }
  }, { passive: false })

  function snapTo(v) {
    const sorted = [...SPACES].sort((a, b) => Math.abs(a - v * 10) - Math.abs(b - v * 10))
    return sorted[0] / 10
  }

  document.addEventListener('touchend', () => { pinchStartDist = null }, { passive: true })

  function applyFont(scale) {
    root.style.setProperty('--dsh-pwa-font-scale', String(scale))
  }

  // Add a small floating reset button when scale != 1.
  if (baseScale !== 1) {
    const reset = document.createElement('button')
    reset.textContent = '字AA'
    reset.style.cssText =
      'position:fixed;right:max(10px,env(safe-area-inset-right));' +
      'bottom:max(110px,calc(env(safe-area-inset-bottom) + 110px));z-index:2147483002;' +
      'background:rgba(76,141,255,.92);color:#fff;border:0;border-radius:999px;' +
      'padding:8px 12px;font:600 12px/1 system-ui;box-shadow:0 6px 20px rgba(0,0,0,.4)'
    reset.addEventListener('click', () => {
      baseScale = 1
      applyFont(1)
      localStorage.setItem(FONT_KEY, '1')
      reset.remove()
    })
    document.body.appendChild(reset)
  }
})()
