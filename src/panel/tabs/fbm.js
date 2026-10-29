// ─── fBM debug: live drift readouts ───────────────────────────────────────
// The tab's toggles and sliders are terrain param rows, bound in
// debugPanel.js's initParamRows; this adds the readouts of what the drift
// driver is doing right now.
export function initFbm(ctx) {
  const { debugEl, terrain, dynamics } = ctx
  // Each tick, only while the panel is visible.
  dynamics.addEventListener('tick', () => {
    if (!debugEl.classList.contains('visible')) return
    const deg = a => ((a % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) * 180 / Math.PI).toFixed(1) + '°'
    for (const inst of [0, 1]) {
      const v = terrain.getDriftVelocity(inst)
      document.getElementById(`f${inst}-dx-cur`).textContent    = v.x.toFixed(2)
      document.getElementById(`f${inst}-dz-cur`).textContent    = v.z.toFixed(2)
      document.getElementById(`f${inst}-angle-cur`).textContent = deg(terrain.getDriftAngle(inst))
    }
  })
}
