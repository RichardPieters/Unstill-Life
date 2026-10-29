// ─── Fullscreen and the control bar: the painting alone on the screen ──────
// The Fullscreen button in the control bar, or a double-click on the painting,
// makes the whole page fill the screen; Esc (the browser's own key) leaves.
// The window resize that follows refits the canvas and the camera (main.js resizeCanvas).
//
// The control bar hides in a window and in fullscreen alike: `body.ui-reveal`
// shows it while the pointer is within REVEAL_ZONE_PX of the bottom edge, where
// the bar sits, and takes it away when the pointer moves up or leaves the
// window. While the debug panel is open the bar stays shown (style.css). A drag
// that started on the bar (the attention slider) keeps it shown until the
// button is released. On a touch screen a tap near the bottom edge shows it and
// a tap elsewhere hides it.
//
// While fullscreen, `idle` on <html> also hides the cursor after IDLE_MS
// without movement. It sits on <html>, not <body>: body has no height, so the
// pointer is over <html> almost everywhere. Entering closes the debug panel; D
// still opens it.
//
// Browsers without element fullscreen (iPhone Safari) get no button, but the
// bar still hides.

const REVEAL_ZONE_PX = 120
const IDLE_MS = 2000

/** True when a pointer at `y` is close enough to the bottom edge to show the bar. */
export function inRevealZone(y, viewportHeight) {
  return y >= viewportHeight - REVEAL_ZONE_PX
}

export function initFullscreen({ debugEl }) {
  initBarAutoHide()

  const button = document.getElementById('fullscreen')
  if (!document.fullscreenEnabled) { button.remove(); return }

  const body = document.body
  const root = document.documentElement
  const uiEl = document.getElementById('ui')
  const isFullscreen = () => document.fullscreenElement !== null
  const toggle = () => {
    if (isFullscreen()) document.exitFullscreen()
    else document.documentElement.requestFullscreen().catch(() => {})
  }

  button.addEventListener('click', toggle)
  document.addEventListener('dblclick', e => {
    if (uiEl.contains(e.target) || debugEl.contains(e.target)) return
    toggle()
  })

  let idleTimer = 0
  const wake = () => {
    root.classList.remove('idle')
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => root.classList.add('idle'), IDLE_MS)
  }

  document.addEventListener('fullscreenchange', () => {
    const on = isFullscreen()
    body.classList.toggle('fullscreen', on)
    body.classList.remove('ui-reveal')
    button.textContent = on ? 'Exit fullscreen' : 'Fullscreen'
    if (on) { debugEl.classList.remove('visible'); wake() }
    else { clearTimeout(idleTimer); root.classList.remove('idle') }
  })

  window.addEventListener('pointermove', () => { if (isFullscreen()) wake() })
}

/** Show the control bar only while the pointer is near the bottom edge. */
function initBarAutoHide() {
  const body = document.body
  const reveal = on => body.classList.toggle('ui-reveal', on)
  const follow = e => {
    // A drag on the bar's slider may wander above the zone; the bar stays
    // until the button is released.
    if (e.buttons && body.classList.contains('ui-reveal')) return
    reveal(inRevealZone(e.clientY, window.innerHeight))
  }
  window.addEventListener('pointermove', follow)
  window.addEventListener('pointerdown', follow)
  window.addEventListener('pointerup', follow)
  document.documentElement.addEventListener('pointerleave', () => reveal(false))
}
