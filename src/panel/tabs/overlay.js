// ─── Debug overlay: visibility + live state readouts ──────────────────────
// Needs `controls` (built by initSimControls, which runs first) for
// `controls.attention()`.
import { NOISE_SPEED_MAX } from '../../dynamics/dynamics.js'

export function initDebugOverlay(ctx) {
  const { debugEl, flyCamera, dynamics, water, controls, onFrame } = ctx
  document.getElementById('toggle-debug').addEventListener('click', () => debugEl.classList.toggle('visible'))
  window.addEventListener('keydown', e => {
    // While flying, D strafes right — don't also toggle the debug panel.
    if (flyCamera && flyCamera.params.get('enabled')) return
    if (e.key === 'd' || e.key === 'D') debugEl.classList.toggle('visible')
  })

  const setBar = (id, fraction) => {
    document.querySelector(`#${id} .dbg-bar-fill`).style.width = `${Math.round(fraction * 100)}%`
  }

  // Read every frame rather than from the tick ('tick' stops while frozen) or
  // from freeze/unfreeze events (a hand-switched painting holds silently).
  const frozenEl = document.getElementById('val-frozen')
  onFrame(() => {
    frozenEl.textContent = !dynamics.isFrozen() ? 'no' : dynamics.isHeld() ? 'held' : 'yes'
  })
  dynamics.addEventListener('tick', e => {
    if (!debugEl.classList.contains('visible')) return
    const { momentum, restlessness, noiseTime } = e.detail
    const noiseSpeed = dynamics.noiseSpeed

    setBar('bar-momentum',      momentum)
    setBar('bar-restlessness',  restlessness)
    setBar('bar-noisespeed',    noiseSpeed / NOISE_SPEED_MAX)

    document.getElementById('val-momentum').textContent      = momentum.toFixed(2)
    document.getElementById('val-restlessness').textContent  = restlessness.toFixed(2)
    document.getElementById('val-noisespeed').textContent    = noiseSpeed.toFixed(3)
    document.getElementById('val-noisetime').textContent     = noiseTime.toFixed(1)
    // Whichever source main.js is actually feeding dynamics.update() —
    // the slider in Manual mode, the mic-derived value in Mic mode.
    document.getElementById('val-attention').textContent  = controls.attention().toFixed(2)
    document.getElementById('val-sealevel').textContent   = water.getSeaLevel().toFixed(1)

    document.getElementById('bar-restlessness').classList.toggle('low', restlessness < 0.25)
  })
}
